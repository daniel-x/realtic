/**
 * Media planning per link (plan section 10.2, 10.4, 7.2a).
 *
 * Own publications go to a neighbor when the pair route is direct, and to a relay neighbor when a
 * relay flow of a target runs through it: active for the active flow, inactive (prepared slot) for
 * a standby flow. On a relay, received tracks of an origin go to the far ends of accepted flows,
 * active only for active flows and wanted subscriptions. Unsubscribed flows stop at their source:
 * a relay tells the origin the subscriptions of the ends behind it.
 *
 * Bandwidth: each link splits its estimate into per-flow budgets. A relay reports to the origin
 * the minimum budget of its destination hops per forwarded publication and encodes all outputs
 * at that minimum (decision D3).
 */
export class MediaRelay {
    constructor(group: any, routing: any);
    /** subscriber id -> Map<origin, subscription> */
    subs: Map<any, any>;
    l: any;
    /** Subscription of `subscriber` for `origin`'s media (undefined: everything). */
    subscription(subscriber: any, origin: any): any;
    /**
     * Handles `subscription` from a neighbor: stores it and, on a relay, forwards it to the origin.
     * @param {import("../link/direct-link.js").DirectLink} link
     * @param {{origin: string, for?: string, audio: boolean, video: boolean, tags: string[]|null}} msg
     */
    onSubscription(link: import("../link/direct-link.js").DirectLink, msg: {
        origin: string;
        for?: string;
        audio: boolean;
        video: boolean;
        tags: string[] | null;
    }): void;
    /** Sends our subscription for `origin` to the origin and to every relay of the pair. */
    sendSubscription(origin: any): void;
    /** Re-sends all our subscriptions over `link` (after it opened). */
    resendSubscriptions(link: any): void;
    subscriptionsChanged(origin: any): void;
    /**
     * Sources link `link` must carry: `[{key, info, track, active, params}]`.
     * @param {import("../link/direct-link.js").DirectLink} link
     */
    plan(link: import("../link/direct-link.js").DirectLink): {
        key: string;
        info: any;
        track: any;
        active: boolean;
    }[];
    /** Media kinds the pair with `peerId` exchanges. */
    kindsFor(peerId: any): any[];
    /** True when the pair with `peerId` exchanges media (our publications or theirs). */
    pairHasMedia(peerId: any): boolean;
    /** Handles the end to end `media` message: the kinds the remote side publishes to us. */
    onRemoteKinds(peerId: any, kinds: any): void;
    receivedSource(link: any, info: any, track: any): void;
    receivedSourceGone(link: any, info: any): void;
    forwardedSourcesGone(linkId: any): void;
    onMidMap(): void;
    onMetrics(link: any, m: any, stats: any): void;
    /** Origin side: a relay reported budgets for our publications. */
    onBwe(link: any, msg: any): void;
    /** Tells each peer which media kinds we publish to it, when that changed. */
    tick(): void;
    /** Bitrate this peer forwards for others, in bps (sum of forwarding budgets). */
    relayedBps(): number;
    budgetsSnapshot(): {
        links: {};
        relayed: {};
        reported: {};
    };
    close(): void;
    #private;
}
