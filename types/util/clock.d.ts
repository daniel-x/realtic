/**
 * Injectable clock. Library code takes time and timers only from a clock object, so unit tests
 * can drive time with `RalFakeClock`.
 * @typedef {object} Clock
 * @property {() => number} now milliseconds, monotonic within a clock
 * @property {() => number} wallNow UTC milliseconds since the epoch
 * @property {(fn: () => void, ms: number) => any} setTimeout
 * @property {(id: any) => void} clearTimeout
 * @property {(fn: () => void, ms: number) => any} setInterval
 * @property {(id: any) => void} clearInterval
 */
/** @type {Clock} */
export const realClock: Clock;
/** Deterministic clock for tests. `advance(ms)` runs due timers in order. */
export class RalFakeClock {
    constructor(epoch?: number);
    now(): number;
    wallNow(): number;
    setTimeout(fn: any, ms: any): number;
    clearTimeout(id: any): void;
    setInterval(fn: any, ms: any): number;
    clearInterval(id: any): void;
    /** Advances time by `ms`, running every timer that becomes due, in time order. */
    advance(ms: any): void;
    /** Number of pending timers. */
    get pending(): number;
    #private;
}
/**
 * Injectable clock. Library code takes time and timers only from a clock object, so unit tests
 * can drive time with `RalFakeClock`.
 */
export type Clock = {
    /**
     * milliseconds, monotonic within a clock
     */
    now: () => number;
    /**
     * UTC milliseconds since the epoch
     */
    wallNow: () => number;
    setTimeout: (fn: () => void, ms: number) => any;
    clearTimeout: (id: any) => void;
    setInterval: (fn: () => void, ms: number) => any;
    clearInterval: (id: any) => void;
};
