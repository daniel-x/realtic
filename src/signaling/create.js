import { PollingSignaling } from "./polling.js";
import { WebSocketSignaling } from "./websocket.js";

/**
 * Signaling settings for one of the two reference servers.
 * @typedef {object} SignalingOptions
 * @property {string} url `signal.php` endpoint (PHP server) or `ws://`/`wss://` URL (Node server)
 * @property {"polling" | "websocket"} [type] defaults to "websocket" for ws/wss URLs, else "polling"
 * @property {string} [group]
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
export function createSignaling({ url, type, group, ...rest }, selfId) {
  const kind = type ?? (/^wss?:/i.test(url) ? "websocket" : "polling");
  if (kind === "websocket") return new WebSocketSignaling(url, selfId, { group });
  if (kind === "polling") return new PollingSignaling(url, selfId, { group, ...rest });
  throw new TypeError(`unknown signaling type ${kind}`);
}
