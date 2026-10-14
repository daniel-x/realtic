/**
 * Recovery schedule of a direct connection (plan section 5, doc §4.5): ICE restarts with backoff,
 * then full rebuilds, then `unreachable` with a background re-probe at growing intervals.
 *
 * Pure scheduling: the owner supplies the actions and reports health. `run()` resolves with
 * `"recovered"`, `"unreachable"` or `"cancelled"`.
 */
export class RecoverySchedule {
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
    constructor(options: {
        clock: import("../util/clock.js").Clock;
        backoffMs: number[];
        rebuildAttempts: number;
        stepTimeoutMs: number;
        reprobeMs: number[];
        healthy: () => boolean;
        act: (step: {
            kind: "restart" | "rebuild" | "turn";
            attempt: number;
        }) => void;
        canAddTurn?: () => boolean;
        onreprobe?: () => void;
    });
    running: boolean;
    /** Reports that the direct connection became healthy. */
    noteHealthy(): void;
    /** Runs the schedule until the direct connection is healthy or all steps are used. */
    run(): Promise<"running" | "cancelled" | "recovered" | "unreachable">;
    stopReprobe(): void;
    /** Resets the re-probe interval sequence (after a successful recovery). */
    resetReprobe(): void;
    /** Cancels a running schedule and the re-probe. */
    cancel(): void;
    #private;
}
