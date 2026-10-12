/**
 * Signaling settings for one of the two reference servers.
 * @typedef {object} SignalingOptions
 * @property {string} url `signal.php` endpoint (PHP server) or `ws://`/`wss://` URL (Node server)
 * @property {"polling" | "websocket"} [type] defaults to "websocket" for ws/wss URLs, else "polling"
 * @property {string} [room]
 * @property {number} [fastMs] polling only, see PollingSignaling
 * @property {number} [idleMs] polling only
 */
/**
 * Creates the adapter for a reference server: `"polling"` for the PHP server
 * (`server/php/signal.php`), `"websocket"` for the Node server (`server/node/server.js`).
 * @param {SignalingOptions} options
 * @param {string} selfId
 * @returns {import("./adapter.js").SignalingAdapter}
 */
export function createSignaling({ url, type, room, ...rest }: SignalingOptions, selfId: string): import("./adapter.js").SignalingAdapter;
/**
 * Signaling settings for one of the two reference servers.
 */
export type SignalingOptions = {
    /**
     * `signal.php` endpoint (PHP server) or `ws://`/`wss://` URL (Node server)
     */
    url: string;
    /**
     * defaults to "websocket" for ws/wss URLs, else "polling"
     */
    type?: "polling" | "websocket";
    room?: string;
    /**
     * polling only, see PollingSignaling
     */
    fastMs?: number;
    /**
     * polling only
     */
    idleMs?: number;
};
