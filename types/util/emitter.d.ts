/**
 * Minimal event emitter. Listener errors are caught and passed to `onListenerError`, so one
 * faulty app handler cannot break library state machines.
 */
export class Emitter {
    /** Called with (error, eventName) when a listener throws. */
    onListenerError: any;
    /**
     * @param {string} name
     * @param {(...args: any[]) => void} fn
     * @returns {() => void} function that removes the listener
     */
    on(name: string, fn: (...args: any[]) => void): () => void;
    /**
     * @param {string} name
     * @param {(...args: any[]) => void} fn
     */
    once(name: string, fn: (...args: any[]) => void): () => void;
    /**
     * @param {string} name
     * @param {(...args: any[]) => void} fn
     */
    off(name: string, fn: (...args: any[]) => void): void;
    /**
     * @param {string} name
     * @param {...any} args
     */
    emit(name: string, ...args: any[]): void;
    /** Removes all listeners. */
    removeAllListeners(): void;
    #private;
}
