/**
 * Reference WebSocket signaling adapter for the Node reference server (realtic-server-node). Wire
 * format: JSON frames `{ to, msg }` from the client, `{ from, msg }` and `{ presence, peer }` from
 * the server. Reconnects with backoff; messages sent while disconnected are dropped (the library
 * retries what matters, and stale signaling is worse than lost signaling, doc §2.1).
 */
export class RalWebSocketSignaling {
  #ws = null;
  #closed = false;
  #retry = 0;
  #timer = null;
  #next = null;
  #queued = [];

  /**
   * @param {string} url server URL, e.g. `wss://example.com/signal`
   * @param {string} selfId
   * @param {{group?: string, WebSocket?: typeof WebSocket}} [options]
   */
  constructor(url, selfId, { group = "default", WebSocket: WS = globalThis.WebSocket } = {}) {
    this.url = url;
    this.selfId = selfId;
    this.group = group;
    this.WS = WS;
    /** @type {((from: string, message: object) => void) | null} */
    this.onmessage = null;
    /** @type {((event: {type: "join"|"leave", peer: string}) => void) | null} */
    this.onpresence = null;
    /** @type {((connected: boolean) => void) | null} */
    this.onstatus = null;
    this.#connect();
  }

  /** True while the socket is open, or while `resume()` replaces it. */
  get connected() {
    return this.#ws?.readyState === 1 || this.#next !== null;
  }

  #socket() {
    const u = new URL(this.url);
    u.searchParams.set("id", this.selfId);
    u.searchParams.set("group", this.group);
    const ws = new this.WS(u.toString());
    ws.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.presence) this.onpresence?.({ type: frame.presence, peer: frame.peer });
      else if (frame.from && frame.msg) this.onmessage?.(frame.from, frame.msg);
    };
    ws.onerror = () => {};
    return ws;
  }

  #connect() {
    if (this.#closed) return;
    const ws = this.#socket();
    this.#ws = ws;
    this.#adopt(ws);
  }

  #adopt(ws) {
    ws.onopen = () => {
      this.#retry = 0;
      this.onstatus?.(true);
    };
    ws.onclose = () => {
      if (this.#ws === ws && !this.#next) this.#lost();
    };
  }

  #lost() {
    if (this.#closed) return;
    this.onstatus?.(false);
    const delay = Math.min(10000, 500 * 2 ** this.#retry++);
    this.#timer = setTimeout(() => this.#connect(), delay);
  }

  /**
   * @param {string} to
   * @param {object} message
   */
  send(to, message) {
    if (!this.connected) throw new Error("signaling not connected");
    const frame = JSON.stringify({ to, msg: message });
    if (this.#next) this.#queued.push(frame);
    else this.#ws.send(frame);
  }

  /**
   * Sends via `navigator.sendBeacon` to the server's HTTP endpoint, for `pagehide`.
   * @param {string} to
   * @param {object} message
   */
  sendBeacon(to, message) {
    const u = new URL(this.url);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = u.pathname.replace(/\/?$/, "/beacon");
    u.searchParams.set("id", this.selfId);
    u.searchParams.set("group", this.group);
    return globalThis.navigator?.sendBeacon?.(u.toString(), JSON.stringify({ to, msg: message })) ?? false;
  }

  /**
   * Replaces the socket, e.g. after the device slept: the old one may be dead without notice.
   * Make before break: messages sent until the new socket opens wait for it, then the old one
   * closes. If the new socket fails, the queued messages are dropped and the old one stays.
   */
  resume() {
    if (this.#closed || this.#next) return;
    if (this.#ws?.readyState !== 1) {
      clearTimeout(this.#timer);
      this.#retry = 0;
      this.#ws?.close();
      this.#connect();
      return;
    }
    const next = this.#socket();
    this.#next = next;
    next.onopen = () => {
      const old = this.#ws;
      this.#next = null;
      this.#ws = next;
      this.#adopt(next);
      for (const frame of this.#queued.splice(0)) next.send(frame);
      old.close();
    };
    next.onclose = () => {
      if (this.#next !== next) return;
      this.#next = null;
      this.#queued.length = 0;
      if (this.#ws.readyState !== 1) this.#lost();
    };
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#queued.length = 0;
    this.#next?.close();
    this.#ws?.close();
  }
}
