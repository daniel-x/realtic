/**
 * Signaling adapter interface (plan section 4.1):
 *
 * ```js
 * { send(to, message), onmessage: (from, message) => {}, onpresence?: (event) => {}, close() }
 * ```
 *
 * `send` may return a promise; a rejected or thrown send counts as lost. `onpresence` receives
 * `{ type: "join" | "leave", peer }`. Adapters may implement `sendBeacon(to, message)` for use
 * from `pagehide`.
 * @typedef {object} SignalingAdapter
 * @property {(to: string, message: object) => (void | Promise<void>)} send
 * @property {((from: string, message: object) => void) | null} onmessage
 * @property {((event: {type: "join"|"leave", peer: string}) => void) | null} [onpresence]
 * @property {(to: string, message: object) => boolean} [sendBeacon]
 * @property {() => void} close
 */
/**
 * In-memory signaling hub for tests and same-page demos. Messages are delivered asynchronously;
 * the hub can be taken down, delayed and made to duplicate messages.
 */
export class RalMemoryHub {
    constructor({ delayMs, duplicate }?: {
        delayMs?: number;
        duplicate?: boolean;
    });
    delayMs: number;
    duplicate: boolean;
    down: boolean;
    /**
     * Returns an adapter for `id`.
     * @param {string} id
     * @returns {SignalingAdapter}
     */
    join(id: string): SignalingAdapter;
    #private;
}
/**
 * Signaling adapter interface (plan section 4.1):
 *
 * ```js
 * { send(to, message), onmessage: (from, message) => {}, onpresence?: (event) => {}, close() }
 * ```
 *
 * `send` may return a promise; a rejected or thrown send counts as lost. `onpresence` receives
 * `{ type: "join" | "leave", peer }`. Adapters may implement `sendBeacon(to, message)` for use
 * from `pagehide`.
 */
export type SignalingAdapter = {
    send: (to: string, message: object) => (void | Promise<void>);
    onmessage: ((from: string, message: object) => void) | null;
    onpresence?: ((event: {
        type: "join" | "leave";
        peer: string;
    }) => void) | null;
    sendBeacon?: (to: string, message: object) => boolean;
    close: () => void;
};
