/**
 * Candidate pair dumps (doc §4.3): the selected pair on success, all pairs on failure. Counters a
 * browser does not report are written as "unknown", not as zero (doc §4.2).
 */

const U = "unknown";
const v = (x) => (x === undefined || x === null ? U : x);

function candidateInfo(c) {
  if (!c) return null;
  const address = c.address ?? c.ip;
  return {
    type: v(c.candidateType),
    protocol: v(c.protocol),
    address: v(address),
    port: v(c.port),
    mdns: typeof address === "string" && address.endsWith(".local"),
    relayProtocol: c.relayProtocol,
    url: c.url,
  };
}

/** Reads the stats report into plain maps. */
export async function readStats(pc) {
  const report = await pc.getStats();
  const all = new Map();
  report.forEach((s) => all.set(s.id, s));
  return all;
}

/** Returns the selected candidate pair stats object, or undefined. */
export function selectedPair(stats) {
  for (const s of stats.values()) {
    if (s.type === "transport" && s.selectedCandidatePairId) return stats.get(s.selectedCandidatePairId);
  }
  for (const s of stats.values()) if (s.type === "candidate-pair" && s.selected) return s;
  for (const s of stats.values()) if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") return s;
  return undefined;
}

function pairInfo(stats, p) {
  return {
    state: v(p.state),
    nominated: v(p.nominated),
    requestsSent: v(p.requestsSent),
    responsesReceived: v(p.responsesReceived),
    bytesSent: v(p.bytesSent),
    bytesReceived: v(p.bytesReceived),
    rtt: p.currentRoundTripTime === undefined ? U : Math.round(p.currentRoundTripTime * 1000),
    local: candidateInfo(stats.get(p.localCandidateId)),
    remote: candidateInfo(stats.get(p.remoteCandidateId)),
  };
}

/**
 * Builds a dump. With `all`, every pair is listed; otherwise only the selected one.
 * @param {Map<string, any>} stats
 * @param {boolean} all
 */
export function pairDump(stats, all) {
  const selected = selectedPair(stats);
  const out = { selected: selected ? pairInfo(stats, selected) : null };
  if (all) {
    out.pairs = [];
    for (const s of stats.values()) if (s.type === "candidate-pair") out.pairs.push(pairInfo(stats, s));
    out.localCandidates = [];
    out.remoteCandidates = [];
    for (const s of stats.values()) {
      if (s.type === "local-candidate") out.localCandidates.push(candidateInfo(s));
      if (s.type === "remote-candidate") out.remoteCandidates.push(candidateInfo(s));
    }
  }
  return out;
}

/** Summarizes a dump for the size-capped log `data` field. */
export function summarizeDump(dump) {
  const p = (x) => x && `${x.local?.type}/${x.local?.address}:${x.local?.port} -> ${x.remote?.type}/${x.remote?.address}:${x.remote?.port} ${x.state} resp=${x.responsesReceived} rx=${x.bytesReceived}`;
  return {
    selected: p(dump.selected),
    pairs: dump.pairs?.slice(0, 16).map(p),
    pairCount: dump.pairs?.length,
    local: dump.localCandidates?.slice(0, 12).map((c) => `${c.type}/${c.protocol}/${c.address}:${c.port}`),
    remote: dump.remoteCandidates?.slice(0, 12).map((c) => `${c.type}/${c.protocol}/${c.address}:${c.port}`),
  };
}
