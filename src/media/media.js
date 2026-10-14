import { SerialQueue } from "../signaling/queue.js";
import { StableStreams } from "./stable-stream.js";
import { randomId } from "../util/ids.js";

/**
 * A published local track (plan section 3). `replaceTrack` swaps the track on every sender
 * without renegotiation (doc §6).
 */
export class RalPublication {
  #media;

  constructor(media, track, { tag = track.kind, to = "all" } = {}) {
    this.#media = media;
    this.id = randomId(8);
    this.track = track;
    this.kind = track.kind;
    this.tag = tag;
    this.to = to === "all" ? "all" : new Set(to);
    this.closed = false;
  }

  /** True when the publication targets `peerId`. */
  targets(peerId) {
    return this.to === "all" || this.to.has(peerId);
  }

  /**
   * Replaces the published track on every sender.
   * @param {MediaStreamTrack} track
   */
  async replaceTrack(track) {
    if (track && track.kind !== this.kind) throw new TypeError(`expected a ${this.kind} track`);
    this.track = track;
    await this.#media.replaceSource(`self:${this.id}`, track);
  }

  /** Stops publishing. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.#media.unpublish(this);
  }
}

/**
 * Media over direct connections (plan section 10). For each direct connection the group's media
 * plan lists the sources it must carry (own publications and, on a relay, forwarded tracks); this
 * class keeps the direct connection's send slots, `mid-map` announcements and encoding activity in
 * line with that plan.
 *
 * Receiving: `mid-map` from a neighbor maps its transceiver mids to origin and publication; the
 * received tracks feed the stable streams.
 */
export class MediaManager {
  /** @type {Map<string, RalPublication>} */
  pubs = new Map();
  /** neighbor id -> Map<source key, {slot, info, active}> */
  #sending = new Map();
  /** neighbor id -> Map<mid, info> as last announced by the neighbor */
  #remoteMids = new Map();
  /** neighbor id -> Map<mid, track> attached to stable streams or forwarding */
  #attached = new Map();
  #queues = new Map();
  #group;

  /** @param {object} group internal group interface */
  constructor(group) {
    this.#group = group;
    this.l = group.log.scope("media");
    this.streams = new StableStreams({
      preferredSource: (origin) => group.mediaSourceFor(origin),
      emit: (origin, event, detail) => group.connections.get(origin)?.emit(event, detail),
      stableTracks: group.config.stableTracks,
      clock: group.clock,
    });
  }

  /**
   * @param {MediaStreamTrack} track
   * @param {{tag?: string, to?: "all" | string[]}} [options]
   */
  publish(track, options) {
    const pub = new RalPublication(this, track, options);
    this.pubs.set(pub.id, pub);
    this.l.info("publish", { pub: pub.id, kind: pub.kind, tag: pub.tag, to: pub.to === "all" ? "all" : [...pub.to] });
    this.#group.mediaChanged();
    return pub;
  }

  /** @param {RalPublication} pub */
  unpublish(pub) {
    this.pubs.delete(pub.id);
    this.l.info("unpublish", { pub: pub.id });
    this.#group.mediaChanged();
  }

  /** Replaces the track of a source on every direct connection that carries it. */
  async replaceSource(key, track) {
    for (const sending of this.#sending.values()) {
      const s = sending.get(key);
      if (s) await this.#replaceTrack(s.slot, track);
    }
  }

  #replaceTrack(slot, track) {
    return slot.tr.sender.replaceTrack(track).catch((e) => this.l.warn("replaceTrack failed", { error: e.message }));
  }

  /**
   * Brings a direct connection's slots in line with the plan. Serialized per direct connection.
   * @param {import("../direct/direct-peer-connection.js").RalDirectPeerConnection} directConn
   */
  sync(directConn) {
    let q = this.#queues.get(directConn.ralRemoteId);
    if (!q) this.#queues.set(directConn.ralRemoteId, (q = new SerialQueue((e) => this.l.warn("media sync failed", { peer: directConn.ralRemoteId, error: e?.message }))));
    if (q.pending) return;
    q.pending = true;
    q.push(async () => {
      q.pending = false;
      await this.#sync(directConn);
    });
  }

  async #sync(directConn) {
    if (!directConn.ralCtlOpen) return;
    const plan = this.#group.routing.mediaRelay.plan(directConn);
    let sending = this.#sending.get(directConn.ralRemoteId);
    if (!sending) this.#sending.set(directConn.ralRemoteId, (sending = new Map()));
    for (const [key, s] of sending) {
      if (!directConn.ralOwnsSlot(s.slot)) sending.delete(key);
    }
    let changed = false;
    for (const [key, s] of [...sending]) {
      if (plan.some((p) => p.key === key)) continue;
      directConn.ralReleaseSendSlot(s.slot);
      sending.delete(key);
      changed = true;
    }
    for (const p of plan) {
      let s = sending.get(p.key);
      if (!s) {
        let slot;
        try {
          slot = await directConn.ralAcquireSendSlot(p.info.kind, p.key);
        } catch (error) {
          this.l.warn("no send slot", { peer: directConn.ralRemoteId, key: p.key, error: error.message });
          continue;
        }
        if (!directConn.ralOwnsSlot(slot)) continue;
        s = { slot, info: p.info, active: null, track: null, applied: null };
        sending.set(p.key, s);
        changed = true;
      }
      if (s.track !== p.track) {
        s.track = p.track;
        await this.#replaceTrack(s.slot, p.track);
      }
      const applied = JSON.stringify({ active: p.active, params: p.params ?? null });
      if (s.applied !== applied) {
        s.applied = applied;
        s.active = p.active;
        await setEncodings(s.slot.tr.sender, p.active, p.params).catch((e) => this.l.warn("setParameters failed", { error: e.message }));
      }
      if (JSON.stringify(s.info) !== JSON.stringify(p.info)) {
        s.info = p.info;
        changed = true;
      }
    }
    if (changed || !sending.announced) {
      sending.announced = true;
      const mids = {};
      for (const s of sending.values()) if (s.slot.tr.mid != null) mids[s.slot.tr.mid] = s.info;
      directConn.ralSendCtl({ t: "mid-map", mids });
      this.l.debug("mid-map sent", { peer: directConn.ralRemoteId, count: Object.keys(mids).length });
    }
  }

  /** Senders of a direct connection, for bandwidth control. */
  senders(neighborId) {
    return this.#sending.get(neighborId) ?? new Map();
  }

  /** Forgets a direct connection's sending and receiving state (rebuild or close). */
  resetDirect(neighborId) {
    this.#sending.delete(neighborId);
    this.#remoteMids.delete(neighborId);
    this.#attached.delete(neighborId);
    this.streams.detachSource(neighborId);
    this.#group.routing.mediaRelay.forwardedSourcesGone(neighborId);
  }

  /**
   * Handles `mid-map` from a neighbor.
   * @param {import("../direct/direct-peer-connection.js").RalDirectPeerConnection} directConn
   * @param {{mids: Record<string, {origin: string, pub: string, tag: string, kind: string}>}} msg
   */
  onMidMap(directConn, msg) {
    const mids = new Map(Object.entries(msg.mids ?? {}));
    this.#remoteMids.set(directConn.ralRemoteId, mids);
    this.resolve(directConn);
  }

  /** Re-resolves announced mids to tracks, e.g. after a negotiation round. */
  resolve(directConn) {
    const mids = this.#remoteMids.get(directConn.ralRemoteId);
    if (!mids) return;
    let attached = this.#attached.get(directConn.ralRemoteId);
    if (!attached) this.#attached.set(directConn.ralRemoteId, (attached = new Map()));
    for (const [mid, a] of [...attached]) {
      const now = mids.get(mid);
      if (now && now.origin === a.info.origin && now.pub === a.info.pub) continue;
      attached.delete(mid);
      this.#detach(directConn, a.info);
    }
    for (const [mid, info] of mids) {
      if (attached.has(mid)) continue;
      const tr = directConn.ralTransceiver(mid);
      if (!tr || !tr.receiver.track) continue;
      attached.set(mid, { info, track: tr.receiver.track });
      this.#attach(directConn, info, tr.receiver.track);
    }
  }

  #attach(directConn, info, track) {
    this.l.info("remote track", { via: directConn.ralRemoteId, origin: info.origin, pub: info.pub, kind: info.kind, tag: info.tag });
    if (info.origin !== this.#group.selfId && this.#group.subscribed(info.origin, info.kind, info.tag)) {
      this.streams.attach(info, directConn.ralRemoteId, track);
    }
    this.#group.routing.mediaRelay.receivedSource(directConn, info, track);
  }

  #detach(directConn, info) {
    this.streams.detach(info.origin, info.pub, directConn.ralRemoteId);
    this.#group.routing.mediaRelay.receivedSourceGone(directConn, info);
  }
}

async function setEncodings(sender, active, params) {
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) return;
  for (const e of p.encodings) {
    e.active = active;
    if (params?.maxBitrate !== undefined) e.maxBitrate = Math.max(30000, Math.round(params.maxBitrate));
    else delete e.maxBitrate;
    if (sender.track?.kind === "video" || params?.scaleResolutionDownBy !== undefined) e.scaleResolutionDownBy = params?.scaleResolutionDownBy ?? 1;
  }
  await sender.setParameters(p);
}
