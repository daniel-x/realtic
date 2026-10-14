/**
 * Direct connection tables (plan section 7.1). Each peer sends its direct connection table to its
 * neighbors on `ctl`; with at most one relay no flooding is needed.
 */
/** Builds this peer's `direct-table` message. */
export function buildDirectTable(group: any, load: any): {
    t: string;
    conns: {
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
     * @param {object} msg `direct-table` message
     * @param {number} now
     */
    update(neighbor: string, msg: object, now: number): void;
    /** @param {string} neighbor */
    get(neighbor: string): any;
    /** @param {string} neighbor */
    delete(neighbor: string): void;
    /** Entry of neighbor's direct connection to target, or undefined. */
    entry(neighbor: any, target: any): any;
    /** Neighbor ids. */
    keys(): MapIterator<any>;
    /** Drops tables older than `maxAgeMs`. */
    expire(now: any, maxAgeMs: any): void;
    #private;
}
