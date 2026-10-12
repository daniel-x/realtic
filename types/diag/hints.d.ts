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
export function failureHint(dump: ReturnType<typeof import("./pair-dump.js").pairDump>): "local-network-permission" | "mdns-unresolved" | "symmetric-nat";
/** Human readable text for a hint, for apps that show it as is. */
export const HINT_TEXT: Readonly<{
    "local-network-permission": "The browser may lack permission to reach devices on the local network (or the access point isolates clients).";
    "mdns-unresolved": "The other device's local address (.local name) could not be resolved on this network.";
    "symmetric-nat": "Both networks use address translation that blocks direct connections; a TURN server is needed.";
    "protocol-mismatch": "The other side runs an incompatible library version.";
}>;
