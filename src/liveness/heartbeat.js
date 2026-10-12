/**
 * One way idle heartbeat (doc §3.5): calls `beat()` whenever nothing was sent for `idleMs`.
 * The owner calls `noteSent()` on every send.
 */
export class Heartbeat {
  #lastSent;
  #timer = null;

  /**
   * @param {import("../util/clock.js").Clock} clock
   * @param {number} idleMs
   * @param {() => void} beat
   */
  constructor(clock, idleMs, beat) {
    this.clock = clock;
    this.idleMs = idleMs;
    this.beat = beat;
    this.#lastSent = clock.now();
  }

  noteSent() {
    this.#lastSent = this.clock.now();
  }

  start() {
    if (this.#timer !== null) return;
    const tick = Math.max(20, Math.floor(this.idleMs / 4));
    this.#timer = this.clock.setInterval(() => {
      if (this.clock.now() - this.#lastSent >= this.idleMs) {
        this.#lastSent = this.clock.now();
        this.beat();
      }
    }, tick);
  }

  /** Sends a beat now, e.g. on `visibilitychange` to visible. */
  now() {
    this.#lastSent = this.clock.now();
    this.beat();
  }

  stop() {
    if (this.#timer !== null) this.clock.clearInterval(this.#timer);
    this.#timer = null;
  }
}
