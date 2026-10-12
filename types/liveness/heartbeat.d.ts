/**
 * One way idle heartbeat (doc §3.5): calls `beat()` whenever nothing was sent for `idleMs`.
 * The owner calls `noteSent()` on every send.
 */
export class Heartbeat {
    /**
     * @param {import("../util/clock.js").Clock} clock
     * @param {number} idleMs
     * @param {() => void} beat
     */
    constructor(clock: import("../util/clock.js").Clock, idleMs: number, beat: () => void);
    clock: import("../util/clock.js").Clock;
    idleMs: number;
    beat: () => void;
    noteSent(): void;
    start(): void;
    /** Sends a beat now, e.g. on `visibilitychange` to visible. */
    now(): void;
    stop(): void;
    #private;
}
