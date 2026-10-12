/**
 * Reference WebSocket signaling adapter for the Node reference server (`server/node`). Wire format:
 * JSON frames `{ to, msg }` from the client, `{ from, msg }` and `{ presence, peer }` from the
 * server. Reconnects with backoff; messages sent while disconnected are dropped (the library
 * retries what matters, and stale signaling is worse than lost signaling, doc §2.1).
 */
export class WebSocketSignaling {
    /**
     * @param {string} url server URL, e.g. `wss://example.com/signal`
     * @param {string} selfId
     * @param {{room?: string, WebSocket?: typeof WebSocket}} [options]
     */
    constructor(url: string, selfId: string, { room, WebSocket: WS }?: {
        room?: string;
        WebSocket?: typeof WebSocket;
    });
    url: string;
    selfId: string;
    room: string;
    WS: {
        new (url: string | URL, protocols?: string | string[]): WebSocket;
        prototype: WebSocket;
        readonly CONNECTING: 0;
        readonly OPEN: 1;
        readonly CLOSING: 2;
        readonly CLOSED: 3;
    };
    /** @type {((from: string, message: object) => void) | null} */
    onmessage: ((from: string, message: object) => void) | null;
    /** @type {((event: {type: "join"|"leave", peer: string}) => void) | null} */
    onpresence: ((event: {
        type: "join" | "leave";
        peer: string;
    }) => void) | null;
    /** @type {((connected: boolean) => void) | null} */
    onstatus: ((connected: boolean) => void) | null;
    /** True while the socket is open. */
    get connected(): boolean;
    /**
     * @param {string} to
     * @param {object} message
     */
    send(to: string, message: object): void;
    /**
     * Sends via `navigator.sendBeacon` to the server's HTTP endpoint, for `pagehide`.
     * @param {string} to
     * @param {object} message
     */
    sendBeacon(to: string, message: object): boolean;
    close(): void;
    #private;
}
