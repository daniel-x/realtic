import { Emitter } from "./util/emitter.js";
import { isImpolite, randomId } from "./util/ids.js";
import { Session } from "./channel/session.js";
import { encode, split, aad, FLAG, TYPE, Reassembler, headerLength } from "./transport/framing.js";
import { encrypt, decrypt, OVERHEAD } from "./crypto/e2e.js";
import { LivenessMonitor } from "./liveness/monitor.js";

const LOG_PART_BYTES = 16384;

/**
 * The connection to one other peer of the group, kept up as long as the peer is known (plan
 * section 3). It is direct, wrapping the RTCPeerConnection of its direct link, or routed through a
 * relay, using the relay's direct link. Finding routes, keeping standby routes warm and switching
 * routes happen inside; the object survives link rebuilds, ICE restarts and route switches, so app
 * state bound to it never has to be rebuilt (doc §3.8).
 *
 * Events: `statechange` (state, reason), `routechange` (route), `channel` (ReatChannel),
 * `track` ({track, stream, tag, origin, kind}), `trackreplaced` ({track, oldTrack, stream, tag}),
 * `trackended` ({track, stream, tag}).
 */
export class ReatPeerConnection extends Emitter {
  #state = "connecting";
  #reason = "";
  #group;
  #route = null;
  #everConnected = false;
  #reassembler;
  #encChain = Promise.resolve();
  #decChain = Promise.resolve();
  #e2eMonitor;
  #logRequests = new Map();
  #logParts = new Map();
  #beatTimer = null;

  /**
   * The direct link to this peer, owned by this connection; null until hello completed.
   * @type {import("./link/direct-link.js").DirectLink | null}
   */
  direct = null;
  /** Remote hello (protocol, keys, capabilities), once received. */
  remote = null;
  /** End to end AES-GCM key for relayed data. */
  pairKey = null;
  /** Last error text and hint. */
  lastError = null;
  hint = null;

  /**
   * @param {object} group internal group interface
   * @param {string} id
   */
  constructor(group, id) {
    super();
    this.#group = group;
    this.id = id;
    this.impolite = isImpolite(group.selfId, id);
    this.l = group.log.scope("routing", { peer: id });
    this.#reassembler = new Reassembler(group.clock);
    this.session = new Session({
      impolite: this.impolite,
      config: group.config,
      clock: group.clock,
      log: group.log.scope("channel", { peer: id }),
      transmit: (e, key) => this.#transmit(e, key),
    });
    this.session.on("channel", (ch) => this.emit("channel", ch));
    this.session.on("control", (msg) => this.#onControl(msg));
    this.#e2eMonitor = LivenessMonitor.fromConfig(group.config, () => group.clock.now(), (state, silence) => group.routing.onE2ELiveness(this, state, silence));
  }

  /** `connecting` | `connected` | `slow` | `reconnecting` | `unreachable` | `closing` | `closed` */
  get state() {
    return this.#state;
  }

  /** Reason of the last state change. */
  get reason() {
    return this.#reason;
  }

  /** `{ kind: "direct" | "relay", via, candidateType }` or null without a route. */
  get route() {
    const r = this.#route;
    if (!r) return null;
    if (r.kind === "direct") {
      const link = this.direct;
      return { kind: "direct", via: null, candidateType: link?.viaTurn ? "relay" : link?.metrics.candidateType ?? "host" };
    }
    return { kind: "relay", via: r.via, candidateType: this.#group.directConns.get(r.via)?.metrics.candidateType ?? "host" };
  }

  /** Internal route descriptor. */
  get routeInfo() {
    return this.#route;
  }

  /** The current RTCPeerConnection of the direct link, or null without one; for advanced use. */
  get rtcPeerConnection() {
    return this.direct?.pc ?? null;
  }

  /** End to end liveness monitor of relayed routes. */
  get e2e() {
    return this.#e2eMonitor;
  }

  /**
   * Creates an end to end data channel (plan section 9.2).
   * @param {string} label
   * @param {{ordered?: boolean, maxRetransmits?: number, maxPacketLifeTime?: number, protocol?: string}} [init]
   */
  createChannel(label, init) {
    if (this.#state === "closing" || this.#state === "closed") throw new DOMException("connection is closed", "InvalidStateError");
    return this.session.createChannel(label, init);
  }

  /**
   * Fetches the remote side's diagnostic report. Rejects when the remote app did not enable
   * `shareLogWithPeers`.
   * @param {number} [timeoutMs]
   */
  requestLog(timeoutMs = 15000) {
    const id = randomId(8);
    return new Promise((resolve, reject) => {
      const timer = this.#group.clock.setTimeout(() => {
        this.#logRequests.delete(id);
        reject(new Error("log request timed out"));
      }, timeoutMs);
      this.#logRequests.set(id, { resolve, reject, timer });
      this.session.sendControl({ t: "log-request", id });
    });
  }

  async #onControl(msg) {
    switch (msg.t) {
      case "log-request": {
        if (!this.#group.config.shareLogWithPeers) {
          this.session.sendControl({ t: "log-response", id: msg.id, refused: true });
          return;
        }
        const text = JSON.stringify(await this.#group.diagnosticReport());
        const parts = Math.max(1, Math.ceil(text.length / LOG_PART_BYTES));
        for (let i = 0; i < parts; i++) {
          this.session.sendControl({ t: "log-response", id: msg.id, part: i, parts, data: text.slice(i * LOG_PART_BYTES, (i + 1) * LOG_PART_BYTES) });
        }
        return;
      }
      case "log-response": {
        const req = this.#logRequests.get(msg.id);
        if (!req) return;
        if (msg.refused) {
          this.#finishLog(msg.id, null, new Error("remote peer does not share its log"));
          return;
        }
        let parts = this.#logParts.get(msg.id);
        if (!parts) this.#logParts.set(msg.id, (parts = []));
        parts[msg.part] = msg.data;
        if (parts.filter((p) => p !== undefined).length === msg.parts) {
          try {
            this.#finishLog(msg.id, JSON.parse(parts.join("")));
          } catch (error) {
            this.#finishLog(msg.id, null, error);
          }
        }
        return;
      }
      case "bg":
        this.#e2eMonitor.setBackground(true);
        this.l.info("remote entered background mode (end to end)");
        return;
      case "fg":
        this.#e2eMonitor.setBackground(false);
        this.l.info("remote left background mode (end to end)");
        return;
      default:
        this.#group.routing.onPeerControl(this, msg);
    }
  }

  #finishLog(id, report, error) {
    const req = this.#logRequests.get(id);
    this.#logRequests.delete(id);
    this.#logParts.delete(id);
    if (!req) return;
    this.#group.clock.clearTimeout(req.timer);
    if (error) req.reject(error);
    else req.resolve(report);
  }

  // Routing ------------------------------------------------------------------------------------

  /**
   * Switches the sending route. Unacknowledged reliable data is resent on the new route.
   * @param {{kind: "direct"} | {kind: "relay", via: string, flow: string} | null} route
   * @param {string} reason
   */
  setRoute(route, reason) {
    const prev = this.#route;
    const same = prev && route && prev.kind === route.kind && prev.via === route.via && prev.flow === route.flow;
    if (same || (!prev && !route)) return;
    this.#route = route;
    this.l.info("route change", { from: describe(prev), to: describe(route), reason });
    if (route?.kind === "relay") {
      this.#e2eMonitor.reset();
      this.#startBeats();
    } else {
      this.#stopBeats();
    }
    if (route) {
      this.session.routeChanged();
      this.session.pump();
    }
    this.emit("routechange", this.route);
  }

  #startBeats() {
    if (this.#beatTimer !== null) return;
    const c = this.#group.config;
    let last = 0;
    this.#beatTimer = this.#group.clock.setInterval(() => {
      this.#e2eMonitor.check();
      const now = this.#group.clock.now();
      if (now - last >= c.HEARTBEAT_IDLE_MS) {
        last = now;
        this.session.sendBeat();
      }
    }, c.LIVENESS_CHECK_INTERVAL_MS);
  }

  #stopBeats() {
    if (this.#beatTimer === null) return;
    this.#group.clock.clearInterval(this.#beatTimer);
    this.#beatTimer = null;
  }

  /**
   * Sends one end to end message on the current route, fragmented to the path's message size and
   * encrypted on relayed routes. Returns false when the route cannot take it now.
   * @param {{type: number, channelId: number, seq: number, payload: Uint8Array, lifetime?: number}} e
   * @param {string} key transport key
   */
  #transmit(e, key) {
    const route = this.#route;
    const reliable = key === "rel";
    if (!route) return !reliable;
    const extra = this.#group.routing.extraRoutes(this);
    const ok = this.#sendOn(route, e, key);
    for (const r of extra) this.#sendOn(r, e, key);
    return ok || !reliable;
  }

  #sendOn(route, e, key) {
    const link = route.kind === "direct" ? this.direct : this.#group.directConns.get(route.via);
    if (!link || !link.usable) return false;
    const encrypted = route.kind === "relay";
    if (encrypted && !this.pairKey) return false;
    const flow = `${this.id}:${e.channelId}`;
    const dstIdx = route.kind === "direct" ? 1 : this.#group.localIndex(link, this.id);
    const flags = encrypted ? FLAG.ENCRYPTED : 0;
    const lifetimeFlag = e.lifetime !== undefined ? FLAG.LIFETIME : 0;
    const mtu = Math.min(link.maxMessageSize, this.#group.config.maxFragmentBytes, this.#group.routing.pathMessageSize(route));
    const room = mtu - headerLength(FLAG.FRAGMENTED | lifetimeFlag) - (encrypted ? OVERHEAD : 0);
    const parts = split(e.payload, Math.max(256, room));
    const total = e.payload.length + parts.length * 64;
    if (link.queuedBytes(key, flow) + total > this.#group.config.relayQueueBytes) return false;
    const base = { version: this.#group.protocol.major, type: e.type, flags, srcIdx: 0, dstIdx, channelId: e.channelId, seq: e.seq, lifetime: e.lifetime };
    const fragmented = parts.length > 1;
    const envelopes = parts.map((payload, i) => (fragmented ? { ...base, fragIndex: i, fragCount: parts.length, payload } : { ...base, payload }));
    if (!encrypted) {
      for (const env of envelopes) link.sendEnvelope(key, flow, encode(env));
      return true;
    }
    const keyRef = this.pairKey;
    this.#encChain = this.#encChain.then(async () => {
      for (const env of envelopes) {
        const ct = await encrypt(keyRef, aad(env), env.payload);
        link.sendEnvelope(key, flow, encode({ ...env, payload: ct }));
      }
    }).catch((error) => this.l.warn("encryption failed", { error: error.message }));
    return true;
  }

  /**
   * Sends an end to end beat on a specific route (standby relays, plan section 7.2a).
   * @param {{kind: "relay", via: string, flow: string}} route
   */
  beatOn(route) {
    this.#sendOn(route, { type: TYPE.BEAT, channelId: 0, seq: 0, payload: new Uint8Array(0) }, "unrel");
  }

  /**
   * Handles an envelope addressed to us from this peer.
   * @param {import("./transport/framing.js").Envelope} e
   * @param {boolean} relayed
   * @param {string} via neighbor the envelope arrived from
   */
  receiveEnvelope(e, relayed, via) {
    const encrypted = (e.flags & FLAG.ENCRYPTED) !== 0;
    if (relayed !== encrypted) {
      this.l.warn("dropped envelope with wrong encryption", { relayed, encrypted });
      return;
    }
    const onActive = relayed && this.#route?.kind === "relay" && this.#route.via === via;
    if (onActive) this.#e2eMonitor.noteData();
    if (!encrypted) return this.#complete(e, e.payload);
    if (!this.pairKey) return;
    const keyRef = this.pairKey;
    const payload = e.payload.slice();
    this.#decChain = this.#decChain
      .then(() => decrypt(keyRef, aad(e), payload))
      .then((plain) => this.#complete(e, plain))
      .catch(() => this.l.warn("dropped envelope that failed authentication", { type: e.type, channelId: e.channelId }));
  }

  #complete(e, payload) {
    if (e.fragCount !== undefined) {
      const full = this.#reassembler.add(`${e.type}:${e.channelId}:${e.seq}`, e.fragIndex, e.fragCount, payload);
      if (!full) return;
      payload = full;
    }
    this.session.receive(e, payload);
  }

  /** Lets end to end senders continue after a transport drained. */
  pump() {
    this.session.pump();
  }

  // State ---------------------------------------------------------------------------------------

  /**
   * Sets the state, emitting `statechange` on change.
   * @param {string} state
   * @param {string} reason
   */
  setState(state, reason) {
    if (state === this.#state) return;
    if (this.#state === "closed") return;
    if (this.#state === "closing" && state !== "closed") return;
    const prev = this.#state;
    this.#state = state;
    this.#reason = reason;
    if (state === "connected") {
      this.#everConnected = true;
      this.lastError = null;
      this.hint = null;
    }
    const level = state === "unreachable" ? "error" : state === "reconnecting" ? "warn" : "info";
    this.#group.log.write(level, "routing", `peer state ${prev} -> ${state}`, { reason, hint: this.hint ?? undefined }, { peer: this.id });
    this.emit("statechange", state, reason);
  }

  /** True after the peer was connected once. */
  get everConnected() {
    return this.#everConnected;
  }

  /**
   * Closes the direct link and drops it.
   * @param {string} reason
   */
  closeDirect(reason) {
    const link = this.direct;
    this.direct = null;
    link?.close(reason);
  }

  /**
   * Closes the connection: `closing` before anything is shut down, `closed` at the end.
   * @param {string} [reason]
   */
  close(reason = "closed") {
    if (this.#state === "closed") return;
    this.setState("closing", reason);
    this.closeDirect(reason);
    this.#stopBeats();
    this.session.close();
    for (const [id] of this.#logRequests) this.#finishLog(id, null, new Error("peer closed"));
    this.setState("closed", reason);
  }
}

function describe(r) {
  if (!r) return "none";
  return r.kind === "direct" ? "direct" : `relay:${r.via}`;
}
