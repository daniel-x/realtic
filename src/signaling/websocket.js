/**
 * Reference WebSocket signaling adapter for the example server (`examples/server`). Wire format:
 * JSON frames `{ to, msg }` from the client, `{ from, msg }` and `{ presence, peer }` from the
 * server. Reconnects with backoff; messages sent while disconnected are dropped (the library
 * retries what matters, and stale signaling is worse than lost signaling, doc §2.1).
 */
export class WebSocketSignaling {
  #ws = null;
  #closed = false;
  #retry = 0;
  #timer = null;

  /**
   * @param {string} url server URL, e.g. `wss://example.com/signal`
   * @param {string} selfId
   * @param {{room?: string, WebSocket?: typeof WebSocket}} [options]
   */
  constructor(url, selfId, { room = "default", WebSocket: WS = globalThis.WebSocket } = {}) {
    this.url = url;
    this.selfId = selfId;
    this.room = room;
    this.WS = WS;
    /** @type {((from: string, message: object) => void) | null} */
    this.onmessage = null;
    /** @type {((event: {type: "join"|"leave", peer: string}) => void) | null} */
    this.onpresence = null;
    /** @type {((connected: boolean) => void) | null} */
    this.onstatus = null;
    this.#connect();
  }

  /** True while the socket is open. */
  get connected() {
    return this.#ws?.readyState === 1;
  }

  #connect() {
    if (this.#closed) return;
    const u = new URL(this.url);
    u.searchParams.set("id", this.selfId);
    u.searchParams.set("room", this.room);
    const ws = new this.WS(u.toString());
    this.#ws = ws;
    ws.onopen = () => {
      this.#retry = 0;
      this.onstatus?.(true);
    };
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
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.onstatus?.(false);
      const delay = Math.min(10000, 500 * 2 ** this.#retry++);
      this.#timer = setTimeout(() => this.#connect(), delay);
    };
    ws.onerror = () => {};
  }

  /**
   * @param {string} to
   * @param {object} message
   */
  send(to, message) {
    if (!this.connected) throw new Error("signaling not connected");
    this.#ws.send(JSON.stringify({ to, msg: message }));
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
    u.searchParams.set("room", this.room);
    return globalThis.navigator?.sendBeacon?.(u.toString(), JSON.stringify({ to, msg: message })) ?? false;
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#ws?.close();
  }
}
