/**
 * Failure hints derived from a full pair dump (plan section 12.2). Returns null when no known
 * pattern matches.
 *
 * - `local-network-permission`: both sides show the same server reflexive address and every host
 *   to host pair has `responsesReceived === 0` (doc §4.1). AP client isolation looks the same.
 * - `mdns-unresolved`: the remote side offered only `.local` host candidates and no host pair
 *   succeeded (doc §4.4).
 * - `symmetric-nat`: no srflx pair succeeded and the local side got different srflx ports from
 *   different STUN servers for the same base.
 * @param {ReturnType<import("./pair-dump.js").pairDump>} dump
 */
export function failureHint(dump) {
  const pairs = dump.pairs ?? [];
  const local = dump.localCandidates ?? [];
  const remote = dump.remoteCandidates ?? [];
  const localSrflx = new Set(local.filter((c) => c.type === "srflx").map((c) => c.address));
  const remoteSrflx = new Set(remote.filter((c) => c.type === "srflx").map((c) => c.address));
  const sharedPublic = [...localSrflx].some((a) => remoteSrflx.has(a));
  const hostPairs = pairs.filter((p) => p.local?.type === "host" && p.remote?.type === "host");
  const succeeded = (p) => p.state === "succeeded";
  if (sharedPublic && hostPairs.length && hostPairs.every((p) => p.responsesReceived === 0)) {
    return "local-network-permission";
  }
  const remoteHost = remote.filter((c) => c.type === "host");
  if (remoteHost.length && remoteHost.every((c) => c.mdns) && !hostPairs.some(succeeded)) return "mdns-unresolved";
  const srflxPairs = pairs.filter((p) => p.local?.type === "srflx" || p.remote?.type === "srflx");
  const ports = new Map();
  for (const c of local.filter((x) => x.type === "srflx" && x.url)) {
    if (!ports.has(c.address)) ports.set(c.address, new Set());
    ports.get(c.address).add(c.port);
  }
  const symmetric = [...ports.values()].some((s) => s.size > 1);
  if (symmetric && !srflxPairs.some(succeeded)) return "symmetric-nat";
  return null;
}

/** Human readable text for a hint, for apps that show it as is. */
export const HINT_TEXT = Object.freeze({
  "local-network-permission":
    "The browser may lack permission to reach devices on the local network (or the access point isolates clients).",
  "mdns-unresolved": "The other device's local address (.local name) could not be resolved on this network.",
  "symmetric-nat": "Both networks use address translation that blocks direct connections; a TURN server is needed.",
  "protocol-mismatch": "The other side runs an incompatible library version.",
});
