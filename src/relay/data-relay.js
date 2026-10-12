import { rewriteIdx, rewriteLifetime, FLAG } from "../transport/framing.js";

/**
 * Relay side of peer relaying (plan section 7.2, 9.3, decision D21): accepts or rejects relay
 * requests, forwards envelopes of accepted flows between its two neighbors, rewrites the index
 * fields, and reports hop failures to the far end with `route-down` / `route-slow`.
 */
export class DataRelay {
  /** flow key -> {flow, origin, target, role, kinds, bytes, since} */
  flows = new Map();
  #group;
  #bytesWindow = 0;
  #rate = 0;
  #rateAt = 0;

  /** @param {object} group */
  constructor(group) {
    this.#group = group;
    this.l = group.log.scope("relay");
    this.#rateAt = group.clock.now();
  }

  static key(origin, target, flow) {
    return `${origin}|${target}|${flow}`;
  }

  /** True when a flow between a and b (either direction) is accepted. */
  carries(a, b) {
    for (const f of this.flows.values()) {
      if ((f.origin === a && f.target === b) || (f.origin === b && f.target === a)) return true;
    }
    return false;
  }

  /** Relayed bytes per second over the last measurement window. */
  get rate() {
    const now = this.#group.clock.now();
    const dt = now - this.#rateAt;
    if (dt >= 1000) {
      this.#rate = (this.#bytesWindow * 1000) / dt;
      this.#bytesWindow = 0;
      this.#rateAt = now;
    }
    return this.#rate;
  }

  /**
   * Handles `relay-request` from the origin end.
   * @param {import("../link/direct-link.js").DirectLink} link link to the origin
   * @param {{flow: string, origin: string, target: string, role: string, kinds?: string[]}} msg
   */
  onRequest(link, msg) {
    const g = this.#group;
    const origin = link.remoteId;
    const reject = (reason) => {
      this.l.info("relay request rejected", { flow: msg.flow, origin, target: msg.target, reason });
      link.sendCtl({ t: "relay-reject", flow: msg.flow, reason });
    };
    if (msg.origin !== origin) return reject("origin mismatch");
    if (!g.config.relay) return reject("relaying disabled");
    if (!g.peers.has(msg.target) || !g.peers.has(origin)) return reject("not a member");
    if (!g.helloDone(msg.target) || !g.helloDone(origin)) return reject("no hello");
    if (g.config.allowRelay && !g.config.allowRelay(origin, msg.target)) return reject("not allowed");
    const next = g.links.get(msg.target);
    if (!next?.usable) return reject("no link to target");
    const key = DataRelay.key(origin, msg.target, msg.flow);
    if (!this.flows.has(key)) {
      if (this.flows.size >= g.config.maxRelayFlows) return reject("too many flows");
      if (g.routing.load > g.config.maxRelayLoad) return reject("overloaded");
      const media = (msg.kinds ?? []).length > 0;
      if (media && g.config.mediaRelay === "never") return reject("media relay disabled");
    }
    const existing = this.flows.get(key);
    const flow = { flow: msg.flow, origin, target: msg.target, role: msg.role === "standby" ? "standby" : "active", kinds: msg.kinds ?? [], bytes: 0, since: g.clock.now() };
    this.flows.set(key, flow);
    g.localIndex(next, origin);
    g.localIndex(link, msg.target);
    next.sendCtl({ t: "relay-open", flow: msg.flow, origin, role: flow.role, kinds: flow.kinds });
    link.sendCtl({ t: "relay-accept", flow: msg.flow });
    this.l.info(existing ? "relay flow updated" : "relay flow accepted", { flow: msg.flow, origin, target: msg.target, role: flow.role });
    g.mediaChanged();
  }

  /**
   * Handles `relay-close` from either end and forwards it to the other end.
   * @param {import("../link/direct-link.js").DirectLink} link
   * @param {{flow: string}} msg
   */
  onClose(link, msg) {
    for (const [key, f] of this.flows) {
      if (f.flow !== msg.flow || (f.origin !== link.remoteId && f.target !== link.remoteId)) continue;
      this.flows.delete(key);
      const other = f.origin === link.remoteId ? f.target : f.origin;
      this.#group.links.get(other)?.sendCtl({ t: "relay-close", flow: f.flow, origin: f.origin });
      this.l.info("relay flow closed", { flow: f.flow, origin: f.origin, target: f.target, by: link.remoteId });
      this.#group.mediaChanged();
    }
  }

  /**
   * Handles `standby-activate` from the origin end: the standby becomes active.
   * @param {import("../link/direct-link.js").DirectLink} link
   * @param {{flow: string}} msg
   */
  onActivate(link, msg) {
    for (const f of this.flows.values()) {
      if (f.flow !== msg.flow || f.origin !== link.remoteId) continue;
      f.role = "active";
      this.#group.links.get(f.target)?.sendCtl({ t: "standby-activate", flow: f.flow, origin: f.origin });
      this.l.info("standby activated", { flow: f.flow, origin: f.origin, target: f.target });
      this.#group.mediaChanged();
    }
  }

  /**
   * Forwards an envelope of an accepted flow. Drops everything else.
   * @param {import("../link/direct-link.js").DirectLink} link incoming link
   * @param {string} src origin peer id
   * @param {string} dst destination peer id
   * @param {Uint8Array} bytes
   * @param {import("../transport/framing.js").Envelope} e
   * @param {string} key transport key
   */
  forward(link, src, dst, bytes, e, key) {
    const g = this.#group;
    if (src !== link.remoteId || !this.carries(src, dst)) {
      this.l.debug("dropped envelope of unaccepted flow", { src, dst, via: link.remoteId });
      return;
    }
    const next = g.links.get(dst);
    if (!next?.usable) return;
    const copy = bytes.slice();
    rewriteIdx(copy, g.localIndex(next, src), 1);
    if (e.flags & FLAG.LIFETIME) {
      const remaining = e.lifetime - (link.metrics.rtt ?? 0) / 2;
      if (remaining <= 0) {
        this.l.debug("dropped expired envelope", { src, dst, lifetime: e.lifetime });
        return;
      }
      rewriteLifetime(copy, remaining);
    }
    this.#bytesWindow += copy.length;
    next.sendEnvelope(key, `relay:${src}>${dst}:${e.channelId}`, copy);
  }

  /**
   * A hop of a relayed flow changed state: tell the far end (plan section 6.2).
   * @param {string} peerId the neighbor whose link changed
   * @param {"ok"|"slow"|"stale"} verdict
   */
  hopChanged(peerId, verdict) {
    if (verdict === "ok") return;
    const g = this.#group;
    const t = verdict === "stale" ? "route-down" : "route-slow";
    const told = new Set();
    for (const f of this.flows.values()) {
      const other = f.origin === peerId ? f.target : f.target === peerId ? f.origin : null;
      if (!other || told.has(other)) continue;
      told.add(other);
      g.links.get(other)?.sendCtl({ t, origin: peerId, target: other });
      this.l.info(`${t} sent`, { dead: peerId, to: other });
    }
  }

  /** Drops all flows involving `peerId`. */
  peerGone(peerId) {
    for (const [key, f] of this.flows) {
      if (f.origin !== peerId && f.target !== peerId) continue;
      this.flows.delete(key);
      const other = f.origin === peerId ? f.target : f.origin;
      this.#group.links.get(other)?.sendCtl({ t: "route-down", origin: peerId, target: other });
      this.#group.links.get(other)?.sendCtl({ t: "relay-close", flow: f.flow, origin: f.origin });
    }
  }

  /** Flows as plain objects, for diagnostics. */
  list() {
    return [...this.flows.values()].map((f) => ({ flow: f.flow, origin: f.origin, target: f.target, role: f.role, kinds: f.kinds }));
  }
}
