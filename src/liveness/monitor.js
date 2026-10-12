/**
 * Receiver side silence judgment (plan section 6). Pure logic: the owner feeds arrival times and
 * calls `check()` periodically; state changes go to `onchange(state, silenceMs)`.
 *
 * Normal mode: the last arrival of data or media counts. Background mode (the remote side
 * announced `bg`): ICE consent arrivals count too, with the longer background thresholds.
 */
export class LivenessMonitor {
  #lastData;
  #lastMedia = -Infinity;
  #lastConsent = -Infinity;
  #state = "ok";
  #background = false;

  /**
   * @param {object} options
   * @param {() => number} options.now
   * @param {number} options.slowMs
   * @param {number} options.staleMs
   * @param {number} [options.backgroundSlowMs]
   * @param {number} [options.backgroundStaleMs]
   * @param {(state: "ok"|"slow"|"stale", silenceMs: number) => void} [options.onchange]
   */
  constructor({ now, slowMs, staleMs, backgroundSlowMs = slowMs, backgroundStaleMs = staleMs, onchange }) {
    this.now = now;
    this.slowMs = slowMs;
    this.staleMs = staleMs;
    this.backgroundSlowMs = backgroundSlowMs;
    this.backgroundStaleMs = backgroundStaleMs;
    this.onchange = onchange;
    this.#lastData = now();
  }

  /**
   * Monitor with the thresholds of a group config (doc §3.5).
   * @param {Readonly<typeof import("../config.js").DEFAULTS>} config
   * @param {() => number} now
   * @param {(state: "ok"|"slow"|"stale", silenceMs: number) => void} onchange
   */
  static fromConfig(config, now, onchange) {
    return new LivenessMonitor({
      now,
      slowMs: config.SLOW_CONNECTION_MS,
      staleMs: config.STALE_CONNECTION_MS,
      backgroundSlowMs: config.BACKGROUND_SLOW_MS,
      backgroundStaleMs: config.BACKGROUND_STALE_MS,
      onchange,
    });
  }

  /** Current verdict. */
  get state() {
    return this.#state;
  }

  /** True while the remote side is in background mode. */
  get background() {
    return this.#background;
  }

  /** Records data arriving now. */
  noteData() {
    this.#lastData = this.now();
    if (this.#state !== "ok") this.check();
  }

  /** Records media arrival at local time `at` (derived from getStats). */
  noteMedia(at) {
    if (at > this.#lastMedia) this.#lastMedia = at;
  }

  /** Records ICE consent arrival at local time `at`. */
  noteConsent(at) {
    if (at > this.#lastConsent) this.#lastConsent = at;
  }

  /** Enters or leaves background mode. */
  setBackground(on) {
    this.#background = on;
    if (!on) this.#lastData = Math.max(this.#lastData, this.now());
  }

  /** Restarts the silence measurement, e.g. after an ICE restart. */
  reset() {
    this.#lastData = this.now();
    this.#set("ok", 0);
  }

  /** Silence in milliseconds, as counted in the current mode. */
  get silence() {
    let last = Math.max(this.#lastData, this.#lastMedia);
    if (this.#background) last = Math.max(last, this.#lastConsent);
    return Math.max(0, this.now() - last);
  }

  /** Silence of data alone. */
  get dataSilence() {
    return Math.max(0, this.now() - this.#lastData);
  }

  /** Evaluates the current silence and returns the state. */
  check() {
    const silence = this.silence;
    const slow = this.#background ? this.backgroundSlowMs : this.slowMs;
    const stale = this.#background ? this.backgroundStaleMs : this.staleMs;
    this.#set(silence >= stale ? "stale" : silence >= slow ? "slow" : "ok", silence);
    return this.#state;
  }

  #set(state, silence) {
    if (state === this.#state) return;
    this.#state = state;
    this.onchange?.(state, silence);
  }
}
