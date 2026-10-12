import { VERSION, PROTOCOL } from "../config.js";
import { readStats } from "./pair-dump.js";

const SECRET_KEYS = /credential|password|secret|token/i;

function plainConfig(config) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "function" || k === "testHooks") out[k] = v ? "[function]" : v;
    else out[k] = v;
  }
  return out;
}

function iceServersWithoutCredentials(servers) {
  return servers.map((s) => {
    const o = {};
    for (const [k, v] of Object.entries(s)) o[k] = SECRET_KEYS.test(k) ? "[redacted]" : v;
    return o;
  });
}

/**
 * Builds the JSON-serializable diagnostic report of a group (plan section 12.1): log entries,
 * versions, user agent, config without credentials, peer, link and route states, the last
 * candidate pair dumps, and a getStats() snapshot. Sends nothing anywhere.
 * @param {import("../group.js").Group} group
 */
export async function diagnosticReport(group) {
  const stats = {};
  for (const [id, link] of group.links) {
    if (!link.pc) continue;
    try {
      const s = await readStats(link.pc);
      stats[id] = [...s.values()].filter((x) => x.type !== "certificate" && x.type !== "codec");
    } catch {
      stats[id] = "unavailable";
    }
  }
  const report = {
    library: { version: VERSION, protocol: PROTOCOL },
    userAgent: globalThis.navigator?.userAgent ?? null,
    time: group.clock.wallNow(),
    selfId: group.selfId,
    config: plainConfig(group.config),
    iceServers: iceServersWithoutCredentials(group.iceServers),
    peers: [...group.peers.values()].map((p) => ({ id: p.id, state: p.state, reason: p.reason, route: p.route, lastError: p.lastError, hint: p.hint })),
    links: [...group.links.values()].map((l) => ({ peer: l.remoteId, state: l.state, reason: l.reason, session: l.session, liveness: l.liveness, metrics: l.metrics, lastError: l.lastError, hint: l.hint, lastDump: l.lastDump })),
    routing: group.getStats(),
    media: group.media.streams.list(),
    stats,
    log: group.log.entries(),
  };
  const json = JSON.stringify(report);
  return JSON.parse(group.config.logRedact ? group.log.redactString(json) : json);
}
