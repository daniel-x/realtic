/**
 * Route planning (plan section 7.2, 7.3). Pure logic over direct connection metrics; the routing
 * layer feeds it the local direct connection table and the neighbors' tables.
 */

/** Route classes in strict order of preference. */
export const CLASS = Object.freeze({ DIRECT: 0, PEER_RELAY: 1, TURN: 2 });

/**
 * Metrics of one direct connection.
 * @typedef {object} DirectMetrics
 * @property {"ok"|"slow"|"stale"|"down"} state liveness verdict, "down" without an open direct connection
 * @property {number} [rtt] round trip time in ms
 * @property {number} [bitrate] available outgoing bitrate in bps
 * @property {number} [loss] fraction 0..1
 * @property {"host"|"srflx"|"prflx"|"relay"} [candidateType] local candidate type of the selected pair
 */

/**
 * What a neighbor told us about itself in `direct-table`.
 * @typedef {object} NeighborInfo
 * @property {DirectMetrics} toNeighbor our own direct connection to the neighbor
 * @property {Map<string, DirectMetrics>} table the neighbor's direct connections, by peer id
 * @property {number} load relay load figure
 * @property {boolean} relay whether it relays
 * @property {"allow"|"never"} mediaRelay
 * @property {number} [major] protocol major version
 * @property {object} [caps] codec capabilities from hello
 */

/**
 * A candidate route.
 * @typedef {object} Candidate
 * @property {"direct"|"relay"} kind
 * @property {string} [via]
 * @property {number} cls
 * @property {number} cost
 */

const LOSS_PENALTY_MS = 500;
const BITRATE_PENALTY_MS = 200;
const LOAD_PENALTY_MS = 150;
const SLOW_PENALTY_MS = 400;
const DEFAULT_RTT = 100;

/** True when a direct connection can carry a new route. */
export function usable(m) {
  return !!m && (m.state === "ok" || m.state === "slow");
}

function hopCost(m, needBps) {
  let cost = m.rtt ?? DEFAULT_RTT;
  cost += (m.loss ?? 0) * LOSS_PENALTY_MS;
  if (m.state === "slow") cost += SLOW_PENALTY_MS;
  if (needBps && m.bitrate != null && m.bitrate < needBps) cost += BITRATE_PENALTY_MS * (1 - m.bitrate / needBps);
  return cost;
}

/**
 * True when some codec of `kind` can go origin -> relay (decode) -> target (relay encodes).
 * Missing capability data counts as compatible.
 */
export function codecPathOk(origin, relay, target, kind) {
  const send = origin?.send?.[kind];
  const relayRecv = relay?.recv?.[kind];
  const relaySend = relay?.send?.[kind];
  const recv = target?.recv?.[kind];
  const meets = (a, b) => !a || !b || a.some((c) => b.includes(c));
  return meets(send, relayRecv) && meets(relaySend, recv);
}

/**
 * Lists route candidates from self to target, best first.
 * @param {object} input
 * @param {string} input.target
 * @param {DirectMetrics} [input.direct]
 * @param {Map<string, NeighborInfo>} input.neighbors
 * @param {number} [input.needBps] bitrate the pair's flows need
 * @param {boolean} [input.media] whether the pair exchanges media
 * @param {number} input.maxRelayLoad
 * @param {number} input.major our protocol major version
 * @param {object} [input.caps] map of peer id to codec capabilities
 * @param {string} [input.self]
 * @param {(id: string) => ("allow"|"never")} [input.mediaPolicy] media relay policy of an end
 * @returns {Candidate[]}
 */
export function candidates({ target, direct, neighbors, needBps = 0, media = false, maxRelayLoad, major, caps = {}, self, mediaPolicy }) {
  const out = [];
  if (usable(direct)) {
    const cls = direct.candidateType === "relay" ? CLASS.TURN : CLASS.DIRECT;
    out.push({ kind: "direct", cls, cost: hopCost(direct, needBps) });
  }
  for (const [via, n] of neighbors) {
    if (via === target || !n.relay || !usable(n.toNeighbor)) continue;
    if (n.major !== undefined && n.major !== major) continue;
    const hop2 = n.table.get(target);
    if (!usable(hop2) || hop2.candidateType === "relay") continue;
    if (n.load > maxRelayLoad) continue;
    if (media) {
      if (n.mediaRelay === "never" || mediaPolicy?.(self) === "never" || mediaPolicy?.(target) === "never") continue;
      const ok = ["video", "audio"].every(
        (k) => codecPathOk(caps[self], n.caps, caps[target], k) && codecPathOk(caps[target], n.caps, caps[self], k),
      );
      if (!ok) continue;
    }
    const bottleneck = Math.min(n.toNeighbor.bitrate ?? Infinity, hop2.bitrate ?? Infinity);
    const cost =
      hopCost({ ...n.toNeighbor, bitrate: bottleneck }, needBps) +
      hopCost({ ...hop2, bitrate: bottleneck }, 0) +
      n.load * LOAD_PENALTY_MS;
    out.push({ kind: "relay", via, cls: CLASS.PEER_RELAY, cost });
  }
  return out.sort((a, b) => a.cls - b.cls || a.cost - b.cost || (a.via ?? "").localeCompare(b.via ?? ""));
}

/** Key of a candidate, equal for the same route. */
export function routeKey(c) {
  return c ? (c.kind === "direct" ? "direct" : `relay:${c.via}`) : "none";
}

/**
 * Per-pair route choice with hysteresis (section 7.2). `decide()` returns the route to use now.
 */
export class RouteSelector {
  #current = null;
  #challenger = null;
  #since = 0;

  /**
   * @param {{now: () => number}} clock
   * @param {{switchThreshold: number, switchHoldMs: number}} options
   */
  constructor(clock, { switchThreshold, switchHoldMs }) {
    this.clock = clock;
    this.switchThreshold = switchThreshold;
    this.switchHoldMs = switchHoldMs;
  }

  /** The route in use. */
  get current() {
    return this.#current;
  }

  /** Sets the current route without hysteresis, e.g. after a failover. */
  force(c) {
    this.#current = c;
    this.#challenger = null;
  }

  /**
   * @param {Candidate[]} list candidates, best first
   * @returns {{route: Candidate|null, changed: boolean}}
   */
  decide(list) {
    const now = this.clock.now();
    const best = list[0] ?? null;
    const cur = this.#current && list.find((c) => routeKey(c) === routeKey(this.#current));
    if (!cur) {
      const changed = routeKey(best) !== routeKey(this.#current);
      this.#current = best;
      this.#challenger = null;
      return { route: best, changed };
    }
    this.#current = cur;
    if (!best || routeKey(best) === routeKey(cur)) {
      this.#challenger = null;
      return { route: cur, changed: false };
    }
    const better = best.cls < cur.cls || best.cost < cur.cost * (1 - this.switchThreshold);
    if (!better) {
      this.#challenger = null;
      return { route: cur, changed: false };
    }
    if (routeKey(this.#challenger) !== routeKey(best)) {
      this.#challenger = best;
      this.#since = now;
    }
    if (now - this.#since < this.switchHoldMs) return { route: cur, changed: false };
    this.#current = best;
    this.#challenger = null;
    return { route: best, changed: true };
  }
}

/**
 * Picks the standby relay: the best relay candidate other than the active route's relay.
 * @param {Candidate[]} list
 * @param {Candidate|null} active
 */
export function chooseStandby(list, active) {
  return list.find((c) => c.kind === "relay" && routeKey(c) !== routeKey(active)) ?? null;
}

/**
 * Relay load figure (section 7.3): relayed bitrate over the measured uplink, plus a CPU term.
 * @param {number} relayedBps
 * @param {number} uplinkBps
 * @param {boolean} cpuLimited
 */
export function relayLoad(relayedBps, uplinkBps, cpuLimited) {
  const base = uplinkBps > 0 ? relayedBps / uplinkBps : relayedBps > 0 ? 1 : 0;
  return Math.round((base + (cpuLimited ? 0.3 : 0)) * 1000) / 1000;
}
