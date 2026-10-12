/**
 * Link-state tables (plan section 7.1). Each peer sends its direct link table to its neighbors on
 * `ctl`; with at most one relay no flooding is needed.
 */
/** Builds this peer's `link-state` message. */
export function buildLinkState(group: any, load: any): {
    t: string;
    links: {
        peer: any;
        state: any;
        rtt: number;
        bitrate: any;
        loss: any;
        candidateType: any;
        mms: any;
    }[];
    load: any;
    relay: boolean;
    mediaRelay: any;
    ts: number;
};
/**
 * Neighbor table store: what each neighbor last reported.
 */
export class NeighborTables {
    /**
     * @param {string} neighbor
     * @param {object} msg `link-state` message
     * @param {number} now
     */
    update(neighbor: string, msg: object, now: number): void;
    /** @param {string} neighbor */
    get(neighbor: string): any;
    /** @param {string} neighbor */
    delete(neighbor: string): void;
    /** Entry of neighbor's link to target, or undefined. */
    entry(neighbor: any, target: any): any;
    /** Neighbor ids. */
    keys(): MapIterator<any>;
    /** Drops tables older than `maxAgeMs`. */
    expire(now: any, maxAgeMs: any): void;
    #private;
}
