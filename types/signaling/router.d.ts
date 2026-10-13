/** Message types a relay may forward. */
export const RELAYABLE: Set<string>;
/**
 * Sends signaling over the mesh first and the server second (plan section 4.4, decision D2).
 *
 * - `hello` always goes through the server.
 * - `offer`/`answer` go over the direct link they renegotiate when its `ctl` is open, else through
 *   the server.
 * - `cand`, `renegotiate`, `bye` go over the direct link, else through a relay neighbor, else
 *   through the server.
 * - While a direct link is open but not healthy, the message also goes through the server.
 *   Receivers drop duplicates by message id.
 */
export class SignalingRouter {
    /**
     * @param {object} options
     * @param {string} options.selfId
     * @param {() => import("./adapter.js").SignalingAdapter} options.adapter
     * @param {(id: string) => import("../link/direct-peer-connection.js").RalDirectPeerConnection | undefined} options.link
     * @param {(target: string) => string | undefined} options.relayFor neighbor that has a live link to target
     * @param {ReturnType<import("../diag/log.js").RalLog["scope"]>} options.log
     * @param {{outgoingSignal?: (to: string, msg: object) => (object | Promise<object>)}} [options.hooks]
     */
    constructor({ selfId, adapter, link, relayFor, log, hooks }: {
        selfId: string;
        adapter: () => import("./adapter.js").SignalingAdapter;
        link: (id: string) => import("../link/direct-peer-connection.js").RalDirectPeerConnection | undefined;
        relayFor: (target: string) => string | undefined;
        log: ReturnType<import("../diag/log.js").RalLog["scope"]>;
        hooks?: {
            outgoingSignal?: (to: string, msg: object) => (object | Promise<object>);
        };
    });
    selfId: string;
    adapter: () => import("./adapter.js").SignalingAdapter;
    link: (id: string) => import("../link/direct-peer-connection.js").RalDirectPeerConnection | undefined;
    relayFor: (target: string) => string | undefined;
    l: {
        debug: (msg: any, data: any) => void;
        info: (msg: any, data: any) => void;
        warn: (msg: any, data: any) => void;
        error: (msg: any, data: any) => void;
        ids: {
            peer?: string;
            session?: string;
        };
    };
    hooks: {
        outgoingSignal?: (to: string, msg: object) => (object | Promise<object>);
    };
    /**
     * Sends a signaling message.
     * @param {string} to
     * @param {object} msg
     * @param {{serverOnly?: boolean}} [options]
     */
    send(to: string, msg: object, { serverOnly }?: {
        serverOnly?: boolean;
    }): Promise<void>;
    /**
     * Best-effort send for `pagehide`: `sendBeacon` when the adapter has it, else a normal send.
     * @param {string} to
     * @param {object} msg
     */
    beacon(to: string, msg: object): void;
    #private;
}
