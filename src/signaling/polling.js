/**
 * Signaling adapter for the PHP reference server (`server/php/signal.php`): repeated polling
 * (pull), no long-lived requests. Each request carries the queued outgoing messages and returns
 * the pending incoming ones plus the group's member list, from which presence events are derived.
 *
 * The adapter polls every `fastMs` while signaling is active (a message sent or received within
 * `activeMs`) and every `idleMs` otherwise; once the mesh is up, most signaling goes over it and
 * the server only sees idle polls. The server suggests both intervals; options override them.
 * Messages queued when a request fails are dropped, like the WebSocket adapter does while
 * disconnected: the library retries what matters.
 */
export class PollingSignaling {
  #queue = [];
  #inflight = false;
  #again = false;
  #timer = null;
  #closed = false;
  #ok = null;
  #failures = 0;
  #members = new Set();
  #lastActivity = -Infinity;
  #serverFastMs = 250;
  #serverIdleMs = 3000;

  /**
   * @param {string} url endpoint, e.g. `https://example.com/realtic/signal.php` (relative URLs
   *   resolve against the page)
   * @param {string} selfId
   * @param {object} [options]
   * @param {string} [options.group]
   * @param {number} [options.fastMs] poll interval while active (server default 250)
   * @param {number} [options.idleMs] poll interval while idle (server default 3000)
   * @param {number} [options.activeMs] how long a message keeps polling fast
   * @param {number} [options.timeoutMs] request timeout
   * @param {typeof fetch} [options.fetch]
   */
  constructor(url, selfId, { group = "default", fastMs, idleMs, activeMs = 5000, timeoutMs = 10000, fetch: fetchFn } = {}) {
    const u = new URL(url, globalThis.location?.href);
    u.searchParams.set("group", group);
    u.searchParams.set("id", selfId);
    this.url = u.toString();
    this.selfId = selfId;
    this.group = group;
    this.fastMs = fastMs;
    this.idleMs = idleMs;
    this.activeMs = activeMs;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchFn ?? ((...args) => globalThis.fetch(...args));
    /** @type {((from: string, message: object) => void) | null} */
    this.onmessage = null;
    /** @type {((event: {type: "join"|"leave", peer: string}) => void) | null} */
    this.onpresence = null;
    /** @type {((connected: boolean) => void) | null} */
    this.onstatus = null;
    this.#schedule(0);
  }

  /** False after a failed request until the next one succeeds; true before the first answer. */
  get connected() {
    return this.#ok !== false;
  }

  /**
   * Queues a message; the next request goes out right away.
   * @param {string} to
   * @param {object} message
   */
  send(to, message) {
    if (this.#closed) throw new Error("signaling closed");
    if (this.#ok === false) throw new Error("signaling not connected");
    this.#queue.push({ to, msg: message });
    this.#lastActivity = Date.now();
    this.#schedule(0);
  }

  /**
   * Sends via `navigator.sendBeacon`, for `pagehide`.
   * @param {string} to
   * @param {object} message
   */
  sendBeacon(to, message) {
    return this.#beacon({ send: [{ to, msg: message }] });
  }

  /** Stops polling and tells the server this client left. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    const body = { send: this.#queue.splice(0), leave: true };
    if (!this.#beacon(body)) this.fetch(this.url, this.#init(body, { keepalive: true })).catch(() => {});
  }

  #beacon(body) {
    return globalThis.navigator?.sendBeacon?.(this.url, JSON.stringify(body)) ?? false;
  }

  #init(body, extra = {}) {
    return { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body), cache: "no-store", ...extra };
  }

  #schedule(delay) {
    if (this.#closed) return;
    if (this.#inflight) {
      if (delay === 0) this.#again = true;
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#poll(), delay);
  }

  #interval() {
    const active = Date.now() - this.#lastActivity < this.activeMs;
    return active ? (this.fastMs ?? this.#serverFastMs) : (this.idleMs ?? this.#serverIdleMs);
  }

  async #poll() {
    if (this.#closed) return;
    this.#inflight = true;
    this.#again = false;
    const send = this.#queue.splice(0);
    let body = null;
    try {
      const response = await this.fetch(this.url, this.#init({ send }, { signal: AbortSignal.timeout(this.timeoutMs) }));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch {
      this.#queue.length = 0;
    }
    this.#inflight = false;
    this.#setOk(body !== null);
    if (body) {
      this.#failures = 0;
      this.#receive(body);
      this.#schedule(this.#again || this.#queue.length ? 0 : this.#interval());
    } else {
      this.#schedule(Math.min(10000, 500 * 2 ** this.#failures++));
    }
  }

  #setOk(ok) {
    if (this.#ok === ok) return;
    this.#ok = ok;
    this.onstatus?.(ok);
  }

  #receive(body) {
    if (this.#closed) return;
    if (Number.isFinite(body.fastMs)) this.#serverFastMs = body.fastMs;
    if (Number.isFinite(body.idleMs)) this.#serverIdleMs = body.idleMs;
    const members = new Set(Array.isArray(body.members) ? body.members.filter((m) => m !== this.selfId) : []);
    const previous = this.#members;
    this.#members = members;
    for (const peer of previous) if (!members.has(peer)) this.#emit(() => this.onpresence?.({ type: "leave", peer }));
    for (const peer of members) if (!previous.has(peer)) this.#emit(() => this.onpresence?.({ type: "join", peer }));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length) this.#lastActivity = Date.now();
    for (const { from, msg } of messages) if (typeof from === "string" && msg && typeof msg === "object") this.#emit(() => this.onmessage?.(from, msg));
  }

  #emit(fn) {
    try {
      fn();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
