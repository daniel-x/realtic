/**
 * Binary envelope framing (plan section 9.1). All fields big-endian.
 *
 * version u8 | type u8 | flags u8 | srcIdx u8 | dstIdx u8 | channelId u16 | seq u32
 * [fragIndex u16 | fragCount u16] (flag FRAGMENTED) [lifetime u16] (flag LIFETIME) | payload
 */

export const TYPE = Object.freeze({ DATA: 0, ACK: 1, CREDIT: 2, BEAT: 3, CONTROL: 4 });
export const FLAG = Object.freeze({ ENCRYPTED: 1, FRAGMENTED: 2, LIFETIME: 4 });
export const BASE_HEADER = 11;
export const MAX_LIFETIME = 0xffff;

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
export function headerLength(flags) {
  return BASE_HEADER + (flags & FLAG.FRAGMENTED ? 4 : 0) + (flags & FLAG.LIFETIME ? 2 : 0);
}

/**
 * Encodes an envelope.
 * @param {Omit<Envelope, "flags"> & {flags?: number}} e
 * @returns {Uint8Array}
 */
export function encode(e) {
  let flags = (e.flags ?? 0) & FLAG.ENCRYPTED;
  if (e.fragCount !== undefined) flags |= FLAG.FRAGMENTED;
  if (e.lifetime !== undefined) flags |= FLAG.LIFETIME;
  const hl = headerLength(flags);
  const payload = e.payload ?? EMPTY;
  const out = new Uint8Array(hl + payload.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, e.version);
  v.setUint8(1, e.type);
  v.setUint8(2, flags);
  v.setUint8(3, e.srcIdx);
  v.setUint8(4, e.dstIdx);
  v.setUint16(5, e.channelId);
  v.setUint32(7, e.seq >>> 0);
  let o = BASE_HEADER;
  if (flags & FLAG.FRAGMENTED) {
    v.setUint16(o, e.fragIndex);
    v.setUint16(o + 2, e.fragCount);
    o += 4;
  }
  if (flags & FLAG.LIFETIME) v.setUint16(o, Math.max(0, Math.min(MAX_LIFETIME, Math.round(e.lifetime))));
  out.set(payload, hl);
  return out;
}

const EMPTY = new Uint8Array(0);

/**
 * Decodes an envelope. The payload is a view into `buf`. Returns null for malformed input.
 * @param {Uint8Array} buf
 * @returns {Envelope | null}
 */
export function decode(buf) {
  if (buf.length < BASE_HEADER) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = v.getUint8(2);
  const hl = headerLength(flags);
  if (buf.length < hl) return null;
  /** @type {Envelope} */
  const e = {
    version: v.getUint8(0),
    type: v.getUint8(1),
    flags,
    srcIdx: v.getUint8(3),
    dstIdx: v.getUint8(4),
    channelId: v.getUint16(5),
    seq: v.getUint32(7),
    payload: buf.subarray(hl),
  };
  let o = BASE_HEADER;
  if (flags & FLAG.FRAGMENTED) {
    e.fragIndex = v.getUint16(o);
    e.fragCount = v.getUint16(o + 2);
    o += 4;
  }
  if (flags & FLAG.LIFETIME) e.lifetime = v.getUint16(o);
  return e;
}

/**
 * Rewrites srcIdx and dstIdx in place (relay forwarding).
 * @param {Uint8Array} buf
 */
export function rewriteIdx(buf, srcIdx, dstIdx) {
  buf[3] = srcIdx;
  buf[4] = dstIdx;
}

/**
 * Rewrites the lifetime field in place. No-op without the lifetime flag.
 * @param {Uint8Array} buf
 */
export function rewriteLifetime(buf, ms) {
  const flags = buf[2];
  if (!(flags & FLAG.LIFETIME)) return;
  const o = BASE_HEADER + (flags & FLAG.FRAGMENTED ? 4 : 0);
  const value = Math.max(0, Math.min(MAX_LIFETIME, Math.round(ms)));
  buf[o] = value >> 8;
  buf[o + 1] = value & 0xff;
}

/**
 * Additional authenticated data for encryption: every field a relay does not rewrite.
 * @param {{version: number, type: number, channelId: number, seq: number, fragIndex?: number, fragCount?: number}} e
 */
export function aad(e) {
  const out = new Uint8Array(12);
  const v = new DataView(out.buffer);
  v.setUint8(0, e.version);
  v.setUint8(1, e.type);
  v.setUint16(2, e.channelId);
  v.setUint32(4, e.seq >>> 0);
  v.setUint16(8, e.fragIndex ?? 0);
  v.setUint16(10, e.fragCount ?? 0);
  return out;
}

/** Serial number arithmetic (RFC 1982) for u32 sequence numbers. */
export const serial = {
  /** a < b */
  lt: (a, b) => a !== b && ((b - a) >>> 0) < 0x80000000,
  /** a <= b */
  le: (a, b) => a === b || serial.lt(a, b),
  add: (a, n) => (a + n) >>> 0,
  /** b - a as a signed distance */
  diff: (a, b) => ((b - a) | 0),
};

/**
 * Splits a payload into fragments of at most `max` bytes. Returns `[payload]` when it fits.
 * @param {Uint8Array} payload
 * @param {number} max
 */
export function split(payload, max) {
  if (payload.length <= max) return [payload];
  const parts = [];
  for (let o = 0; o < payload.length; o += max) parts.push(payload.subarray(o, o + max));
  if (parts.length > 0xffff) throw new RangeError("message too large");
  return parts;
}

/**
 * Reassembles fragmented messages. Incomplete messages are dropped after `timeoutMs` or when the
 * byte limit is exceeded (oldest first).
 */
export class Reassembler {
  #pending = new Map();
  #bytes = 0;

  /**
   * @param {{now: () => number}} clock
   * @param {number} [timeoutMs]
   * @param {number} [maxBytes]
   */
  constructor(clock, timeoutMs = 30000, maxBytes = 64 * 1024 * 1024) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }

  /**
   * Adds a fragment. Returns the complete payload when this fragment completes it, else null.
   * @param {string} key identifies the message (origin, channel, seq)
   * @param {number} index
   * @param {number} count
   * @param {Uint8Array} part
   */
  add(key, index, count, part) {
    const now = this.clock.now();
    this.#expire(now);
    let m = this.#pending.get(key);
    if (!m) {
      if (count === 0 || index >= count) return null;
      m = { parts: new Array(count), have: 0, size: 0, at: now };
      this.#pending.set(key, m);
    }
    if (index >= m.parts.length || m.parts[index]) return null;
    m.parts[index] = part.slice();
    m.have++;
    m.size += part.length;
    this.#bytes += part.length;
    if (m.have < m.parts.length) {
      while (this.#bytes > this.maxBytes && this.#pending.size > 1) this.#dropOldest();
      return null;
    }
    this.#pending.delete(key);
    this.#bytes -= m.size;
    const out = new Uint8Array(m.size);
    let o = 0;
    for (const p of m.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Drops all pending fragments whose key starts with `prefix`. */
  dropPrefix(prefix) {
    for (const [k, m] of this.#pending) {
      if (k.startsWith(prefix)) {
        this.#bytes -= m.size;
        this.#pending.delete(k);
      }
    }
  }

  #expire(now) {
    for (const [k, m] of this.#pending) {
      if (now - m.at <= this.timeoutMs) break;
      this.#bytes -= m.size;
      this.#pending.delete(k);
    }
  }

  #dropOldest() {
    const [k, m] = this.#pending.entries().next().value;
    this.#bytes -= m.size;
    this.#pending.delete(k);
  }

  /** Bytes held in pending fragments. */
  get bytes() {
    return this.#bytes;
  }
}
