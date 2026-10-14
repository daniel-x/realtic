/**
 * Signaling adapter interface (plan section 4.1):
 *
 * ```js
 * { send(to, message), onmessage: (from, message) => {}, onpresence?: (event) => {}, close() }
 * ```
 *
 * `send` may return a promise; a rejected or thrown send counts as lost. `onpresence` receives
 * `{ type: "join" | "leave", peer }`. Adapters may implement `sendBeacon(to, message)` for use
 * from `pagehide`, and `resume()`, which the group calls after the device slept.
 * @typedef {object} SignalingAdapter
 * @property {(to: string, message: object) => (void | Promise<void>)} send
 * @property {((from: string, message: object) => void) | null} onmessage
 * @property {((event: {type: "join"|"leave", peer: string}) => void) | null} [onpresence]
 * @property {(to: string, message: object) => boolean} [sendBeacon]
 * @property {() => void} [resume]
 * @property {() => void} close
 */

/**
 * In-memory signaling hub for tests and same-page demos. Messages are delivered asynchronously;
 * the hub can be taken down, delayed and made to duplicate messages.
 */
export class RalMemoryHub {
  #members = new Map();

  constructor({ delayMs = 0, duplicate = false } = {}) {
    this.delayMs = delayMs;
    this.duplicate = duplicate;
    this.down = false;
  }

  /**
   * Returns an adapter for `id`.
   * @param {string} id
   * @returns {SignalingAdapter}
   */
  join(id) {
    const adapter = {
      onmessage: null,
      onpresence: null,
      send: (to, message) => this.#deliver(id, to, message),
      close: () => {
        this.#members.delete(id);
        for (const other of this.#members.values()) other.onpresence?.({ type: "leave", peer: id });
      },
    };
    for (const [otherId, other] of this.#members) {
      other.onpresence?.({ type: "join", peer: id });
      queueMicrotask(() => adapter.onpresence?.({ type: "join", peer: otherId }));
    }
    this.#members.set(id, adapter);
    return adapter;
  }

  #deliver(from, to, message) {
    if (this.down) throw new Error("signaling down");
    const copy = JSON.parse(JSON.stringify(message));
    const times = this.duplicate ? 2 : 1;
    for (let i = 0; i < times; i++) {
      setTimeout(() => this.#members.get(to)?.onmessage?.(from, copy), this.delayMs);
    }
  }
}
