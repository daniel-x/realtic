/** True when a link can carry a new route. */
export function usable(m: any): boolean;
/**
 * True when some codec of `kind` can go origin -> relay (decode) -> target (relay encodes).
 * Missing capability data counts as compatible.
 */
export function codecPathOk(origin: any, relay: any, target: any, kind: any): any;
/**
 * Lists route candidates from self to target, best first.
 * @param {object} input
 * @param {string} input.target
 * @param {LinkMetrics} [input.direct]
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
export function candidates({ target, direct, neighbors, needBps, media, maxRelayLoad, major, caps, self, mediaPolicy }: {
    target: string;
    direct?: LinkMetrics;
    neighbors: Map<string, NeighborInfo>;
    needBps?: number;
    media?: boolean;
    maxRelayLoad: number;
    major: number;
    caps?: object;
    self?: string;
    mediaPolicy?: (id: string) => ("allow" | "never");
}): Candidate[];
/** Key of a candidate, equal for the same route. */
export function routeKey(c: any): string;
/**
 * Picks the standby relay: the best relay candidate other than the active route's relay.
 * @param {Candidate[]} list
 * @param {Candidate|null} active
 */
export function chooseStandby(list: Candidate[], active: Candidate | null): Candidate;
/**
 * Relay load figure (section 7.3): relayed bitrate over the measured uplink, plus a CPU term.
 * @param {number} relayedBps
 * @param {number} uplinkBps
 * @param {boolean} cpuLimited
 */
export function relayLoad(relayedBps: number, uplinkBps: number, cpuLimited: boolean): number;
/**
 * Route planning (plan section 7.2, 7.3). Pure logic over link metrics; the routing layer feeds
 * it the local link table and the neighbors' tables.
 */
/** Route classes in strict order of preference. */
export const CLASS: Readonly<{
    DIRECT: 0;
    PEER_RELAY: 1;
    TURN: 2;
}>;
/**
 * Per-pair route choice with hysteresis (section 7.2). `decide()` returns the route to use now.
 */
export class RouteSelector {
    /**
     * @param {{now: () => number}} clock
     * @param {{switchThreshold: number, switchHoldMs: number}} options
     */
    constructor(clock: {
        now: () => number;
    }, { switchThreshold, switchHoldMs }: {
        switchThreshold: number;
        switchHoldMs: number;
    });
    clock: {
        now: () => number;
    };
    switchThreshold: number;
    switchHoldMs: number;
    /** The route in use. */
    get current(): any;
    /** Sets the current route without hysteresis, e.g. after a failover. */
    force(c: any): void;
    /**
     * @param {Candidate[]} list candidates, best first
     * @returns {{route: Candidate|null, changed: boolean}}
     */
    decide(list: Candidate[]): {
        route: Candidate | null;
        changed: boolean;
    };
    #private;
}
/**
 * Metrics of one direct link.
 */
export type LinkMetrics = {
    /**
     * liveness verdict, "down" without an open link
     */
    state: "ok" | "slow" | "stale" | "down";
    /**
     * round trip time in ms
     */
    rtt?: number;
    /**
     * available outgoing bitrate in bps
     */
    bitrate?: number;
    /**
     * fraction 0..1
     */
    loss?: number;
    /**
     * local candidate type of the selected pair
     */
    candidateType?: "host" | "srflx" | "prflx" | "relay";
};
/**
 * What a neighbor told us about itself in `link-state`.
 */
export type NeighborInfo = {
    /**
     * our own link to the neighbor
     */
    link: LinkMetrics;
    /**
     * the neighbor's links, by peer id
     */
    table: Map<string, LinkMetrics>;
    /**
     * relay load figure
     */
    load: number;
    /**
     * whether it relays
     */
    relay: boolean;
    mediaRelay: "allow" | "never";
    /**
     * protocol major version
     */
    major?: number;
    /**
     * codec capabilities from hello
     */
    caps?: object;
};
/**
 * A candidate route.
 */
export type Candidate = {
    kind: "direct" | "relay";
    via?: string;
    cls: number;
    cost: number;
};
