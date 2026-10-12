/**
 * Pair route state, on both ends of a pair.
 * @typedef {object} PairState
 * @property {Map<string, {flow: string, via: string, role: "active"|"standby", state: "requested"|"open", since: number, owner: boolean}>} flows
 * @property {RouteSelector} selector
 * @property {number} lastEarlySwitch
 * @property {{route: object, until: number} | null} overlap make-before-break old route
 * @property {Map<string, number>} heard last envelope time per via (relay flows)
 * @property {boolean} ownerSaidDirect
 */
/**
 * Route lifecycle (plan section 7, 8): per-pair route choice with hysteresis, relay flows with a
 * warm standby, failover, make-before-break, and the relay side through `DataRelay`.
 */
export class Routing {
    /** @param {object} group */
    constructor(group: object);
    /** @type {Map<string, PairState>} */
    pairs: Map<string, PairState>;
    neighbors: NeighborTables;
    l: any;
    relay: DataRelay;
    mediaRelay: MediaRelay;
    /** Own relay load figure (plan section 7.3). */
    get load(): number;
    peerReady(peerId: any): void;
    peerGone(peerId: any): void;
    linkRebuilt(peerId: any): void;
    linkOpen(link: any): void;
    linkState(link: any, state: any, reason: any): void;
    onMetrics(link: any): void;
    onMidMap(link: any, msg: any): void;
    onDrain(): void;
    tick(): void;
    onCtl(link: any, msg: any): void;
    onPeerControl(peer: any, msg: any): void;
    onSubscription(link: any, msg: any): void;
    /** Our own subscription for `origin` changed: tell the origin and the pair's relays. */
    subscriptionChanged(origin: any): void;
    /** True when envelopes from `src` may arrive relayed through `via`. Records arrival time. */
    acceptsRelayed(src: any, via: any): boolean;
    forward(link: any, src: any, dst: any, bytes: any, e: any, key: any): void;
    onE2ELiveness(peer: any, state: any, silence: any): void;
    /** Make-before-break: routes that carry traffic in addition to the active one. */
    extraRoutes(peer: any): any[];
    /** A neighbor with a live link to `target`, for mesh signaling. */
    relayFor(target: any): any;
    /** True when TURN may be added for the pair: TURN configured and no peer relay route. */
    canAddTurn(peerId: any): boolean;
    /** Smallest message size along a route. */
    pathMessageSize(route: any): number;
    /** True when the pair exchanges media (for capability-aware relay choice). */
    pairMedia(peerId: any): boolean;
    mediaPlan(link: any): {
        key: string;
        info: any;
        track: any;
        active: boolean;
    }[];
    receivedSource(link: any, info: any, track: any): void;
    receivedSourceGone(link: any, info: any): void;
    forwardedSourcesGone(linkId: any): void;
    /** Statistics for `group.getStats()`. */
    stats(): {
        selfId: any;
        load: number;
        relayFlows: {
            flow: any;
            origin: any;
            target: any;
            role: any;
            kinds: any;
        }[];
        links: {};
        peers: {};
        budgets: {
            links: {};
            relayed: {};
            reported: {};
        };
    };
    close(): void;
    #private;
}
/**
 * Pair route state, on both ends of a pair.
 */
export type PairState = {
    flows: Map<string, {
        flow: string;
        via: string;
        role: "active" | "standby";
        state: "requested" | "open";
        since: number;
        owner: boolean;
    }>;
    selector: RouteSelector;
    lastEarlySwitch: number;
    /**
     * make-before-break old route
     */
    overlap: {
        route: object;
        until: number;
    } | null;
    /**
     * last envelope time per via (relay flows)
     */
    heard: Map<string, number>;
    ownerSaidDirect: boolean;
};
import { NeighborTables } from "./link-state.js";
import { DataRelay } from "../relay/data-relay.js";
import { MediaRelay } from "../relay/media-relay.js";
import { RouteSelector } from "./planner.js";
