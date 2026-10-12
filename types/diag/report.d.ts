/**
 * Builds the JSON-serializable diagnostic report of a group (plan section 12.1): log entries,
 * versions, user agent, config without credentials, peer, link and route states, the last
 * candidate pair dumps, and a getStats() snapshot. Sends nothing anywhere.
 * @param {import("../group.js").RealticGroup} group
 */
export function diagnosticReport(group: import("../group.js").RealticGroup): Promise<any>;
