import { candidates, RouteSelector, chooseStandby, routeKey, relayLoad, usable } from "./planner.js";
import { NeighborTables, buildDirectTable } from "./direct-table.js";
import { DataRelay } from "../relay/data-relay.js";
import { MediaRelay } from "../relay/media-relay.js";
import { randomId } from "../util/ids.js";

const NEIGHBOR_TABLE_MAX_AGE_MS = 10000;
const FLOW_REQUEST_TIMEOUT_MS = 5000;
const REJECT_HOLD_MS = 10000;

const relayRoute = (f) => ({ kind: "relay", via: f.via, flow: f.flow });
const directLiveness = (directConn) => (directConn.ralUsable ? (directConn.ralHealthy ? "ok" : "slow") : "down");

/**
 * Pair route state, on both ends of a pair.
 * @typedef {object} PairState
 * @property {Map<string, {flow: string, via: string, role: "active"|"standby", state: "requested"|"open", since: number, owner: boolean}>} flows
 * @property {RouteSelector} selector
 * @property {number} lastEarlySwitch
 * @property {{route: object, until: number} | null} overlap make-before-break old route
 * @property {Map<string, number>} heard last envelope time per via (relay flows)
 * @property {Map<string, number>} rejected time of the last rejection per relay
 * @property {number} lastSwitch time of the last route switch
 * @property {boolean} ownerSaidDirect
 */

/**
 * Route lifecycle (plan section 7, 8): per-pair route choice with hysteresis, relay flows with a
 * warm standby, failover, make-before-break, and the relay side through `DataRelay`.
 */
export class Routing {
  /** @type {Map<string, PairState>} */
  pairs = new Map();
  neighbors = new NeighborTables();
  #group;
  #lastDirectTable = 0;
  #beatTimer = null;
  #load = 0;
  #appLoad = 0;
  #lastStateFrom = new Map();

  /** @param {object} group */
  constructor(group) {
    this.#group = group;
    this.l = group.log.scope("routing");
    this.relay = new DataRelay(group);
    this.mediaRelay = new MediaRelay(group, this);
    this.#beatTimer = group.clock.setInterval(() => this.#standbyBeats(), group.config.HEARTBEAT_IDLE_MS);
  }

  /** Own relay load figure (plan section 7.3). */
  get load() {
    return this.#load;
  }

  #pair(peerId) {
    let p = this.pairs.get(peerId);
    if (!p) {
      p = {
        flows: new Map(),
        selector: new RouteSelector(this.#group.clock, this.#group.config),
        lastEarlySwitch: -Infinity,
        overlap: null,
        heard: new Map(),
        rejected: new Map(),
        lastSwitch: -Infinity,
        ownerSaidDirect: true,
      };
      this.pairs.set(peerId, p);
    }
    return p;
  }

  #owner(peerId) {
    return this.#group.selfId > peerId;
  }

  // Events --------------------------------------------------------------------------------------

  peerReady(peerId) {
    this.#pair(peerId);
    this.#update(peerId, "hello");
  }

  peerGone(peerId) {
    const p = this.pairs.get(peerId);
    if (p) {
      for (const f of p.flows.values()) this.#group.directConns.get(f.via)?.ralSendCtl({ t: "relay-close", flow: f.flow, origin: this.#group.selfId });
    }
    this.pairs.delete(peerId);
    this.neighbors.delete(peerId);
    this.relay.peerGone(peerId);
    for (const [other, op] of this.pairs) {
      let lost = false;
      for (const [id, f] of op.flows) {
        if (f.via !== peerId) continue;
        op.flows.delete(id);
        lost = true;
      }
      if (lost) this.#update(other, "relay left");
    }
  }

  onDirectRebuilt(peerId) {
    this.#update(peerId, "direct connection rebuilt");
  }

  onDirectOpen(directConn) {
    this.#sendDirectTable(directConn);
    this.mediaRelay.resendSubscriptions(directConn);
    this.#updateAll("direct connection open " + directConn.ralRemoteId);
  }

  onDirectState(peerId, state, reason) {
    const verdict = state === "recovering" || state === "unreachable" || state === "closed" ? "stale" : state === "slow" ? "slow" : "ok";
    this.relay.endChanged(peerId, verdict);
    this.#broadcastDirectTable();
    this.#updateAll(`direct connection ${peerId} ${state}: ${reason}`);
  }

  onMetrics(directConn, m, stats) {
    this.#group.checkProfile();
    this.#computeLoad();
    this.mediaRelay.onMetrics(directConn, m, stats);
  }

  tick() {
    const now = this.#group.clock.now();
    this.neighbors.expire(now, NEIGHBOR_TABLE_MAX_AGE_MS);
    if (now - this.#lastDirectTable >= this.#group.config.directTableIntervalMs) this.#broadcastDirectTable();
    this.#updateAll("tick");
    this.mediaRelay.tick();
  }

  // Direct connection table exchange ------------------------------------------------------------

  #computeLoad() {
    let uplink = 0;
    let cpu = false;
    for (const directConn of this.#group.directConns.values()) {
      if (!directConn.ralCtlOpen) continue;
      uplink += directConn.ralMetrics.bitrate ?? this.#group.config.bweFallbackBps;
      if (directConn.ralMetrics.cpuLimited) cpu = true;
    }
    const relayed = this.relay.rate * 8 + this.mediaRelay.relayedBps();
    this.#load = relayLoad(relayed, uplink, cpu || this.#group.computeLimited, this.#appLoad);
  }

  /** The app reported its own load, see `group.reportLoad`. */
  setAppLoad(value) {
    this.#appLoad = value;
    this.#computeLoad();
  }

  /** This peer's willingness to forward media changed: tells the neighbors and plans again. */
  relayMediaChanged() {
    this.#broadcastDirectTable();
    this.#group.mediaChanged();
    this.#updateAll("relay media changed");
  }

  #broadcastDirectTable() {
    this.#lastDirectTable = this.#group.clock.now();
    for (const directConn of this.#group.directConns.values()) if (directConn.ralCtlOpen) this.#sendDirectTable(directConn);
  }

  #sendDirectTable(directConn) {
    const msg = buildDirectTable(this.#group, this.#load);
    const last = this.#lastStateFrom.get(directConn.ralRemoteId);
    if (last) msg.echo = { ts: last.ts, held: Math.round(this.#group.clock.now() - last.at) };
    directConn.ralSendCtl(msg);
  }

  // Control messages ------------------------------------------------------------------------------

  onCtl(directConn, msg) {
    const g = this.#group;
    switch (msg.t) {
      case "direct-table": {
        const relayedMedia = this.neighbors.get(directConn.ralRemoteId)?.relayMedia;
        this.neighbors.update(directConn.ralRemoteId, msg, g.clock.now());
        if (relayedMedia !== undefined && relayedMedia !== this.neighbors.get(directConn.ralRemoteId).relayMedia) g.mediaChanged();
        if (typeof msg.ts === "number") this.#lastStateFrom.set(directConn.ralRemoteId, { ts: msg.ts, at: g.clock.now() });
        if (msg.echo && typeof msg.echo.ts === "number") directConn.ralNoteControlRtt(g.clock.now() - msg.echo.ts - (msg.echo.held || 0));
        return;
      }
      case "relay-request":
        this.relay.onRequest(directConn, msg);
        return;
      case "relay-accept":
        return this.#onAccept(directConn, msg);
      case "relay-reject":
        return this.#onReject(directConn, msg);
      case "relay-open":
        return this.#onRelayOpen(directConn, msg);
      case "relay-close":
        if (this.relay.flows.size) this.relay.onClose(directConn, msg);
        return this.#onRelayClose(directConn, msg);
      case "standby-activate":
        if (directConn.ralRemoteId === msg.origin) {
          this.relay.onActivate(directConn, msg);
          return;
        }
        return this.#onStandbyActivate(directConn, msg);
      case "route-down":
        return this.#onRouteDown(directConn, msg);
      case "route-slow":
        return this.#onRouteSlow(directConn, msg);
      case "route-use":
        return this.#onRouteUse(directConn, msg);
      case "bwe":
        return this.mediaRelay.onBwe(directConn, msg);
      default:
        this.l.debug("unknown ctl message", { t: msg.t, from: directConn.ralRemoteId });
    }
  }

  onPeerControl(peer, msg) {
    if (msg.t === "route-use") this.#onRouteUse(null, msg, peer.id);
    if (msg.t === "media") this.mediaRelay.onRemoteKinds(peer.id, msg.kinds);
  }

  /** Our own subscription for `origin` changed: tell the origin and the pair's relays. */
  subscriptionChanged(origin) {
    this.mediaRelay.sendSubscription(origin);
    this.#group.mediaChanged();
  }

  // Relay flows (end side) ------------------------------------------------------------------------

  #requestFlow(peerId, via, role) {
    const p = this.#pair(peerId);
    const existing = this.#flowVia(p, via);
    if (existing) return existing;
    const directConn = this.#group.directConns.get(via);
    if (!directConn?.ralUsable) return null;
    const flow = { flow: randomId(8), via, role, state: "requested", since: this.#group.clock.now(), owner: true };
    p.flows.set(flow.flow, flow);
    this.#group.localIndex(directConn, peerId);
    const kinds = this.mediaRelay.kindsFor(peerId);
    directConn.ralSendCtl({ t: "relay-request", flow: flow.flow, origin: this.#group.selfId, target: peerId, role, kinds });
    this.l.info("relay request", { peer: peerId, via, role, flow: flow.flow });
    return flow;
  }

  #closeFlow(peerId, flow, reason) {
    const p = this.pairs.get(peerId);
    if (!p?.flows.delete(flow.flow)) return;
    this.#group.directConns.get(flow.via)?.ralSendCtl({ t: "relay-close", flow: flow.flow, origin: this.#group.selfId });
    this.l.info("relay flow closed", { peer: peerId, via: flow.via, flow: flow.flow, reason });
    this.#group.mediaChanged();
  }

  #flowVia(p, via) {
    for (const f of p.flows.values()) if (f.via === via) return f;
    return undefined;
  }

  /** True when the pair with `peerId` has a relay flow through `via`. */
  hasFlowVia(peerId, via) {
    const p = this.pairs.get(peerId);
    return !!p && !!this.#flowVia(p, via);
  }

  #findFlow(flowId) {
    for (const [peerId, p] of this.pairs) {
      const f = p.flows.get(flowId);
      if (f) return [peerId, p, f];
    }
    return [];
  }

  #onAccept(directConn, msg) {
    const [peerId, , f] = this.#findFlow(msg.flow);
    if (!f || f.via !== directConn.ralRemoteId) return;
    f.state = "open";
    f.since = this.#group.clock.now();
    this.l.info("relay accepted", { peer: peerId, via: f.via, role: f.role });
    this.mediaRelay.sendSubscription(peerId);
    this.#group.mediaChanged();
    this.#update(peerId, "relay accepted");
  }

  #onReject(directConn, msg) {
    const [peerId, p, f] = this.#findFlow(msg.flow);
    if (!f || f.via !== directConn.ralRemoteId) return;
    p.flows.delete(f.flow);
    p.rejected.set(f.via, this.#group.clock.now());
    this.l.info("relay rejected", { peer: peerId, via: f.via, reason: msg.reason });
    this.#update(peerId, "relay rejected");
  }

  #onRelayOpen(directConn, msg) {
    const g = this.#group;
    const origin = msg.origin;
    if (!g.connections.has(origin) || !g.helloDone(origin)) {
      directConn.ralSendCtl({ t: "relay-close", flow: msg.flow, origin });
      return;
    }
    const p = this.#pair(origin);
    const existing = p.flows.get(msg.flow);
    const f = existing ?? { flow: msg.flow, via: directConn.ralRemoteId, role: "standby", state: "open", since: g.clock.now(), owner: false };
    f.role = msg.role === "active" ? "active" : "standby";
    f.state = "open";
    p.flows.set(f.flow, f);
    p.heard.set(f.via, g.clock.now());
    this.l.info("relay open", { peer: origin, via: f.via, role: f.role });
    this.mediaRelay.sendSubscription(origin);
    if (f.role === "active") {
      for (const other of p.flows.values()) if (other !== f && other.role === "active") other.role = "standby";
      p.ownerSaidDirect = false;
      this.#use(origin, relayRoute(f), "owner chose relay");
    }
    this.#group.mediaChanged();
    this.#update(origin, "relay open");
  }

  #onRelayClose(directConn, msg) {
    const [peerId, , f] = this.#findFlow(msg.flow);
    if (!f || f.via !== directConn.ralRemoteId) return;
    this.pairs.get(peerId).flows.delete(f.flow);
    this.l.info("relay closed", { peer: peerId, via: f.via });
    this.#group.mediaChanged();
    this.#update(peerId, "relay closed");
  }

  #onStandbyActivate(directConn, msg) {
    const [peerId, p, f] = this.#findFlow(msg.flow);
    if (!f || f.via !== directConn.ralRemoteId) return;
    for (const other of p.flows.values()) if (other.role === "active") other.role = "standby";
    f.role = "active";
    p.ownerSaidDirect = false;
    this.l.info("standby activated by owner", { peer: peerId, via: f.via });
    this.#use(peerId, relayRoute(f), "standby activated");
    this.#group.mediaChanged();
  }

  #onRouteDown(directConn, msg) {
    const peerId = msg.origin;
    const p = this.pairs.get(peerId);
    if (!p) return;
    this.l.info("route-down", { peer: peerId, via: directConn.ralRemoteId });
    let changed = false;
    for (const f of p.flows.values()) {
      if (f.via !== directConn.ralRemoteId) continue;
      f.down = true;
      changed = true;
    }
    if (changed) this.#failover(peerId, `route-down from ${directConn.ralRemoteId}`, directConn.ralRemoteId);
  }

  #onRouteSlow(directConn, msg) {
    const peerId = msg.origin;
    const peer = this.#group.connections.get(peerId);
    const r = peer?.routeInfo;
    if (r?.kind !== "relay" || r.via !== directConn.ralRemoteId) return;
    this.l.info("route-slow", { peer: peerId, via: directConn.ralRemoteId });
    this.#earlySwitch(peerId, "route-slow");
  }

  #onRouteUse(directConn, msg, fromPeer) {
    const peerId = fromPeer ?? directConn?.ralRemoteId;
    const p = this.pairs.get(peerId);
    if (!p || this.#owner(peerId)) return;
    if (msg.kind === "direct") {
      p.ownerSaidDirect = true;
      this.#update(peerId, "owner chose direct");
    }
  }

  /** True when envelopes from `src` may arrive relayed through `via`. Records arrival time. */
  acceptsRelayed(src, via) {
    const p = this.pairs.get(src);
    if (!p) return false;
    for (const f of p.flows.values()) {
      if (f.via === via) {
        p.heard.set(via, this.#group.clock.now());
        return true;
      }
    }
    return false;
  }

  forward(directConn, src, dst, bytes, e, key) {
    this.relay.forward(directConn, src, dst, bytes, e, key);
  }

  // Liveness of relayed routes ------------------------------------------------------------------

  onE2ELiveness(peer, state, silence) {
    const r = peer.routeInfo;
    if (r?.kind !== "relay") return;
    this.l.info(`end to end liveness ${state}`, { peer: peer.id, via: r.via, silenceMs: Math.round(silence) });
    if (state === "slow") this.#earlySwitch(peer.id, "end to end slow");
    else if (state === "stale") this.#failover(peer.id, "end to end stale", r.via);
    else this.#update(peer.id, "end to end ok");
  }

  #standbyBeats() {
    for (const [peerId, p] of this.pairs) {
      const peer = this.#group.connections.get(peerId);
      if (!peer) continue;
      const active = peer.routeInfo;
      for (const f of p.flows.values()) {
        if (f.state !== "open" || (active?.kind === "relay" && active.flow === f.flow)) continue;
        peer.beatOn(relayRoute(f));
      }
    }
  }

  #fresh(p, via) {
    const at = p.heard.get(via);
    return at !== undefined && this.#group.clock.now() - at < this.#group.config.SLOW_CONNECTION_MS;
  }

  #standbyOf(peerId) {
    const p = this.pairs.get(peerId);
    const active = this.#group.connections.get(peerId)?.routeInfo;
    if (!p) return null;
    for (const f of p.flows.values()) {
      if (f.state !== "open" || f.down || (active?.kind === "relay" && active.flow === f.flow)) continue;
      if (!this.#group.directConns.get(f.via)?.ralUsable) continue;
      return f;
    }
    return null;
  }

  #earlySwitch(peerId, reason) {
    const p = this.pairs.get(peerId);
    const g = this.#group;
    if (!p) return;
    const now = g.clock.now();
    const standby = this.#standbyOf(peerId);
    if (!standby || !this.#fresh(p, standby.via)) return;
    if (now - p.lastEarlySwitch < g.config.earlySwitchIntervalMs) {
      this.l.info("early switch suppressed", { peer: peerId, reason });
      return;
    }
    p.lastEarlySwitch = now;
    this.#activate(peerId, standby, `early switch: ${reason}`);
  }

  #failover(peerId, reason, deadVia) {
    const p = this.pairs.get(peerId);
    if (!p) return;
    const standby = this.#standbyOf(peerId);
    if (standby && standby.via !== deadVia) {
      this.#activate(peerId, standby, `failover: ${reason}`);
      return;
    }
    const peer = this.#group.connections.get(peerId);
    const r = peer?.routeInfo;
    if (r?.kind === "relay" && r.via === deadVia) {
      peer.setRoute(null, reason);
      if (this.#owner(peerId)) {
        const f = p.flows.get(r.flow);
        if (f) this.#closeFlow(peerId, f, reason);
        p.selector.force(null);
      }
    }
    this.#update(peerId, reason);
  }

  #activate(peerId, flow, reason) {
    const p = this.pairs.get(peerId);
    const g = this.#group;
    for (const f of p.flows.values()) if (f.role === "active" && f !== flow) f.role = "standby";
    flow.role = "active";
    if (this.#owner(peerId)) {
      g.directConns.get(flow.via)?.ralSendCtl({ t: "standby-activate", flow: flow.flow, origin: g.selfId });
      p.selector.force({ kind: "relay", via: flow.via, cls: 1, cost: 0 });
    }
    this.#use(peerId, relayRoute(flow), reason, false);
    g.mediaChanged();
  }

  // Route choice ----------------------------------------------------------------------------------

  #updateAll(reason) {
    for (const peerId of this.pairs.keys()) this.#update(peerId, reason);
  }

  #candidates(peerId) {
    const g = this.#group;
    const directConn = g.directConns.get(peerId);
    const direct = directConn ? { ...directConn.ralMetrics, state: directLiveness(directConn), candidateType: directConn.ralViaTurn ? "relay" : directConn.ralMetrics.candidateType } : undefined;
    const neighbors = new Map();
    const now = g.clock.now();
    const p = this.pairs.get(peerId);
    for (const via of this.neighbors.keys()) {
      if (via === peerId) continue;
      const viaConn = g.directConns.get(via);
      const t = this.neighbors.get(via);
      if (!viaConn || !t) continue;
      if (p?.rejected.has(via) && now - p.rejected.get(via) < REJECT_HOLD_MS) continue;
      neighbors.set(via, {
        toNeighbor: { ...viaConn.ralMetrics, state: directLiveness(viaConn) },
        table: t.table,
        load: t.load,
        relay: t.relay,
        mediaRelay: t.mediaRelay,
        relayMedia: t.relayMedia,
        major: g.connections.get(via)?.remote?.proto?.major ?? this.#group.protocol.major,
        caps: g.connections.get(via)?.remote?.caps,
      });
    }
    const caps = { [g.selfId]: g.localCaps, [peerId]: g.connections.get(peerId)?.remote?.caps };
    return candidates({
      target: peerId,
      direct,
      neighbors,
      media: this.mediaRelay.pairHasMedia(peerId),
      maxRelayLoad: g.config.maxRelayLoad,
      major: this.#group.protocol.major,
      caps,
      self: g.selfId,
      mediaPolicy: (id) => (id === g.selfId ? g.config.mediaRelay : g.connections.get(id)?.remote?.mediaRelay ?? "allow"),
    });
  }

  #update(peerId, reason) {
    const g = this.#group;
    const peer = g.connections.get(peerId);
    const p = this.pairs.get(peerId);
    if (!peer || !p || peer.state === "closed" || !g.helloDone(peerId)) return;
    if (peer.hint === "protocol-mismatch") return;
    const now = g.clock.now();
    for (const [id, f] of p.flows) {
      if (f.state === "requested" && now - f.since > FLOW_REQUEST_TIMEOUT_MS) {
        p.flows.delete(id);
        this.l.info("relay request timed out", { peer: peerId, via: f.via });
      } else if (f.state === "open" && !g.directConns.get(f.via)?.ralUsable) {
        f.down = true;
      } else if (f.down && g.directConns.get(f.via)?.ralHealthy && this.#fresh(p, f.via)) {
        f.down = false;
      }
    }
    if (p.overlap && now >= p.overlap.until) p.overlap = null;
    if (this.#owner(peerId)) this.#ownerDecide(peerId, p, reason);
    else this.#followerDecide(peerId, p, reason);
    this.#refreshState(peer, p);
  }

  #ownerDecide(peerId, p, reason) {
    const g = this.#group;
    const peer = g.connections.get(peerId);
    const list = this.#candidates(peerId);
    const current = peer.routeInfo;
    if (current?.kind === "relay") {
      const f = p.flows.get(current.flow);
      if (!f || f.down) {
        const standby = this.#standbyOf(peerId);
        if (standby) return this.#activate(peerId, standby, "active relay down");
      }
    }
    let { route: best } = p.selector.decide(list);
    const sinceSwitch = g.clock.now() - p.lastSwitch;
    if (best && current?.kind === "relay" && best.kind === "relay" && best.via !== current.via && sinceSwitch < g.config.earlySwitchIntervalMs) {
      const cur = list.find((c) => c.kind === "relay" && c.via === current.via);
      if (cur) {
        p.selector.force(cur);
        best = cur;
      }
    }
    if (!best) {
      if (current) peer.setRoute(null, "no route");
      this.#tidyFlows(peerId, p, null, list);
      return;
    }
    if (best.kind === "direct") {
      if (current?.kind !== "direct") {
        const directConn = g.directConns.get(peerId);
        directConn?.ralSendCtl({ t: "route-use", kind: "direct" });
        this.#use(peerId, { kind: "direct" }, `planner: ${reason}`);
      }
      this.#tidyFlows(peerId, p, best, list);
      return;
    }
    let flow = this.#flowVia(p, best.via);
    if (!flow) flow = this.#requestFlow(peerId, best.via, "active");
    if (!flow || flow.state !== "open" || flow.down) {
      this.#tidyFlows(peerId, p, best, list);
      return;
    }
    if (current?.kind !== "relay" || current.flow !== flow.flow) {
      if (flow.role !== "active") this.#activate(peerId, flow, `planner: ${reason}`);
      else this.#use(peerId, relayRoute(flow), `planner: ${reason}`);
    }
    this.#tidyFlows(peerId, p, best, list);
  }

  #tidyFlows(peerId, p, best, list) {
    const peer = this.#group.connections.get(peerId);
    const active = peer.routeInfo;
    const overlapFlow = p.overlap?.route?.flow;
    if (!best || best.kind === "direct") {
      if (active?.kind === "direct") {
        for (const f of [...p.flows.values()]) if (f.flow !== overlapFlow && f.owner) this.#closeFlow(peerId, f, "direct route in use");
      }
      return;
    }
    const activeVia = active?.kind === "relay" ? active.via : best.via;
    const kept = [...p.flows.values()].find((f) => f.owner && f.via !== activeVia && f.state === "open" && !f.down && this.#group.directConns.get(f.via)?.ralUsable);
    const standby = kept ? { kind: "relay", via: kept.via } : chooseStandby(list, { kind: "relay", via: activeVia });
    for (const f of [...p.flows.values()]) {
      if (!f.owner || f.flow === overlapFlow) continue;
      const isActive = active?.kind === "relay" && active.flow === f.flow;
      const isBest = f.via === best.via;
      const isStandby = standby && f.via === standby.via;
      if (!isActive && !isBest && !isStandby && f.state === "open") this.#closeFlow(peerId, f, "not needed");
    }
    if (standby && active?.kind === "relay" && !this.#flowVia(p, standby.via)) {
      this.#requestFlow(peerId, standby.via, "standby");
    }
  }

  #followerDecide(peerId, p) {
    const g = this.#group;
    const peer = g.connections.get(peerId);
    const current = peer.routeInfo;
    const directConn = g.directConns.get(peerId);
    if (current?.kind === "relay") {
      const f = p.flows.get(current.flow);
      if (f && !f.down && g.directConns.get(f.via)?.ralUsable) return;
      const standby = this.#standbyOf(peerId);
      if (standby) return this.#use(peerId, relayRoute(standby), "active relay down (follower)");
      if (directConn?.ralUsable) return this.#use(peerId, { kind: "direct" }, "relay down, direct usable");
      peer.setRoute(null, "relay down");
      return;
    }
    if (current?.kind === "direct" && directConn?.ralUsable) {
      if (!p.ownerSaidDirect) {
        const active = [...p.flows.values()].find((f) => f.role === "active" && f.state === "open" && !f.down);
        if (active) this.#use(peerId, relayRoute(active), "owner uses relay");
      }
      return;
    }
    if (directConn?.ralUsable && (p.ownerSaidDirect || ![...p.flows.values()].some((f) => f.state === "open" && !f.down))) {
      return this.#use(peerId, { kind: "direct" }, "direct usable");
    }
    const f = [...p.flows.values()].find((x) => x.role === "active" && x.state === "open" && !x.down && g.directConns.get(x.via)?.ralUsable) ?? this.#standbyOf(peerId);
    if (f) return this.#use(peerId, relayRoute(f), "relay available (follower)");
    if (current) peer.setRoute(null, "no route");
  }

  #use(peerId, route, reason, overlap = true) {
    const g = this.#group;
    const peer = g.connections.get(peerId);
    const p = this.pairs.get(peerId);
    const prev = peer.routeInfo;
    if (prev && routeKey(prev) === routeKey(route) && prev.flow === route.flow) return;
    const prevHop = prev?.kind === "relay" ? g.directConns.get(prev.via) : undefined;
    if (overlap && prevHop?.ralUsable) {
      const rtt = (prevHop.ralMetrics.rtt ?? 0) * 2;
      p.overlap = { route: prev, until: g.clock.now() + Math.max(g.config.switchOverlapMinMs, rtt) };
    } else {
      p.overlap = null;
    }
    peer.setRoute(route, reason);
    p.lastSwitch = g.clock.now();
    g.media.streams.reselect(peerId);
    g.mediaChanged();
    this.#refreshState(peer, p);
  }

  /** Make-before-break: routes that carry traffic in addition to the active one. */
  extraRoutes(peer) {
    const p = this.pairs.get(peer.id);
    if (!p?.overlap) return [];
    if (this.#group.clock.now() >= p.overlap.until) {
      p.overlap = null;
      return [];
    }
    return [p.overlap.route];
  }

  #refreshState(peer, p) {
    const g = this.#group;
    const r = peer.routeInfo;
    const directConn = g.directConns.get(peer.id);
    if (r?.kind === "direct" && directConn) {
      if (directConn.ralHealthy) return peer.setState("connected", "direct");
      if (directConn.ralUsable) return peer.setState("slow", "direct connection slow");
    }
    if (r?.kind === "relay") {
      const e2e = peer.e2e.state;
      const hop = g.directConns.get(r.via);
      if (hop?.ralUsable && e2e !== "stale") {
        if (e2e === "ok" && hop.ralHealthy) return peer.setState("connected", `relay via ${r.via}`);
        return peer.setState("slow", `relay via ${r.via} slow`);
      }
    }
    const hasRelayOption = [...(p?.flows.values() ?? [])].some((f) => f.state === "open" && !f.down) || this.#candidates(peer.id).length > 0;
    if (peer.directState === "unreachable" && !hasRelayOption) {
      peer.lastError = peer.directError;
      peer.hint = peer.directHint;
      return peer.setState("unreachable", peer.directError ?? "no route");
    }
    peer.setState(peer.everConnected ? "reconnecting" : "connecting", peer.directStarted ? `direct connection ${peer.directState}` : "no direct connection");
  }

  // Queries -------------------------------------------------------------------------------------

  /** A neighbor with a live direct connection to `target`, for mesh signaling. */
  relayFor(target) {
    for (const via of this.neighbors.keys()) {
      if (via === target) continue;
      const directConn = this.#group.directConns.get(via);
      if (directConn?.ralHealthy && usable(this.neighbors.entry(via, target))) return via;
    }
    return undefined;
  }

  /** True when TURN may be added for the pair: TURN configured and no peer relay route. */
  canAddTurn(peerId) {
    const g = this.#group;
    if (g.config.turnMode !== "fallback" || !g.hasTurn) return false;
    return !this.#candidates(peerId).some((c) => c.kind === "relay");
  }

  /** Smallest message size along a route. */
  pathMessageSize(route) {
    const g = this.#group;
    if (route.kind === "direct") return 65536;
    const hop1 = g.directConns.get(route.via)?.ralMaxMessageSize ?? 65536;
    let hop2 = 65536;
    for (const [peerId, p] of this.pairs) {
      if (p.flows.has(route.flow)) hop2 = this.neighbors.entry(route.via, peerId)?.mms ?? 65536;
    }
    return Math.min(hop1, hop2);
  }

  /** Statistics for `group.getStats()`. */
  stats() {
    const g = this.#group;
    const directConns = {};
    for (const [id, c] of g.connections) {
      const d = c.directConn;
      if (c.directStarted) directConns[id] = { state: c.directState, liveness: d?.ralLiveness, session: d?.ralSession, metrics: d?.ralMetrics, bufferedAmount: d?.ralBufferedAmount ?? 0 };
    }
    const peers = {};
    for (const [id, peer] of g.connections) {
      const p = this.pairs.get(id);
      peers[id] = {
        state: peer.state,
        route: peer.route,
        e2e: peer.e2e.state,
        flows: p ? [...p.flows.values()].map((f) => ({ flow: f.flow, via: f.via, role: f.role, state: f.state, down: !!f.down })) : [],
        unackedBytes: peer.session.unackedBytes,
      };
    }
    return { selfId: g.selfId, load: this.#load, relayFlows: this.relay.list(), directConns, peers, budgets: this.mediaRelay.budgetsSnapshot() };
  }

  close() {
    this.#group.clock.clearInterval(this.#beatTimer);
    this.relay.close();
  }
}
