import { serial } from "../transport/framing.js";
import { domError } from "../util/dom.js";

/** Credit a sender may use before the first grant arrives (protocol constant). */
export const INITIAL_CREDIT = 262144;

const MAX_RTO_MS = 30000;
const UNORDERED_WINDOW = 4096;

/**
 * Reliability mode of an end to end channel.
 * @typedef {object} Mode
 * @property {boolean} ordered
 * @property {number} [maxRetransmits]
 * @property {number} [maxPacketLifeTime]
 */

/** True when the mode is fully reliable. */
export function isReliable(mode) {
  return mode.maxRetransmits == null && mode.maxPacketLifeTime == null;
}

/**
 * Sending half of an end to end channel (plan section 9.2). Reliable channels keep a retransmit
 * buffer until cumulative acks arrive and respect end to end credits; unreliable channels only
 * number their messages.
 */
export class ChannelSender {
  #nextSeq = 1;
  #queue = [];
  #unacked = new Map();
  #queuedBytes = 0;
  #unackedBytes = 0;
  #sentBytes = 0;
  #creditLimit = INITIAL_CREDIT;
  #timer = null;
  #pumping = false;

  /**
   * @param {object} options
   * @param {Mode} options.mode
   * @param {import("../util/clock.js").Clock} options.clock
   * @param {(m: {seq: number, payload: Uint8Array, lifetime?: number}) => boolean} options.transmit
   *   hands one message to the route; returns false when the route cannot take more now
   * @param {number} [options.bufferLimit] outage buffer of reliable channels
   * @param {number} [options.rtoMs]
   * @param {() => void} [options.onDrain] called when queued bytes fall
   */
  constructor({ mode, clock, transmit, bufferLimit = 16777216, rtoMs = 3000, onDrain }) {
    this.mode = mode;
    this.reliable = isReliable(mode);
    this.clock = clock;
    this.transmit = transmit;
    this.bufferLimit = bufferLimit;
    this.rtoMs = rtoMs;
    this.onDrain = onDrain;
  }

  /** Bytes accepted by `send` but not yet handed to the route. */
  get queuedBytes() {
    return this.#queuedBytes;
  }

  /** Bytes handed to the route but not yet acknowledged (reliable only). */
  get unackedBytes() {
    return this.#unackedBytes;
  }

  /** Number of unacknowledged messages. */
  get unackedCount() {
    return this.#unacked.size;
  }

  /**
   * Accepts a message. Throws `OperationError` when a reliable channel's outage buffer would
   * overflow, as `RTCDataChannel.send` does on a full buffer.
   * @param {Uint8Array} payload
   */
  send(payload) {
    if (this.reliable && this.#queuedBytes + this.#unackedBytes + payload.length > this.bufferLimit) {
      throw domError("send buffer is full", "OperationError");
    }
    const msg = { seq: this.#nextSeq, payload, sentAt: 0, tries: 0, born: this.clock.now() };
    this.#nextSeq = serial.add(this.#nextSeq, 1);
    this.#queue.push(msg);
    this.#queuedBytes += payload.length;
    this.pump();
  }

  /** Hands queued messages to the route while credit and route capacity allow. */
  pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      this.#pumpNow();
    } finally {
      this.#pumping = false;
    }
  }

  #pumpNow() {
    const before = this.#queuedBytes;
    while (this.#queue.length) {
      const msg = this.#queue[0];
      if (this.reliable && serial.lt(this.#creditLimit, (this.#sentBytes + msg.payload.length) >>> 0) && this.#unacked.size) break;
      const lifetime = this.#lifetimeOf(msg);
      if (lifetime !== undefined && lifetime <= 0) {
        this.#dequeue();
        continue;
      }
      if (!this.transmit({ seq: msg.seq, payload: msg.payload, lifetime })) break;
      this.#dequeue();
      if (this.reliable) {
        msg.sentAt = this.clock.now();
        msg.tries = 1;
        this.#unacked.set(msg.seq, msg);
        this.#unackedBytes += msg.payload.length;
        this.#sentBytes = (this.#sentBytes + msg.payload.length) >>> 0;
        this.#armTimer();
      }
    }
    if (this.#queuedBytes < before) this.onDrain?.();
  }

  #dequeue() {
    this.#queuedBytes -= this.#queue.shift().payload.length;
  }

  #lifetimeOf(msg) {
    if (this.mode.maxPacketLifeTime == null) return undefined;
    return this.mode.maxPacketLifeTime - (this.clock.now() - msg.born);
  }

  /**
   * Cumulative ack: every message up to and including `seq` arrived.
   * @param {number} seq
   */
  onAck(seq) {
    for (const [s, msg] of this.#unacked) {
      if (!serial.le(s, seq)) break;
      this.#unacked.delete(s);
      this.#unackedBytes -= msg.payload.length;
    }
    if (!this.#unacked.size) this.#clearTimer();
    this.pump();
  }

  /**
   * Cumulative credit: the receiver allows sending up to `limit` bytes in total (mod 2^32).
   * @param {number} limit
   */
  onCredit(limit) {
    if (serial.lt(this.#creditLimit, limit)) this.#creditLimit = limit >>> 0;
    this.pump();
  }

  /** Resends every unacknowledged message, e.g. after a route change. */
  retransmitAll() {
    for (const msg of this.#unacked.values()) this.#resend(msg);
    this.pump();
  }

  #resend(msg) {
    if (this.transmit({ seq: msg.seq, payload: msg.payload })) {
      msg.sentAt = this.clock.now();
      msg.tries++;
    }
  }

  #armTimer() {
    if (this.#timer !== null) return;
    this.#timer = this.clock.setInterval(() => this.#checkTimeouts(), Math.max(100, this.rtoMs / 4));
  }

  #clearTimer() {
    if (this.#timer === null) return;
    this.clock.clearInterval(this.#timer);
    this.#timer = null;
  }

  #checkTimeouts() {
    const now = this.clock.now();
    for (const msg of this.#unacked.values()) {
      const rto = Math.min(MAX_RTO_MS, this.rtoMs * 2 ** (msg.tries - 1));
      if (now - msg.sentAt >= rto) this.#resend(msg);
    }
  }

  /** Stops timers and drops all buffers. */
  close() {
    this.#clearTimer();
    this.#queue = [];
    this.#unacked.clear();
    this.#queuedBytes = 0;
    this.#unackedBytes = 0;
  }

  /** True when nothing is queued or unacknowledged. */
  get idle() {
    return !this.#queue.length && !this.#unacked.size;
  }
}

/**
 * Receiving half of an end to end channel: deduplication, ordering, cumulative acks and credit
 * grants (plan section 9.2, 9.3).
 */
export class ChannelReceiver {
  #cumulative = 0;
  #held = new Map();
  #seen = new Set();
  #highest = 0;
  #lastOrdered = 0;
  #unackedCount = 0;
  #ackTimer = null;
  #delivered = 0;
  #granted = INITIAL_CREDIT;

  /**
   * @param {object} options
   * @param {Mode} options.mode
   * @param {import("../util/clock.js").Clock} options.clock
   * @param {(payload: Uint8Array) => void} options.deliver
   * @param {(seq: number) => void} options.sendAck
   * @param {(limit: number) => void} options.sendCredit
   * @param {number} [options.ackDelayMs]
   * @param {number} [options.ackEvery]
   * @param {number} [options.window] credit window in bytes
   */
  constructor({ mode, clock, deliver, sendAck, sendCredit, ackDelayMs = 100, ackEvery = 32, window = 1048576 }) {
    this.mode = mode;
    this.reliable = isReliable(mode);
    this.clock = clock;
    this.deliver = deliver;
    this.sendAck = sendAck;
    this.sendCredit = sendCredit;
    this.ackDelayMs = ackDelayMs;
    this.ackEvery = ackEvery;
    this.window = window;
  }

  /** Highest seq up to which everything was received (reliable channels). */
  get cumulative() {
    return this.#cumulative;
  }

  /**
   * Handles one arrived message.
   * @param {number} seq
   * @param {Uint8Array} payload
   */
  receive(seq, payload) {
    if (this.reliable) this.#receiveReliable(seq, payload);
    else if (this.mode.ordered) this.#receiveOrderedUnreliable(seq, payload);
    else this.#receiveUnorderedUnreliable(seq, payload);
  }

  #receiveReliable(seq, payload) {
    if (serial.le(seq, this.#cumulative) || this.#held.has(seq)) {
      this.#scheduleAck(true);
      return;
    }
    if (this.mode.ordered) {
      this.#held.set(seq, payload);
      let next = serial.add(this.#cumulative, 1);
      while (this.#held.has(next)) {
        const p = this.#held.get(next);
        this.#held.delete(next);
        this.#cumulative = next;
        this.#hand(p);
        next = serial.add(next, 1);
      }
    } else {
      this.#held.set(seq, null);
      this.#hand(payload);
      let next = serial.add(this.#cumulative, 1);
      while (this.#held.has(next)) {
        this.#held.delete(next);
        this.#cumulative = next;
        next = serial.add(next, 1);
      }
    }
    this.#scheduleAck(false);
  }

  #receiveOrderedUnreliable(seq, payload) {
    if (this.#lastOrdered !== 0 && serial.le(seq, this.#lastOrdered)) return;
    this.#lastOrdered = seq;
    this.#hand(payload);
  }

  #receiveUnorderedUnreliable(seq, payload) {
    if (this.#seen.has(seq)) return;
    if (this.#highest !== 0 && serial.diff(seq, this.#highest) >= UNORDERED_WINDOW) return;
    this.#seen.add(seq);
    if (this.#highest === 0 || serial.lt(this.#highest, seq)) this.#highest = seq;
    if (this.#seen.size > UNORDERED_WINDOW) {
      for (const s of this.#seen) if (serial.diff(s, this.#highest) >= UNORDERED_WINDOW) this.#seen.delete(s);
    }
    this.#hand(payload);
  }

  #hand(payload) {
    this.deliver(payload);
    if (!this.reliable) return;
    this.#delivered = (this.#delivered + payload.length) >>> 0;
    const limit = (this.#delivered + this.window) >>> 0;
    if (serial.diff(this.#granted, limit) >= this.window / 4) {
      this.#granted = limit;
      this.sendCredit(limit);
    }
  }

  #scheduleAck(now) {
    this.#unackedCount++;
    if (now || this.#unackedCount >= this.ackEvery) return this.flushAck();
    if (this.#ackTimer === null) this.#ackTimer = this.clock.setTimeout(() => this.flushAck(), this.ackDelayMs);
  }

  /** Sends the pending cumulative ack now. */
  flushAck() {
    if (this.#ackTimer !== null) this.clock.clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    this.#unackedCount = 0;
    this.sendAck(this.#cumulative);
  }

  /** Re-sends the current credit grant (after a route change a grant may have been lost). */
  regrant() {
    if (this.reliable) this.sendCredit(this.#granted);
  }

  close() {
    if (this.#ackTimer !== null) this.clock.clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    this.#held.clear();
    this.#seen.clear();
  }
}
