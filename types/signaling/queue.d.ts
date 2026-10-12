/**
 * Runs async tasks strictly one after another (doc §2.2). A failing task does not stop the chain;
 * its error goes to `onError`.
 */
export class SerialQueue {
    /** @param {(error: unknown) => void} [onError] */
    constructor(onError?: (error: unknown) => void);
    onError: (error: unknown) => void;
    /**
     * Appends a task. Returns a promise of its result that never rejects (resolves undefined on
     * error).
     * @template T
     * @param {() => T | Promise<T>} task
     * @returns {Promise<T | undefined>}
     */
    push<T>(task: () => T | Promise<T>): Promise<T | undefined>;
    #private;
}
/** Remembers recently seen message ids, bounded in size (doc §2.5). */
export class Dedupe {
    constructor(limit?: number);
    limit: number;
    /** Returns true the first time an id is seen, false for duplicates. */
    first(id: any): boolean;
    #private;
}
/**
 * Collects ICE candidates for `delayMs`, deduplicates them and flushes them as one batch
 * (doc §2.4). Candidates already flushed are not sent again, also after an ICE restart.
 */
export class CandidateBatcher {
    /**
     * @param {import("../util/clock.js").Clock} clock
     * @param {number} delayMs
     * @param {(candidates: object[]) => void} flush
     */
    constructor(clock: import("../util/clock.js").Clock, delayMs: number, flush: (candidates: object[]) => void);
    clock: import("../util/clock.js").Clock;
    delayMs: number;
    flush: (candidates: object[]) => void;
    /** @param {{candidate: string, sdpMid?: string|null, sdpMLineIndex?: number|null, usernameFragment?: string|null}} c */
    add(c: {
        candidate: string;
        sdpMid?: string | null;
        sdpMLineIndex?: number | null;
        usernameFragment?: string | null;
    }): void;
    /** Flushes pending candidates now. */
    drain(): void;
    close(): void;
    #private;
}
