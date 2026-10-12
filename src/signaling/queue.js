/**
 * Runs async tasks strictly one after another (doc §2.2). A failing task does not stop the chain;
 * its error goes to `onError`.
 */
export class SerialQueue {
  #tail = Promise.resolve();

  /** @param {(error: unknown) => void} [onError] */
  constructor(onError) {
    this.onError = onError;
  }

  /**
   * Appends a task. Returns a promise of its result that never rejects (resolves undefined on
   * error).
   * @template T
   * @param {() => T | Promise<T>} task
   * @returns {Promise<T | undefined>}
   */
  push(task) {
    const run = this.#tail.then(task).catch((error) => {
      this.onError?.(error);
      return undefined;
    });
    this.#tail = run;
    return run;
  }
}

/** Remembers recently seen message ids, bounded in size (doc §2.5). */
export class Dedupe {
  #seen = new Set();

  constructor(limit = 4096) {
    this.limit = limit;
  }

  /** Returns true the first time an id is seen, false for duplicates. */
  first(id) {
    if (id == null) return true;
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > this.limit) this.#seen.delete(this.#seen.values().next().value);
    return true;
  }
}

/**
 * Collects ICE candidates for `delayMs`, deduplicates them and flushes them as one batch
 * (doc §2.4). Candidates already flushed are not sent again, also after an ICE restart.
 */
export class CandidateBatcher {
  #pending = [];
  #sent = new Set();
  #timer = null;

  /**
   * @param {import("../util/clock.js").Clock} clock
   * @param {number} delayMs
   * @param {(candidates: object[]) => void} flush
   */
  constructor(clock, delayMs, flush) {
    this.clock = clock;
    this.delayMs = delayMs;
    this.flush = flush;
  }

  /** @param {{candidate: string, sdpMid?: string|null, sdpMLineIndex?: number|null, usernameFragment?: string|null}} c */
  add(c) {
    const key = `${c.usernameFragment ?? ""}|${c.candidate}`;
    if (this.#sent.has(key)) return;
    this.#sent.add(key);
    this.#pending.push(c);
    if (this.#timer === null) this.#timer = this.clock.setTimeout(() => this.drain(), this.delayMs);
  }

  /** Flushes pending candidates now. */
  drain() {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#pending.length) return;
    const batch = this.#pending;
    this.#pending = [];
    this.flush(batch);
  }

  close() {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending = [];
  }
}
