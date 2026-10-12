/**
 * Recovery schedule of a direct link (plan section 5, doc §4.5): ICE restarts with backoff, then
 * full rebuilds, then `unreachable` with a background re-probe at growing intervals.
 *
 * Pure scheduling: the owner supplies the actions and reports health. `run()` resolves with
 * `"recovered"`, `"unreachable"` or `"cancelled"`.
 */
export class RecoverySchedule {
  #token = 0;
  #healthyWaiters = new Set();
  #reprobeTimer = null;
  #reprobeIndex = 0;
  running = false;

  /**
   * @param {object} options
   * @param {import("../util/clock.js").Clock} options.clock
   * @param {number[]} options.backoffMs
   * @param {number} options.rebuildAttempts
   * @param {number} options.stepTimeoutMs
   * @param {number[]} options.reprobeMs
   * @param {() => boolean} options.healthy
   * @param {(step: {kind: "restart"|"rebuild"|"turn", attempt: number}) => void} options.act
   * @param {() => boolean} [options.canAddTurn]
   * @param {() => void} [options.onreprobe] called on each background re-probe
   */
  constructor(options) {
    Object.assign(this, options);
  }

  /** Reports that the link became healthy. */
  noteHealthy() {
    for (const w of this.#healthyWaiters) w(true);
    this.#healthyWaiters.clear();
    this.stopReprobe();
  }

  #sleep(ms, token) {
    return new Promise((resolve) => {
      const id = this.clock.setTimeout(() => {
        this.#healthyWaiters.delete(wake);
        resolve(token === this.#token ? false : "cancelled");
      }, ms);
      const wake = (ok) => {
        this.clock.clearTimeout(id);
        resolve(ok);
      };
      this.#healthyWaiters.add(wake);
    });
  }

  /** Runs the schedule until the link is healthy or all steps are used. */
  async run() {
    if (this.running) return "running";
    this.running = true;
    const token = ++this.#token;
    try {
      const steps = [
        ...this.backoffMs.map((delay, i) => ({ delay, kind: "restart", attempt: i + 1 })),
        ...Array.from({ length: this.rebuildAttempts }, (_, i) => ({ delay: 0, kind: "rebuild", attempt: i + 1 })),
      ];
      for (const step of steps) {
        if (step.delay) {
          const r = await this.#sleep(step.delay, token);
          if (r === "cancelled" || token !== this.#token) return "cancelled";
          if (r === true || this.healthy()) return "recovered";
        }
        this.act(step);
        const r = await this.#sleep(this.stepTimeoutMs, token);
        if (r === "cancelled" || token !== this.#token) return "cancelled";
        if (r === true || this.healthy()) return "recovered";
      }
      if (this.canAddTurn?.()) {
        this.act({ kind: "turn", attempt: 1 });
        const r = await this.#sleep(this.stepTimeoutMs, token);
        if (r === "cancelled" || token !== this.#token) return "cancelled";
        if (r === true || this.healthy()) return "recovered";
      }
      this.#scheduleReprobe();
      return "unreachable";
    } finally {
      if (token === this.#token) this.running = false;
    }
  }

  #scheduleReprobe() {
    this.stopReprobe();
    const ms = this.reprobeMs[Math.min(this.#reprobeIndex, this.reprobeMs.length - 1)];
    this.#reprobeIndex++;
    this.#reprobeTimer = this.clock.setTimeout(() => {
      this.#reprobeTimer = null;
      if (this.healthy()) return;
      this.onreprobe?.();
      this.act({ kind: "rebuild", attempt: 0 });
      this.#scheduleReprobe();
    }, ms);
  }

  stopReprobe() {
    if (this.#reprobeTimer !== null) this.clock.clearTimeout(this.#reprobeTimer);
    this.#reprobeTimer = null;
  }

  /** Resets the re-probe interval sequence (after a successful recovery). */
  resetReprobe() {
    this.#reprobeIndex = 0;
  }

  /** Cancels a running schedule and the re-probe. */
  cancel() {
    this.#token++;
    this.running = false;
    for (const w of this.#healthyWaiters) w("cancelled");
    this.#healthyWaiters.clear();
    this.stopReprobe();
  }
}
