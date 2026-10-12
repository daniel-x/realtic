import { domError } from "../util/dom.js";

const TEXT = 1;
const BINARY = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encodes a user message: one kind byte (0 binary, 1 text) followed by the bytes.
 * @param {string | ArrayBuffer | ArrayBufferView} data
 */
export function encodeMessage(data) {
  let bytes;
  let kind = BINARY;
  if (typeof data === "string") {
    bytes = encoder.encode(data);
    kind = TEXT;
  } else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else throw new TypeError("send() accepts string, ArrayBuffer or ArrayBufferView");
  const out = new Uint8Array(bytes.length + 1);
  out[0] = kind;
  out.set(bytes, 1);
  return out;
}

/**
 * Decodes a user message into a string or an ArrayBuffer.
 * @param {Uint8Array} payload
 */
export function decodeMessage(payload) {
  if (payload[0] === TEXT) return decoder.decode(payload.subarray(1));
  return payload.slice(1).buffer;
}

function makeEvent(type, init) {
  if (type === "message" && typeof MessageEvent === "function") return new MessageEvent("message", init);
  const e = new Event(type);
  if (init) Object.assign(e, init);
  return e;
}

/**
 * End to end data channel with `RTCDataChannel`-like API (plan section 9.2). Survives route
 * changes, ICE restarts and link rebuilds. Created by `peer.createChannel()` or delivered by the
 * peer's `channel` event.
 */
export class ReatChannel extends EventTarget {
  #state = "connecting";
  #session;
  #threshold = 0;
  #handlers = {};

  /**
   * @param {object} session internal end to end session
   * @param {number} id
   * @param {{label: string, protocol?: string, ordered?: boolean, maxRetransmits?: number, maxPacketLifeTime?: number}} init
   */
  constructor(session, id, init) {
    super();
    this.#session = session;
    /** End to end channel id. */
    this.id = id;
    this.label = init.label;
    this.protocol = init.protocol ?? "";
    this.ordered = init.ordered ?? true;
    this.maxRetransmits = init.maxRetransmits ?? null;
    this.maxPacketLifeTime = init.maxPacketLifeTime ?? null;
    this.negotiated = false;
    /** Only `"arraybuffer"` is supported. */
    this.binaryType = "arraybuffer";
  }

  /** `connecting` | `open` | `closing` | `closed` */
  get readyState() {
    return this.#state;
  }

  /** Bytes accepted by `send` and not yet handed to the network. */
  get bufferedAmount() {
    return this.#session.bufferedAmount(this.id);
  }

  get bufferedAmountLowThreshold() {
    return this.#threshold;
  }

  set bufferedAmountLowThreshold(n) {
    this.#threshold = Math.max(0, Number(n) || 0);
  }

  /**
   * Sends a message. Throws `InvalidStateError` unless open, and `OperationError` when the
   * outage buffer of a reliable channel is full.
   * @param {string | ArrayBuffer | ArrayBufferView} data
   */
  send(data) {
    if (this.#state !== "open") throw domError(`channel is ${this.#state}`, "InvalidStateError");
    this.#session.sendUser(this.id, encodeMessage(data));
  }

  /** Closes the channel after the reliable data sent before is delivered. */
  close() {
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#state = "closing";
    this.#session.closeChannel(this.id);
  }

  /** @internal */
  _setState(state) {
    if (this.#state === state || this.#state === "closed") return;
    this.#state = state;
    if (state === "open") this.#fire("open");
    if (state === "closed") this.#fire("close");
  }

  /** @internal */
  _deliver(payload) {
    if (this.#state !== "open" && this.#state !== "closing") return;
    this.#fire("message", { data: decodeMessage(payload) });
  }

  /** @internal */
  _drained(before) {
    const now = this.bufferedAmount;
    if (before > this.#threshold && now <= this.#threshold) this.#fire("bufferedamountlow");
  }

  #fire(type, init) {
    this.dispatchEvent(makeEvent(type, init));
  }

  get onopen() {
    return this.#handlers.open ?? null;
  }
  set onopen(fn) {
    this.#setHandler("open", fn);
  }
  get onmessage() {
    return this.#handlers.message ?? null;
  }
  set onmessage(fn) {
    this.#setHandler("message", fn);
  }
  get onclose() {
    return this.#handlers.close ?? null;
  }
  set onclose(fn) {
    this.#setHandler("close", fn);
  }
  get onerror() {
    return this.#handlers.error ?? null;
  }
  set onerror(fn) {
    this.#setHandler("error", fn);
  }
  get onbufferedamountlow() {
    return this.#handlers.bufferedamountlow ?? null;
  }
  set onbufferedamountlow(fn) {
    this.#setHandler("bufferedamountlow", fn);
  }

  #setHandler(type, fn) {
    const prev = this.#handlers[`${type}_wrapped`];
    if (prev) this.removeEventListener(type, prev);
    this.#handlers[type] = typeof fn === "function" ? fn : null;
    if (typeof fn !== "function") return;
    const wrapped = (e) => fn.call(this, e);
    this.#handlers[`${type}_wrapped`] = wrapped;
    this.addEventListener(type, wrapped);
  }
}
