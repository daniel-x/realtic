/**
 * Injectable clock. Library code takes time and timers only from a clock object, so unit tests
 * can drive time with `RalFakeClock`.
 * @typedef {object} Clock
 * @property {() => number} now milliseconds, monotonic within a clock
 * @property {() => number} wallNow UTC milliseconds since the epoch, with a microsecond fraction
 * @property {(fn: () => void, ms: number) => any} setTimeout
 * @property {(id: any) => void} clearTimeout
 * @property {(fn: () => void, ms: number) => any} setInterval
 * @property {(id: any) => void} clearInterval
 */

const WALL_RESYNC_MS = 1;
let wallOffset = globalThis.performance ? Date.now() - performance.now() : 0;

/**
 * UTC time with the resolution of `performance.now()`. It follows `Date.now()` within
 * `WALL_RESYNC_MS`, so a clock adjustment or a paused monotonic clock does not make it drift.
 */
function wallNow() {
  if (!globalThis.performance) return Date.now();
  const mono = performance.now();
  const wall = Date.now();
  if (Math.abs(wallOffset + mono - wall) > WALL_RESYNC_MS) wallOffset = wall - mono;
  return wallOffset + mono;
}

/** @type {Clock} */
export const realClock = {
  now: () => (globalThis.performance ? performance.now() : Date.now()),
  wallNow,
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
};

/** Deterministic clock for tests. `advance(ms)` runs due timers in order. */
export class RalFakeClock {
  #time = 0;
  #epoch;
  #timers = new Map();
  #nextId = 1;

  constructor(epoch = Date.UTC(2026, 0, 1)) {
    this.#epoch = epoch;
  }

  now() {
    return this.#time;
  }

  wallNow() {
    return this.#epoch + this.#time;
  }

  setTimeout(fn, ms) {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#time + Math.max(0, ms), fn, every: 0 });
    return id;
  }

  clearTimeout(id) {
    this.#timers.delete(id);
  }

  setInterval(fn, ms) {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#time + ms, fn, every: Math.max(1, ms) });
    return id;
  }

  clearInterval(id) {
    this.#timers.delete(id);
  }

  /** Advances time by `ms`, running every timer that becomes due, in time order. */
  advance(ms) {
    const end = this.#time + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of this.#timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      this.#time = t.at;
      if (t.every) t.at += t.every;
      else this.#timers.delete(id);
      t.fn();
    }
    this.#time = end;
  }

  /** Number of pending timers. */
  get pending() {
    return this.#timers.size;
  }
}
