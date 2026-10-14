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
export function directBudgets(availableBps: number, flows: {
    id: string;
    kind: "audio" | "video";
    weight?: number;
}[], { headroom, audioReserveBps }: {
    headroom: number;
    audioReserveBps: number;
}): Map<string, number>;
/**
 * Budget a multicasting relay reports to the origin for one flow: the minimum over its
 * destination hops (decision D3). Undefined when there is no destination.
 * @param {number[]} destinationBudgets
 */
export function relayBudget(destinationBudgets: number[]): number;
/**
 * `scaleResolutionDownBy` for a budget, from steps `[[bps, scale], ...]` in descending bps.
 * @param {number} bps
 * @param {[number, number][]} steps
 */
export function scaleFor(bps: number, steps: [number, number][]): number;
/**
 * Decides when a budget report goes out: at most every `intervalMs`, at once when a budget
 * dropped by more than `dropFraction` since the last report.
 */
export class BudgetReporter {
    /**
     * @param {{now: () => number}} clock
     * @param {number} intervalMs
     * @param {number} dropFraction
     */
    constructor(clock: {
        now: () => number;
    }, intervalMs: number, dropFraction: number);
    clock: {
        now: () => number;
    };
    intervalMs: number;
    dropFraction: number;
    /**
     * Returns true when `budgets` should be reported now, and records them as reported.
     * @param {Map<string, number>} budgets
     */
    due(budgets: Map<string, number>): boolean;
    #private;
}
