/**
 * @typedef {object} Envelope
 * @property {number} version
 * @property {number} type
 * @property {number} flags
 * @property {number} srcIdx
 * @property {number} dstIdx
 * @property {number} channelId
 * @property {number} seq
 * @property {number} [fragIndex]
 * @property {number} [fragCount]
 * @property {number} [lifetime]
 * @property {Uint8Array} payload
 */
/** Header length for the given flags. */
export function headerLength(flags: any): number;
/**
 * Encodes an envelope.
 * @param {Omit<Envelope, "flags"> & {flags?: number}} e
 * @returns {Uint8Array}
 */
export function encode(e: Omit<Envelope, "flags"> & {
    flags?: number;
}): Uint8Array;
/**
 * Decodes an envelope. The payload is a view into `buf`. Returns null for malformed input.
 * @param {Uint8Array} buf
 * @returns {Envelope | null}
 */
export function decode(buf: Uint8Array): Envelope | null;
/**
 * Rewrites srcIdx and dstIdx in place (relay forwarding).
 * @param {Uint8Array} buf
 */
export function rewriteIdx(buf: Uint8Array, srcIdx: any, dstIdx: any): void;
/**
 * Rewrites the lifetime field in place. No-op without the lifetime flag.
 * @param {Uint8Array} buf
 */
export function rewriteLifetime(buf: Uint8Array, ms: any): void;
/**
 * Additional authenticated data for encryption: every field a relay does not rewrite.
 * @param {{version: number, type: number, channelId: number, seq: number, fragIndex?: number, fragCount?: number}} e
 */
export function aad(e: {
    version: number;
    type: number;
    channelId: number;
    seq: number;
    fragIndex?: number;
    fragCount?: number;
}): Uint8Array<ArrayBuffer>;
/**
 * Splits a payload into fragments of at most `max` bytes. Returns `[payload]` when it fits.
 * @param {Uint8Array} payload
 * @param {number} max
 */
export function split(payload: Uint8Array, max: number): Uint8Array<ArrayBufferLike>[];
/**
 * Binary envelope framing (plan section 9.1). All fields big-endian.
 *
 * version u8 | type u8 | flags u8 | srcIdx u8 | dstIdx u8 | channelId u16 | seq u32
 * [fragIndex u16 | fragCount u16] (flag FRAGMENTED) [lifetime u16] (flag LIFETIME) | payload
 */
export const TYPE: Readonly<{
    DATA: 0;
    ACK: 1;
    CREDIT: 2;
    BEAT: 3;
    CONTROL: 4;
}>;
export const FLAG: Readonly<{
    ENCRYPTED: 1;
    FRAGMENTED: 2;
    LIFETIME: 4;
}>;
export const BASE_HEADER: 11;
export const MAX_LIFETIME: 65535;
export namespace serial {
    function lt(a: any, b: any): boolean;
    function le(a: any, b: any): boolean;
    function add(a: any, n: any): number;
    function diff(a: any, b: any): number;
}
/**
 * Reassembles fragmented messages. Incomplete messages are dropped after `timeoutMs` or when the
 * byte limit is exceeded (oldest first).
 */
export class Reassembler {
    /**
     * @param {{now: () => number}} clock
     * @param {number} [timeoutMs]
     * @param {number} [maxBytes]
     */
    constructor(clock: {
        now: () => number;
    }, timeoutMs?: number, maxBytes?: number);
    clock: {
        now: () => number;
    };
    timeoutMs: number;
    maxBytes: number;
    /**
     * Adds a fragment. Returns the complete payload when this fragment completes it, else null.
     * @param {string} key identifies the message (origin, channel, seq)
     * @param {number} index
     * @param {number} count
     * @param {Uint8Array} part
     */
    add(key: string, index: number, count: number, part: Uint8Array): Uint8Array<any>;
    /** Drops all pending fragments whose key starts with `prefix`. */
    dropPrefix(prefix: any): void;
    /** Bytes held in pending fragments. */
    get bytes(): number;
    #private;
}
export type Envelope = {
    version: number;
    type: number;
    flags: number;
    srcIdx: number;
    dstIdx: number;
    channelId: number;
    seq: number;
    fragIndex?: number;
    fragCount?: number;
    lifetime?: number;
    payload: Uint8Array;
};
