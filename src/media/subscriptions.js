/**
 * Receive preferences (plan section 10.2). A subscription says which kinds and tags of an
 * origin's media a receiver wants. Without an entry, everything is wanted.
 * @typedef {{audio?: boolean, video?: boolean, tags?: string[] | null}} Subscription
 */

/**
 * True when `sub` wants a track of `kind` with `tag`.
 * @param {Subscription | undefined} sub
 * @param {string} kind
 * @param {string} tag
 */
export function wants(sub, kind, tag) {
  if (!sub) return true;
  if (kind === "audio" && sub.audio === false) return false;
  if (kind === "video" && sub.video === false) return false;
  if (Array.isArray(sub.tags) && !sub.tags.includes(tag)) return false;
  return true;
}

/** Normalizes a subscription for the wire. */
export function normalize(sub) {
  return { audio: sub?.audio !== false, video: sub?.video !== false, tags: Array.isArray(sub?.tags) ? [...sub.tags] : null };
}
