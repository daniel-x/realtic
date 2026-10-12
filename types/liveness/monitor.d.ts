/**
 * Receiver side silence judgment (plan section 6). Pure logic: the owner feeds arrival times and
 * calls `check()` periodically; state changes go to `onchange(state, silenceMs)`.
 *
 * Normal mode: the last arrival of data or media counts. Background mode (the remote side
 * announced `bg`): ICE consent arrivals count too, with the longer background thresholds.
 */
export class LivenessMonitor {
    /**
     * Monitor with the thresholds of a group config (doc §3.5).
     * @param {Readonly<typeof import("../config.js").DEFAULTS>} config
     * @param {() => number} now
     * @param {(state: "ok"|"slow"|"stale", silenceMs: number) => void} onchange
     */
    static fromConfig(config: Readonly<typeof import("../config.js").DEFAULTS>, now: () => number, onchange: (state: "ok" | "slow" | "stale", silenceMs: number) => void): LivenessMonitor;
    /**
     * @param {object} options
     * @param {() => number} options.now
     * @param {number} options.slowMs
     * @param {number} options.staleMs
     * @param {number} [options.backgroundSlowMs]
     * @param {number} [options.backgroundStaleMs]
     * @param {(state: "ok"|"slow"|"stale", silenceMs: number) => void} [options.onchange]
     */
    constructor({ now, slowMs, staleMs, backgroundSlowMs, backgroundStaleMs, onchange }: {
        now: () => number;
        slowMs: number;
        staleMs: number;
        backgroundSlowMs?: number;
        backgroundStaleMs?: number;
        onchange?: (state: "ok" | "slow" | "stale", silenceMs: number) => void;
    });
    now: () => number;
    slowMs: number;
    staleMs: number;
    backgroundSlowMs: number;
    backgroundStaleMs: number;
    onchange: (state: "ok" | "slow" | "stale", silenceMs: number) => void;
    /** Current verdict. */
    get state(): string;
    /** True while the remote side is in background mode. */
    get background(): boolean;
    /** Records data arriving now. */
    noteData(): void;
    /** Records media arrival at local time `at` (derived from getStats). */
    noteMedia(at: any): void;
    /** Records ICE consent arrival at local time `at`. */
    noteConsent(at: any): void;
    /** Enters or leaves background mode. */
    setBackground(on: any): void;
    /** Restarts the silence measurement, e.g. after an ICE restart. */
    reset(): void;
    /** Silence in milliseconds, as counted in the current mode. */
    get silence(): number;
    /** Silence of data alone. */
    get dataSilence(): number;
    /** Evaluates the current silence and returns the state. */
    check(): string;
    #private;
}
