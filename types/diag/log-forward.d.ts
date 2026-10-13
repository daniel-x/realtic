/**
 * Sends the log entries of a group to a log endpoint of a reference server (`server/node` with a
 * log directory, or `server/php/log.php`), which appends them to one file per group. It starts
 * with the entries already buffered, then sends the new ones every `intervalMs` and when the page
 * becomes hidden, and the rest with `sendBeacon` on `pagehide`, as far as the browser's beacon
 * quota allows (Chromium: 64 KiB). A keepalive request still in flight at `pagehide` counts as
 * sent. Entries a failed request carried are sent again with the next one. On the wire, an
 * entry carries `timeUs`, its time as integer UTC microseconds, instead of `time`.
 * @param {import("../peer-group.js").RalPeerGroup} peerGroup
 * @param {object} options
 * @param {string} options.url the log endpoint
 * @param {string} [options.group] the group name of the log file
 * @param {"debug"|"info"|"warn"|"error"} [options.level]
 * @param {number} [options.intervalMs]
 * @returns {() => Promise<void>} stops forwarding after sending what is left
 */
export function forwardLog(peerGroup: import("../peer-group.js").RalPeerGroup, { url, group, level, intervalMs }: {
    url: string;
    group?: string;
    level?: "debug" | "info" | "warn" | "error";
    intervalMs?: number;
}): () => Promise<void>;
