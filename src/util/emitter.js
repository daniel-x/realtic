/**
 * Minimal event emitter. Listener errors are caught and passed to `onListenerError`, so one
 * faulty app handler cannot break library state machines.
 */
export class Emitter {
  #listeners = new Map();

  /** Called with (error, eventName) when a listener throws. */
  onListenerError = null;

  /**
   * @param {string} name
   * @param {(...args: any[]) => void} fn
   * @returns {() => void} function that removes the listener
   */
  on(name, fn) {
    let set = this.#listeners.get(name);
    if (!set) this.#listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => this.off(name, fn);
  }

  /**
   * @param {string} name
   * @param {(...args: any[]) => void} fn
   */
  once(name, fn) {
    const off = this.on(name, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  /**
   * @param {string} name
   * @param {(...args: any[]) => void} fn
   */
  off(name, fn) {
    this.#listeners.get(name)?.delete(fn);
  }

  /**
   * @param {string} name
   * @param {...any} args
   */
  emit(name, ...args) {
    const set = this.#listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch (error) {
        try {
          this.onListenerError?.(error, name);
        } catch {
          // a broken error sink must not break the emitter
        }
      }
    }
  }

  /** Removes all listeners. */
  removeAllListeners() {
    this.#listeners.clear();
  }
}
