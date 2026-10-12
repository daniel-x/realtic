/**
 * Builds the JSON-serializable diagnostic report of a group (plan section 12.1): log entries,
 * versions, user agent, config without credentials, peer, link and route states, the last
 * candidate pair dumps, and a getStats() snapshot. Sends nothing anywhere.
 * @param {import("../peer-group.js").ReatPeerGroup} group
 */
export function diagnosticReport(group: import("../peer-group.js").ReatPeerGroup): Promise<any>;
