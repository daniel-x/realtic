const DEFAULT_INTERVAL_MS = 1000;
// Browsers limit keepalive and beacon bodies to 64 KiB.
const MAX_BODY_CHARS = 60000;

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
export function forwardLog(peerGroup, { url, group = "default", level = "debug", intervalMs = DEFAULT_INTERVAL_MS }) {
  const log = peerGroup.log;
  const target = new URL(url, globalThis.location?.href);
  target.searchParams.set("group", group);
  target.searchParams.set("id", peerGroup.selfId);
  let since = 0;
  let inFlight = 0;
  let sending = null;
  let stopped = false;

  const take = () => {
    const all = log.entries({ since, level });
    const parts = [];
    let chars = 0;
    for (const { time, ...e } of all) {
      const json = JSON.stringify({ ...e, timeUs: Math.round(time * 1000) });
      if (parts.length && chars + json.length > MAX_BODY_CHARS) break;
      parts.push(json);
      chars += json.length + 1;
    }
    return { body: `{"entries":[${parts.join(",")}]}`, count: parts.length, last: all[parts.length - 1]?.seq, more: parts.length < all.length };
  };

  const send = async () => {
    const batch = take();
    if (!batch.count) return false;
    inFlight = batch.last;
    try {
      const res = await fetch(target, { method: "POST", body: batch.body, headers: { "content-type": "text/plain" }, keepalive: true });
      if (!res.ok) return false;
      since = batch.last;
      return batch.more;
    } catch {
      return false;
    }
  };

  const flush = () => {
    sending ??= send().finally(() => (sending = null));
    return sending;
  };

  const beacon = () => {
    if (sending) since = Math.max(since, inFlight);
    for (;;) {
      const batch = take();
      if (!batch.count || !globalThis.navigator?.sendBeacon?.(target, batch.body)) return;
      since = batch.last;
      if (!batch.more) return;
    }
  };

  const hidden = () => globalThis.document?.visibilityState === "hidden" && flush();

  const timer = setInterval(flush, intervalMs);
  globalThis.addEventListener?.("pagehide", beacon);
  globalThis.document?.addEventListener("visibilitychange", hidden);
  flush();

  return async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    globalThis.removeEventListener?.("pagehide", beacon);
    globalThis.document?.removeEventListener("visibilitychange", hidden);
    await sending;
    while (await flush());
  };
}
