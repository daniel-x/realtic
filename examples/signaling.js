// Signaling settings for the demos, which a reference server serves together with its endpoints:
// realtic-server-php by default, realtic-server-node with ?server=node. With ?log_to_server=1 the
// demos forward their logs to the server (Node: start it with --log-dir).
import { forwardLog } from "../src/diag/log-forward.js";

const params = new URLSearchParams(location.search);

/** @param {string} group name of the group to join */
export function demoSignaling(group) {
  if (params.get("server") === "node") return { type: "websocket", url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/signal`, group };
  return { type: "polling", url: new URL("/signal.php", location.href).href, group };
}

/**
 * Forwards the log of `group` to the demo server when the page has ?log_to_server=1.
 * @param {import("../src/peer-group.js").RalPeerGroup} group
 * @param {string} name name of the group, the server's log file name
 */
export function demoLogForwarding(group, name) {
  if (params.get("log_to_server") !== "1") return;
  const url = params.get("server") === "node" ? new URL("/log", location.href).href : new URL("/log.php", location.href).href;
  forwardLog(group, { url, group: name });
}
