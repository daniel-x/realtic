import { ChannelSender, ChannelReceiver } from "./reliability.js";
import { RealticChannel } from "./channel.js";
import { TYPE } from "../transport/framing.js";
import { modeKey, REL, UNREL } from "../transport/hop-channels.js";
import { Emitter } from "../util/emitter.js";

const CONTROL = 0;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * End to end session with one remote peer (plan section 9.2): the end to end control channel 0,
 * user channels, acks and credits. Route-agnostic: envelopes go out through `transmit` and come
 * in through `receive`.
 *
 * Events: `channel` (RealticChannel), `control` (msg) for control messages other than channel
 * setup, `beat`.
 */
export class Session extends Emitter {
  #channels = new Map();
  #senders = new Map();
  #receivers = new Map();
  #nextId;
  #closed = false;

  /**
   * @param {object} options
   * @param {boolean} options.impolite
   * @param {Readonly<typeof import("../config.js").DEFAULTS>} options.config
   * @param {import("../util/clock.js").Clock} options.clock
   * @param {(e: {type: number, channelId: number, seq: number, payload: Uint8Array, lifetime?: number}, key: string) => boolean} options.transmit
   * @param {ReturnType<import("../diag/log.js").Log["scope"]>} options.log
   */
  constructor({ impolite, config, clock, transmit, log }) {
    super();
    this.impolite = impolite;
    this.config = config;
    this.clock = clock;
    this.transmit = transmit;
    this.l = log;
    this.#nextId = impolite ? 2 : 1;
    this.#setup(CONTROL, { ordered: true });
  }

  #setup(id, mode) {
    const key = modeKey(mode);
    const sender = new ChannelSender({
      mode,
      clock: this.clock,
      bufferLimit: this.config.reliableBufferBytes,
      rtoMs: this.config.retransmitTimeoutMs,
      transmit: (m) => this.transmit({ type: TYPE.DATA, channelId: id, seq: m.seq, payload: m.payload, lifetime: m.lifetime }, key),
      onDrain: () => this.#channels.get(id)?._drained(Infinity),
    });
    const receiver = new ChannelReceiver({
      mode,
      clock: this.clock,
      ackDelayMs: this.config.ackDelayMs,
      ackEvery: this.config.ackEvery,
      window: this.config.creditWindowBytes,
      deliver: (payload) => (id === CONTROL ? this.#onControl(payload) : this.#channels.get(id)?._deliver(payload)),
      sendAck: (seq) => this.transmit({ type: TYPE.ACK, channelId: id, seq: 0, payload: u32(seq) }, REL),
      sendCredit: (limit) => this.transmit({ type: TYPE.CREDIT, channelId: id, seq: 0, payload: u32(limit) }, REL),
    });
    this.#senders.set(id, sender);
    this.#receivers.set(id, receiver);
  }

  /**
   * Creates a user channel (state `connecting`) and announces it with `ch-open`.
   * @param {string} label
   * @param {{ordered?: boolean, maxRetransmits?: number, maxPacketLifeTime?: number, protocol?: string}} [init]
   */
  createChannel(label, init = {}) {
    if (init.maxRetransmits != null && init.maxPacketLifeTime != null) {
      throw new TypeError("maxRetransmits and maxPacketLifeTime are mutually exclusive");
    }
    const id = this.#nextId;
    this.#nextId += 2;
    if (id > 0xffff) throw new RangeError("channel ids exhausted");
    const channel = new RealticChannel(this, id, { label, ...init });
    this.#channels.set(id, channel);
    this.#setup(id, modeOf(channel));
    this.sendControl({
      t: "ch-open",
      id,
      label,
      protocol: channel.protocol,
      ordered: channel.ordered,
      maxRetransmits: channel.maxRetransmits,
      maxPacketLifeTime: channel.maxPacketLifeTime,
    });
    return channel;
  }

  /**
   * Sends a message on the end to end control channel.
   * @param {object} msg
   */
  sendControl(msg) {
    if (this.#closed) return;
    this.#senders.get(CONTROL).send(encoder.encode(JSON.stringify(msg)));
  }

  /** @internal used by RealticChannel */
  sendUser(id, payload) {
    this.#senders.get(id).send(payload);
  }

  /** @internal used by RealticChannel */
  bufferedAmount(id) {
    return this.#senders.get(id)?.queuedBytes ?? 0;
  }

  /** @internal used by RealticChannel */
  closeChannel(id) {
    const sender = this.#senders.get(id);
    const finish = () => {
      this.sendControl({ t: "ch-close", id });
      this.#finishClose(id);
    };
    if (!sender || sender.idle || !sender.reliable) return finish();
    const timer = this.clock.setInterval(() => {
      if (sender.idle || this.#closed) {
        this.clock.clearInterval(timer);
        finish();
      }
    }, 50);
  }

  #finishClose(id) {
    const ch = this.#channels.get(id);
    this.#senders.get(id)?.close();
    this.#receivers.get(id)?.close();
    this.#senders.delete(id);
    this.#receivers.delete(id);
    this.#channels.delete(id);
    ch?._setState("closed");
  }

  #onControl(payload) {
    let msg;
    try {
      msg = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    switch (msg.t) {
      case "ch-open": {
        if (this.#channels.has(msg.id) || typeof msg.id !== "number") return;
        const channel = new RealticChannel(this, msg.id, {
          label: String(msg.label ?? ""),
          protocol: msg.protocol,
          ordered: msg.ordered !== false,
          maxRetransmits: msg.maxRetransmits ?? undefined,
          maxPacketLifeTime: msg.maxPacketLifeTime ?? undefined,
        });
        this.#channels.set(msg.id, channel);
        this.#setup(msg.id, modeOf(channel));
        this.sendControl({ t: "ch-ack", id: msg.id });
        this.l.info("channel opened by remote", { id: msg.id, label: channel.label });
        this.emit("channel", channel);
        queueMicrotask(() => channel._setState("open"));
        return;
      }
      case "ch-ack": {
        const ch = this.#channels.get(msg.id);
        if (ch && ch.readyState === "connecting") ch._setState("open");
        return;
      }
      case "ch-close": {
        const ch = this.#channels.get(msg.id);
        if (!ch) return;
        this.#finishClose(msg.id);
        return;
      }
      default:
        this.emit("control", msg);
    }
  }

  /**
   * Handles one complete (reassembled, decrypted) envelope.
   * @param {{type: number, channelId: number, seq: number}} e
   * @param {Uint8Array} payload
   */
  receive(e, payload) {
    if (this.#closed) return;
    switch (e.type) {
      case TYPE.DATA:
        this.#receivers.get(e.channelId)?.receive(e.seq, payload);
        return;
      case TYPE.ACK:
        if (payload.length >= 4) this.#senders.get(e.channelId)?.onAck(readU32(payload));
        return;
      case TYPE.CREDIT:
        if (payload.length >= 4) this.#senders.get(e.channelId)?.onCredit(readU32(payload));
        return;
      case TYPE.BEAT:
        this.emit("beat");
        return;
      default:
    }
  }

  /** Sends an end to end beat (relayed routes). */
  sendBeat() {
    this.transmit({ type: TYPE.BEAT, channelId: CONTROL, seq: 0, payload: new Uint8Array(0) }, UNREL);
  }

  /** After a route change: resend unacknowledged data and re-grant credit. */
  routeChanged() {
    for (const s of this.#senders.values()) s.retransmitAll();
    for (const r of this.#receivers.values()) r.regrant();
  }

  /** Lets senders hand queued data to the route again (transport drained). */
  pump() {
    for (const [id, s] of this.#senders) {
      const before = s.queuedBytes;
      s.pump();
      if (s.queuedBytes < before) this.#channels.get(id)?._drained(before);
    }
  }

  /** Open user channels. */
  get channels() {
    return [...this.#channels.values()];
  }

  /** Total bytes not yet acknowledged over all reliable channels. */
  get unackedBytes() {
    let n = 0;
    for (const s of this.#senders.values()) n += s.unackedBytes + s.queuedBytes;
    return n;
  }

  /** Closes all channels. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const id of [...this.#channels.keys()]) this.#finishClose(id);
    for (const s of this.#senders.values()) s.close();
    for (const r of this.#receivers.values()) r.close();
    this.removeAllListeners();
  }
}

function modeOf(channel) {
  return {
    ordered: channel.ordered,
    maxRetransmits: channel.maxRetransmits ?? undefined,
    maxPacketLifeTime: channel.maxPacketLifeTime ?? undefined,
  };
}

function u32(n) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

function readU32(b) {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0);
}
