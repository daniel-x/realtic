/**
 * Data channel open watchdog (doc §3.7): armed on ICE `connected`, cleared when `ctl` opens.
 * Fires `onfire` after `timeoutMs` without being cleared.
 */
export class Watchdog {
    /**
     * @param {import("../util/clock.js").Clock} clock
     * @param {number} timeoutMs
     * @param {() => void} onfire
     */
    constructor(clock: import("../util/clock.js").Clock, timeoutMs: number, onfire: () => void);
    clock: import("../util/clock.js").Clock;
    timeoutMs: number;
    onfire: () => void;
    /** Arms the watchdog unless it is already armed. */
    arm(): void;
    clear(): void;
    get armed(): boolean;
    #private;
}
