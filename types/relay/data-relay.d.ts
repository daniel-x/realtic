/** True when relay flow `f` runs between peers `a` and `b`, in either direction. */
export function connects(f: any, a: any, b: any): boolean;
/**
 * Relay side of peer relaying (plan section 7.2, 9.3, decision D21): accepts or rejects relay
 * requests, forwards envelopes of accepted flows between its two neighbors, rewrites the index
 * fields, and reports a failed link to one end to the other end with `route-down` / `route-slow`.
 */
export class DataRelay {
    static key(origin: any, target: any, flow: any): string;
    /** @param {object} group */
    constructor(group: object);
    /** flow key -> {flow, origin, target, role, kinds, bytes, since} */
    flows: Map<any, any>;
    l: any;
    /** True when a flow between a and b (either direction) is accepted. */
    carries(a: any, b: any): boolean;
    /** Relayed bytes per second over the last measurement window. */
    get rate(): number;
    /**
     * Handles `relay-request` from the origin end.
     * @param {import("../link/direct-link.js").DirectLink} link link to the origin
     * @param {{flow: string, origin: string, target: string, role: string, kinds?: string[]}} msg
     */
    onRequest(link: import("../link/direct-link.js").DirectLink, msg: {
        flow: string;
        origin: string;
        target: string;
        role: string;
        kinds?: string[];
    }): void;
    /**
     * Handles `relay-close` from either end and forwards it to the other end.
     * @param {import("../link/direct-link.js").DirectLink} link
     * @param {{flow: string}} msg
     */
    onClose(link: import("../link/direct-link.js").DirectLink, msg: {
        flow: string;
    }): void;
    /**
     * Handles `standby-activate` from the origin end: the standby becomes active.
     * @param {import("../link/direct-link.js").DirectLink} link
     * @param {{flow: string}} msg
     */
    onActivate(link: import("../link/direct-link.js").DirectLink, msg: {
        flow: string;
    }): void;
    /**
     * Forwards an envelope of an accepted flow. Drops everything else.
     * @param {import("../link/direct-link.js").DirectLink} link incoming link
     * @param {string} src origin peer id
     * @param {string} dst destination peer id
     * @param {Uint8Array} bytes
     * @param {import("../transport/framing.js").Envelope} e
     * @param {string} key transport key
     */
    forward(link: import("../link/direct-link.js").DirectLink, src: string, dst: string, bytes: Uint8Array, e: import("../transport/framing.js").Envelope, key: string): void;
    /**
     * The link to an end of a relayed flow changed state: tell the far end (plan section 6.2).
     * @param {string} peerId the neighbor whose link changed
     * @param {"ok"|"slow"|"stale"} verdict
     */
    endChanged(peerId: string, verdict: "ok" | "slow" | "stale"): void;
    /** Drops all flows involving `peerId`. */
    peerGone(peerId: any): void;
    close(): void;
    /** Flows as plain objects, for diagnostics. */
    list(): {
        flow: any;
        origin: any;
        target: any;
        role: any;
        kinds: any;
    }[];
    #private;
}
