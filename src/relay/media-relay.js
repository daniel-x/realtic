import { wants } from "../media/subscriptions.js";
import { directBudgets, relayBudget, encodingParams, BudgetReporter } from "../media/bwe.js";
import { connects } from "./data-relay.js";

const BUDGET_CHANGE = 0.1;
const CPU_BUDGET_FACTOR = 0.7;

/**
 * Media planning per direct connection (plan section 10.2, 10.4, 7.2a).
 *
 * Own publications go to a neighbor when the pair route is direct, and to a relay neighbor when a
 * relay flow of a target runs through it: active for the active flow, inactive (prepared slot) for
 * a standby flow. On a relay, received tracks of an origin go to the far ends of accepted flows,
 * active only for active flows and wanted subscriptions. Unsubscribed flows stop at their source:
 * a relay tells the origin the subscriptions of the ends behind it.
 *
 * Bandwidth: each direct connection splits its estimate into per-flow budgets. A relay reports to
 * the origin the minimum budget of its destination hops per forwarded publication and encodes all
 * outputs at that minimum (decision D3).
 */
export class MediaRelay {
  #group;
  #routing;
  /** neighbor id -> Map<source key, bps> */
  #budgets = new Map();
  /** neighbor id -> loss-based estimate (browsers without availableOutgoingBitrate) */
  #estimate = new Map();
  /** neighbor id -> {bytes, at} outbound video measurement */
  #sendRate = new Map();
  /** `${origin}:${pub}` -> {info, track, via} tracks received for forwarding */
  #forwardable = new Map();
  /** relay neighbor id -> Map<pub, bps> budgets reported by the relay for our publications */
  #reported = new Map();
  /** origin id -> BudgetReporter (relay side) */
  #reporters = new Map();
  /** origin id -> Map<pub, bps> last relay budgets computed for an origin */
  #relayBudgets = new Map();
  #remoteKinds = new Map();
  #sentKinds = new Map();
  /** subscriber id -> Map<origin, subscription> */
  subs = new Map();

  constructor(group, routing) {
    this.#group = group;
    this.#routing = routing;
    this.l = group.log.scope("media");
  }

  // Subscriptions -------------------------------------------------------------------------------

  /** Subscription of `subscriber` for `origin`'s media (undefined: everything). */
  subscription(subscriber, origin) {
    return this.subs.get(subscriber)?.get(origin);
  }

  /**
   * Handles `subscription` from a neighbor: stores it and, on a relay, forwards it to the origin.
   * @param {import("../direct/direct-peer-connection.js").RalDirectPeerConnection} directConn
   * @param {{origin: string, for?: string, audio: boolean, video: boolean, tags: string[]|null}} msg
   */
  onSubscription(directConn, msg) {
    if (typeof msg.origin !== "string") return;
    const g = this.#group;
    const subscriber = typeof msg.for === "string" ? msg.for : directConn.ralRemoteId;
    if (subscriber !== directConn.ralRemoteId) {
      const ok =
        msg.origin === g.selfId
          ? this.#routing.hasFlowVia(subscriber, directConn.ralRemoteId)
          : this.#routing.relay.carries(subscriber, msg.origin);
      if (!ok) return;
    }
    let m = this.subs.get(subscriber);
    if (!m) this.subs.set(subscriber, (m = new Map()));
    const sub = { audio: msg.audio !== false, video: msg.video !== false, tags: Array.isArray(msg.tags) ? msg.tags : null };
    m.set(msg.origin, sub);
    this.l.info("remote subscription", { subscriber, origin: msg.origin, via: directConn.ralRemoteId, ...sub });
    if (msg.origin !== g.selfId) {
      const toOrigin = g.directConns.get(msg.origin);
      if (toOrigin?.ralCtlOpen && this.#routing.relay.carries(subscriber, msg.origin)) toOrigin.ralSendCtl({ ...msg, for: subscriber });
    }
    g.mediaChanged();
  }

  /** Sends our subscription for `origin` to the origin and to every relay of the pair. */
  sendSubscription(origin) {
    const g = this.#group;
    const sub = g.subscription(origin);
    if (!sub) return;
    const msg = { t: "subscription", origin, for: g.selfId, ...sub };
    const targets = new Set([origin]);
    for (const f of this.#routing.pairs.get(origin)?.flows.values() ?? []) if (f.state === "open") targets.add(f.via);
    for (const id of targets) {
      const directConn = g.directConns.get(id);
      if (directConn?.ralCtlOpen) directConn.ralSendCtl(msg);
    }
  }

  /** Re-sends all our subscriptions over `directConn` (after it opened). */
  resendSubscriptions(directConn) {
    const g = this.#group;
    for (const origin of g.connections.keys()) {
      const sub = g.subscription(origin);
      if (!sub) continue;
      if (origin === directConn.ralRemoteId || this.#routing.hasFlowVia(origin, directConn.ralRemoteId)) directConn.ralSendCtl({ t: "subscription", origin, for: g.selfId, ...sub });
    }
  }

  // Plan ----------------------------------------------------------------------------------------

  /**
   * Sources `directConn` must carry: `[{key, info, track, active, params}]`.
   * @param {import("../direct/direct-peer-connection.js").RalDirectPeerConnection} directConn
   */
  plan(directConn) {
    const g = this.#group;
    const out = [];
    const neighbor = directConn.ralRemoteId;
    for (const pub of g.media.pubs.values()) {
      let carried = false;
      let active = false;
      const neighborRoute = g.connections.get(neighbor)?.routeInfo;
      if (pub.targets(neighbor) && neighborRoute?.kind === "direct") {
        carried = true;
        active ||= wants(this.subscription(neighbor, g.selfId), pub.kind, pub.tag);
      }
      for (const [target, p] of this.#routing.pairs) {
        if (target === neighbor || !pub.targets(target)) continue;
        const route = g.connections.get(target)?.routeInfo;
        for (const f of p.flows.values()) {
          if (f.via !== neighbor || f.state !== "open" || this.#routing.neighbors.get(neighbor)?.relayMedia === false) continue;
          carried = true;
          const inUse = route?.kind === "relay" && route.flow === f.flow;
          if (inUse && wants(this.subscription(target, g.selfId), pub.kind, pub.tag)) active = true;
        }
      }
      if (!carried) continue;
      const info = { origin: g.selfId, pub: pub.id, tag: pub.tag, kind: pub.kind };
      if (pub.limits?.maxBitrate !== undefined) info.maxBitrate = pub.limits.maxBitrate;
      out.push({ key: `self:${pub.id}`, info, track: pub.track, active, limits: pub.limits });
    }
    for (const [key, src] of g.relaysMedia ? this.#forwardable : []) {
      const origin = src.info.origin;
      if (origin === neighbor || src.via === neighbor) continue;
      let carried = false;
      let active = false;
      for (const f of this.#routing.relay.flows.values()) {
        if (!connects(f, origin, neighbor)) continue;
        carried = true;
        if (f.role === "active" && wants(this.subscription(neighbor, origin), src.info.kind, src.info.tag)) active = true;
      }
      if (!carried) continue;
      out.push({ key: `fwd:${key}`, info: { ...src.info }, track: src.track, active, limits: src.info.maxBitrate === undefined ? null : { maxBitrate: src.info.maxBitrate } });
    }
    for (const p of out) p.params = this.#params(directConn, p);
    return out;
  }

  /**
   * Encoding parameters. On a direct path the browser's own congestion control adapts the
   * bitrate, so only relayed flows get explicit caps: a relay encodes every output at the minimum
   * budget of its destinations, and the origin applies the budget the relay reported (D3). The
   * limits of the publication apply on top, on every path, and a relay applies the origin's
   * bitrate limit.
   */
  #params(directConn, p) {
    const bps = p.info.kind !== "video" ? undefined : p.key.startsWith("fwd:")
      ? this.#relayBudgets.get(p.info.origin)?.get(p.info.pub)
      : this.#reported.get(directConn.ralRemoteId)?.get(p.info.pub);
    return encodingParams(bps, p.limits, this.#group.config.bweResolutionSteps);
  }

  /** Media kinds the pair with `peerId` exchanges. */
  kindsFor(peerId) {
    const kinds = new Set();
    for (const pub of this.#group.media.pubs.values()) if (pub.targets(peerId)) kinds.add(pub.kind);
    return [...kinds];
  }

  /** True when the pair with `peerId` exchanges media (our publications or theirs). */
  pairHasMedia(peerId) {
    return this.kindsFor(peerId).length > 0 || (this.#remoteKinds.get(peerId)?.length ?? 0) > 0;
  }

  /** Handles the end to end `media` message: the kinds the remote side publishes to us. */
  onRemoteKinds(peerId, kinds) {
    this.#remoteKinds.set(peerId, Array.isArray(kinds) ? kinds : []);
  }

  // Forwarding sources (relay side) -------------------------------------------------------------

  receivedSource(directConn, info, track) {
    if (info.origin !== directConn.ralRemoteId) return;
    this.#forwardable.set(`${info.origin}:${info.pub}`, { info, track, via: directConn.ralRemoteId });
    if (this.#routing.relay.flows.size) this.#group.mediaChanged();
  }

  receivedSourceGone(directConn, info) {
    const key = `${info.origin}:${info.pub}`;
    if (this.#forwardable.get(key)?.via !== directConn.ralRemoteId) return;
    this.#forwardable.delete(key);
    this.#group.mediaChanged();
  }

  forwardedSourcesGone(neighborId) {
    let changed = false;
    for (const [key, src] of this.#forwardable) {
      if (src.via !== neighborId) continue;
      this.#forwardable.delete(key);
      changed = true;
    }
    this.#reported.delete(neighborId);
    this.#budgets.delete(neighborId);
    if (changed) this.#group.mediaChanged();
  }

  // Bandwidth -----------------------------------------------------------------------------------

  /**
   * Bitrate the direct connection can carry: `availableOutgoingBitrate`, or where a browser does
   * not report it, a loss-based estimate (additive increase, multiplicative decrease above 10 %
   * loss).
   */
  #capacity(directConn, stats) {
    const m = directConn.ralMetrics;
    if (typeof m.bitrate === "number" && m.bitrate > 0) return m.bitrate;
    let bytes = 0;
    for (const s of stats?.values() ?? []) if (s.type === "outbound-rtp" && s.kind === "video") bytes += s.bytesSent ?? 0;
    const now = this.#group.clock.now();
    const prev = this.#sendRate.get(directConn.ralRemoteId);
    const rate = prev && now > prev.at ? ((bytes - prev.bytes) * 8000) / (now - prev.at) : undefined;
    this.#sendRate.set(directConn.ralRemoteId, { bytes, at: now });
    if (rate === undefined) return undefined;
    const last = this.#estimate.get(directConn.ralRemoteId) ?? this.#group.config.bweFallbackBps;
    const next = (m.loss ?? 0) > 0.1 ? Math.max(50000, Math.min(last, rate) * 0.85) : Math.min(last + Math.max(50000, last * 0.08), 4000000);
    this.#estimate.set(directConn.ralRemoteId, next);
    return next;
  }

  onMetrics(directConn, m, stats) {
    const g = this.#group;
    const capacity = this.#capacity(directConn, stats);
    const current = this.#budgets.get(directConn.ralRemoteId);
    let next;
    if (capacity !== undefined) {
      const flows = [];
      for (const [key, sender] of g.media.senders(directConn.ralRemoteId)) if (sender.active) flows.push({ id: key, kind: sender.info.kind });
      next = directBudgets(capacity, flows, { headroom: g.config.bweHeadroom, audioReserveBps: g.config.audioReserveBps });
    }
    let changed = !next !== !current || (next && current && next.size !== current.size);
    for (const [k, v] of next ?? []) {
      const old = current?.get(k);
      if (old === undefined || Math.abs(v - old) > old * BUDGET_CHANGE) changed = true;
    }
    if (changed) {
      if (next) this.#budgets.set(directConn.ralRemoteId, next);
      else this.#budgets.delete(directConn.ralRemoteId);
      this.l.debug("direct connection budgets", { peer: directConn.ralRemoteId, capacity: capacity && Math.round(capacity), budgets: next && Object.fromEntries(next) });
    }
    const relayChanged = this.#updateRelayBudgets();
    if (changed || relayChanged) g.mediaChanged();
  }

  /** Relay side: minimum budget over destinations per forwarded publication; reports to origins. */
  #updateRelayBudgets() {
    const g = this.#group;
    const byOrigin = new Map();
    for (const [neighborId, budgets] of this.#budgets) {
      for (const [key, bps] of budgets) {
        if (!key.startsWith("fwd:")) continue;
        const [origin, pub] = key.slice(4).split(":");
        if (neighborId === origin) continue;
        let m = byOrigin.get(origin);
        if (!m) byOrigin.set(origin, (m = new Map()));
        if (!m.has(pub)) m.set(pub, []);
        m.get(pub).push(bps);
      }
    }
    const cpu = [...g.directConns.values()].some((l) => l.ralMetrics.cpuLimited);
    let changed = false;
    for (const [origin, pubs] of byOrigin) {
      const budgets = new Map();
      for (const [pub, list] of pubs) budgets.set(pub, Math.round(relayBudget(list) * (cpu ? CPU_BUDGET_FACTOR : 1)));
      const prev = this.#relayBudgets.get(origin);
      if (!prev || [...budgets].some(([k, v]) => prev.get(k) !== v)) changed = true;
      this.#relayBudgets.set(origin, budgets);
      let reporter = this.#reporters.get(origin);
      if (!reporter) this.#reporters.set(origin, (reporter = new BudgetReporter(g.clock, g.config.bweReportIntervalMs, g.config.bweDropReport)));
      if (reporter.due(budgets)) {
        g.directConns.get(origin)?.ralSendCtl({
          t: "bwe",
          flows: [...budgets].map(([pub, bps]) => ({ origin, pub, bps })),
          decode: g.localCaps?.decode ?? {},
          cpu,
        });
      }
    }
    for (const origin of [...this.#relayBudgets.keys()]) if (!byOrigin.has(origin)) this.#relayBudgets.delete(origin);
    return changed;
  }

  /** Origin side: a relay reported budgets for our publications. */
  onBwe(directConn, msg) {
    const m = new Map();
    for (const f of msg.flows ?? []) if (f.origin === this.#group.selfId && typeof f.bps === "number") m.set(f.pub, f.bps);
    this.#reported.set(directConn.ralRemoteId, m);
    this.l.debug("relay budget report", { via: directConn.ralRemoteId, flows: Object.fromEntries(m), cpu: msg.cpu });
    this.#group.media.sync(directConn);
  }

  /** Tells each peer which media kinds we publish to it, when that changed. */
  tick() {
    for (const peer of this.#group.connections.values()) {
      if (!peer.routeInfo) continue;
      const kinds = this.kindsFor(peer.id).sort().join(",");
      if (this.#sentKinds.get(peer.id) === kinds) continue;
      this.#sentKinds.set(peer.id, kinds);
      peer.session.sendControl({ t: "media", kinds: kinds ? kinds.split(",") : [] });
    }
  }

  /** Bitrate this peer forwards for others, in bps (sum of forwarding budgets). */
  relayedBps() {
    let sum = 0;
    for (const [neighborId, budgets] of this.#budgets) {
      const senders = this.#group.media.senders(neighborId);
      for (const [key, bps] of budgets) if (key.startsWith("fwd:") && senders.get(key)?.active) sum += bps;
    }
    return sum;
  }

  /** Budget tables as plain objects, for `group.getStats()`. */
  budgetsSnapshot() {
    const plain = (tables) => Object.fromEntries([...tables].map(([id, b]) => [id, Object.fromEntries(b)]));
    return { direct: plain(this.#budgets), relayed: plain(this.#relayBudgets), reported: plain(this.#reported) };
  }
}
