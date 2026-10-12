/**
 * Data channel open watchdog (doc §3.7): armed on ICE `connected`, cleared when `ctl` opens.
 * Fires `onfire` after `timeoutMs` without being cleared.
 */
export class Watchdog {
  #timer = null;

  /**
   * @param {import("../util/clock.js").Clock} clock
   * @param {number} timeoutMs
   * @param {() => void} onfire
   */
  constructor(clock, timeoutMs, onfire) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.onfire = onfire;
  }

  /** Arms the watchdog unless it is already armed. */
  arm() {
    if (this.#timer !== null) return;
    this.#timer = this.clock.setTimeout(() => {
      this.#timer = null;
      this.onfire();
    }, this.timeoutMs);
  }

  clear() {
    if (this.#timer !== null) this.clock.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
