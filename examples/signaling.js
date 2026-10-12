// Signaling settings for the demos: the PHP server by default, the Node server with ?server=node.
const params = new URLSearchParams(location.search);

/** @param {string} group name of the group to join */
export function demoSignaling(group) {
  if (params.get("server") === "node") return { type: "websocket", url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signal`, group };
  return { type: "polling", url: new URL("../../server/php/signal.php", import.meta.url).href, group };
}
