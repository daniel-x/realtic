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
export function wants(sub: Subscription | undefined, kind: string, tag: string): boolean;
/** Normalizes a subscription for the wire. */
export function normalize(sub: any): {
    audio: boolean;
    video: boolean;
    tags: any[];
};
/**
 * Receive preferences (plan section 10.2). A subscription says which kinds and tags of an
 * origin's media a receiver wants. Without an entry, everything is wanted.
 */
export type Subscription = {
    audio?: boolean;
    video?: boolean;
    tags?: string[] | null;
};
