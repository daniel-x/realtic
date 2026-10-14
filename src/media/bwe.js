/**
 * Per-flow bitrate budgets (plan section 10.4). Pure functions plus a report throttle.
 */

/**
 * Splits a direct connection's outgoing bitrate into per-flow budgets: audio flows get a fixed
 * reservation, video flows share the remainder by weight.
 * @param {number} availableBps
 * @param {{id: string, kind: "audio"|"video", weight?: number}[]} flows
 * @param {{headroom: number, audioReserveBps: number}} options
 * @returns {Map<string, number>}
 */
export function directBudgets(availableBps, flows, { headroom, audioReserveBps }) {
  const out = new Map();
  let rest = Math.max(0, availableBps * headroom);
  const audio = flows.filter((f) => f.kind === "audio");
  const video = flows.filter((f) => f.kind !== "audio");
  for (const f of audio) {
    const b = Math.min(audioReserveBps, rest / Math.max(1, audio.length - audio.indexOf(f)));
    out.set(f.id, Math.round(b));
    rest -= b;
  }
  const weights = video.reduce((s, f) => s + (f.weight ?? 1), 0);
  for (const f of video) out.set(f.id, Math.round(weights ? (rest * (f.weight ?? 1)) / weights : 0));
  return out;
}

/**
 * Budget a multicasting relay reports to the origin for one flow: the minimum over its
 * destination hops (decision D3). Undefined when there is no destination.
 * @param {number[]} destinationBudgets
 */
export function relayBudget(destinationBudgets) {
  if (!destinationBudgets.length) return undefined;
  return Math.min(...destinationBudgets);
}

/**
 * `scaleResolutionDownBy` for a budget, from steps `[[bps, scale], ...]` in descending bps.
 * @param {number} bps
 * @param {[number, number][]} steps
 */
export function scaleFor(bps, steps) {
  let scale = 1;
  for (const [limit, s] of steps) if (bps < limit) scale = s;
  return scale;
}

/**
 * Decides when a budget report goes out: at most every `intervalMs`, at once when a budget
 * dropped by more than `dropFraction` since the last report.
 */
export class BudgetReporter {
  #last = new Map();
  #lastAt = -Infinity;

  /**
   * @param {{now: () => number}} clock
   * @param {number} intervalMs
   * @param {number} dropFraction
   */
  constructor(clock, intervalMs, dropFraction) {
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.dropFraction = dropFraction;
  }

  /**
   * Returns true when `budgets` should be reported now, and records them as reported.
   * @param {Map<string, number>} budgets
   */
  due(budgets) {
    const now = this.clock.now();
    let changed = false;
    let urgent = false;
    for (const [id, bps] of budgets) {
      const prev = this.#last.get(id);
      if (prev !== bps) changed = true;
      if (prev !== undefined && bps < prev * (1 - this.dropFraction)) urgent = true;
    }
    if (budgets.size !== this.#last.size) changed = true;
    if (!changed) return false;
    if (!urgent && now - this.#lastAt < this.intervalMs) return false;
    this.#last = new Map(budgets);
    this.#lastAt = now;
    return true;
  }
}
