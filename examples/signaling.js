// Signaling settings for the demos: the PHP server by default, the Node server with ?server=node.
const params = new URLSearchParams(location.search);

/** @param {string} room */
export function demoSignaling(room) {
  if (params.get("server") === "node") return { type: "websocket", url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signal`, room };
  return { type: "polling", url: new URL("../../server/php/signal.php", import.meta.url).href, room };
}
