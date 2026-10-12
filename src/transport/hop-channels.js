/**
 * Per-link transport channels by reliability class (plan section 5, 9.3). One instance belongs to
 * one RTCPeerConnection generation.
 *
 * - `ctl` (id 0) reliable ordered: JSON control messages and the 1 byte beat.
 * - `rel` (id 1) reliable ordered: envelopes of reliable channels.
 * - `unrel` (id 2) unordered, maxRetransmits 0: envelopes of unreliable channels and beats.
 * - partial reliability modes: ids from 3, owned by the impolite side. The impolite side creates
 *   the channel and announces it with `transport-open`; it holds the channel's envelopes until
 *   the polite side answers `transport-ready`, because data that arrives before the polite side
 *   created its end of the negotiated channel is lost.
 *
 * Envelopes are queued per flow and sent round robin while the channel's `bufferedAmount` is
 * below the high water mark, so one bulk flow does not starve the others.
 */

import { Emitter } from "../util/emitter.js";

export const CTL = "ctl";
export const REL = "rel";
export const UNREL = "unrel";

/**
 * Transport key of an end to end reliability mode.
 * @param {{ordered: boolean, maxRetransmits?: number|null, maxPacketLifeTime?: number|null}} mode
 */
export function modeKey(mode) {
  if (mode.maxRetransmits == null && mode.maxPacketLifeTime == null) return REL;
  if (!mode.ordered && mode.maxRetransmits === 0) return UNREL;
  return `o${mode.ordered ? 1 : 0}:r${mode.maxRetransmits ?? "-"}:l${mode.maxPacketLifeTime ?? "-"}`;
}

/** Parses a partial mode key back into a mode. */
export function parseModeKey(key) {
  if (key === REL || key === CTL) return { ordered: true };
  if (key === UNREL) return { ordered: false, maxRetransmits: 0 };
  const m = /^o([01]):r(-|\d+):l(-|\d+)$/.exec(key);
  if (!m) return null;
  return {
    ordered: m[1] === "1",
    maxRetransmits: m[2] === "-" ? undefined : Number(m[2]),
    maxPacketLifeTime: m[3] === "-" ? undefined : Number(m[3]),
  };
}

const FIXED = { [CTL]: 0, [REL]: 1, [UNREL]: 2 };
const CTL_BACKLOG_LIMIT = 256;

class FlowQueue {
  items = [];
  bytes = 0;
}

/** Transport channels of one peer connection. */
export class HopChannels extends Emitter {
  #pc;
  #impolite;
  #channels = new Map();
  #queues = new Map();
  #ctlBacklog = [];
  #nextId = 3;
  #pendingModes = new Set();
  #unconfirmed = new Set();
  #closed = false;

  /**
   * @param {RTCPeerConnection} pc
   * @param {object} options
   * @param {boolean} options.impolite
   * @param {number} options.highWater
   * @param {number} options.lowWater
   * @param {number} options.flowLimit per-flow queue limit in bytes
   * @param {(event: string, data?: object) => void} [options.log]
   */
  constructor(pc, { impolite, highWater, lowWater, flowLimit, log }) {
    super();
    this.#pc = pc;
    this.#impolite = impolite;
    this.highWater = highWater;
    this.lowWater = lowWater;
    this.flowLimit = flowLimit;
    this.log = log ?? (() => {});
    for (const [key, id] of Object.entries(FIXED)) this.#create(key, id, parseModeKey(key));
  }

  /** True when `ctl` is open. */
  get ctlOpen() {
    return this.#channels.get(CTL)?.readyState === "open";
  }

  /** The SCTP maximum message size, or 65536 when unknown. */
  get maxMessageSize() {
    const n = this.#pc.sctp?.maxMessageSize;
    return n && Number.isFinite(n) && n > 0 ? n : 65536;
  }

  #create(key, id, mode) {
    const init = { negotiated: true, id, ordered: mode.ordered };
    if (mode.maxRetransmits != null) init.maxRetransmits = mode.maxRetransmits;
    else if (mode.maxPacketLifeTime != null) init.maxPacketLifeTime = mode.maxPacketLifeTime;
    const dc = this.#pc.createDataChannel(key, init);
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = this.lowWater;
    dc.onopen = () => {
      this.log("transport open", { key, id });
      if (key === CTL) {
        const backlog = this.#ctlBacklog;
        this.#ctlBacklog = [];
        for (const m of backlog) this.#sendCtlNow(m);
      }
      this.emit("open", key);
      this.#drain(key);
    };
    dc.onclose = () => {
      if (!this.#closed) this.emit("transportclose", key);
    };
    dc.onerror = (e) => {
      if (!this.#closed) this.log("transport error", { key, error: e?.error?.message ?? String(e?.error ?? "") });
    };
    dc.onbufferedamountlow = () => {
      this.#drain(key);
      this.emit("drain", key);
    };
    dc.onmessage = (event) => this.#onMessage(key, event.data);
    this.#channels.set(key, dc);
    return dc;
  }

  #onMessage(key, data) {
    if (key === CTL) {
      if (typeof data === "string") {
        let msg;
        try {
          msg = JSON.parse(data);
        } catch {
          return this.emit("activity", key);
        }
        this.emit("ctl", msg);
      } else {
        this.emit("beat");
      }
      return;
    }
    if (typeof data === "string") return;
    this.emit("envelope", new Uint8Array(data), key);
  }

  /**
   * Sends a control message on `ctl`. Queued while `ctl` is not open.
   * @param {object} msg
   */
  sendCtl(msg) {
    if (this.#closed) return false;
    if (!this.ctlOpen) {
      if (this.#ctlBacklog.length < CTL_BACKLOG_LIMIT) this.#ctlBacklog.push(msg);
      return false;
    }
    return this.#sendCtlNow(msg);
  }

  #sendCtlNow(msg) {
    try {
      this.#channels.get(CTL).send(JSON.stringify(msg));
      this.emit("sent");
      return true;
    } catch (error) {
      this.log("ctl send failed", { t: msg.t, error: error.message });
      return false;
    }
  }

  /** Sends the 1 byte heartbeat on `ctl`. */
  sendBeat() {
    if (!this.ctlOpen) return false;
    try {
      this.#channels.get(CTL).send(BEAT);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Queues an envelope for `key`'s transport channel. Returns false when the flow's queue is
   * full; unreliable flows then drop their oldest message instead and return true.
   * @param {string} key transport key from `modeKey`
   * @param {string} flow flow identifier for fair scheduling
   * @param {Uint8Array} bytes
   */
  sendEnvelope(key, flow, bytes) {
    if (this.#closed) return false;
    if (!this.#channels.has(key)) this.ensureMode(key);
    let queues = this.#queues.get(key);
    if (!queues) this.#queues.set(key, (queues = new Map()));
    let q = queues.get(flow);
    if (!q) queues.set(flow, (q = new FlowQueue()));
    if (q.bytes + bytes.length > this.flowLimit && q.items.length) {
      if (key === REL) return false;
      while (q.items.length && q.bytes + bytes.length > this.flowLimit) q.bytes -= q.items.shift().length;
    }
    q.items.push(bytes);
    q.bytes += bytes.length;
    this.#drain(key);
    return true;
  }

  /** Bytes queued for `flow` on `key` that the browser has not taken yet. */
  queuedBytes(key, flow) {
    return this.#queues.get(key)?.get(flow)?.bytes ?? 0;
  }

  #drain(key) {
    const dc = this.#channels.get(key);
    const queues = this.#queues.get(key);
    if (!dc || !queues || dc.readyState !== "open" || this.#unconfirmed.has(key)) return;
    let progressed = true;
    while (progressed && dc.bufferedAmount < this.highWater) {
      progressed = false;
      for (const [flow, q] of queues) {
        if (!q.items.length) {
          queues.delete(flow);
          continue;
        }
        const bytes = q.items.shift();
        q.bytes -= bytes.length;
        try {
          dc.send(bytes);
          this.emit("sent");
        } catch (error) {
          this.log("envelope send failed", { key, size: bytes.length, error: error.message });
        }
        progressed = true;
        if (dc.bufferedAmount >= this.highWater) break;
      }
    }
  }

  /**
   * Makes sure a partial reliability transport exists. The impolite side creates it and
   * announces `transport-open`; the polite side asks with `open-transport` (decision D25).
   * @param {string} key
   */
  ensureMode(key) {
    if (this.#channels.has(key) || this.#pendingModes.has(key)) return;
    const mode = parseModeKey(key);
    if (!mode) return;
    if (this.#impolite) {
      const id = this.#nextId++;
      this.#unconfirmed.add(key);
      this.#create(key, id, mode);
      this.sendCtl({ t: "transport-open", id, mode: { ...mode } });
    } else {
      this.#pendingModes.add(key);
      this.sendCtl({ t: "open-transport", mode: { ...mode } });
    }
  }

  /**
   * Handles the transport control messages. Returns true when `msg` was one of them.
   * @param {object} msg
   */
  handleCtl(msg) {
    if (msg.t === "transport-open" && !this.#impolite) {
      const key = modeKey(msg.mode);
      this.#pendingModes.delete(key);
      if (!this.#channels.has(key)) this.#create(key, msg.id, parseModeKey(key));
      this.sendCtl({ t: "transport-ready", id: msg.id, mode: msg.mode });
      return true;
    }
    if (msg.t === "transport-ready" && this.#impolite) {
      const key = modeKey(msg.mode);
      if (this.#unconfirmed.delete(key)) this.#drain(key);
      return true;
    }
    if (msg.t === "open-transport" && this.#impolite) {
      this.ensureMode(modeKey(msg.mode));
      return true;
    }
    return false;
  }

  /** Transport channels with their negotiated reliability, for diagnostics. */
  describe() {
    return [...this.#channels].map(([key, dc]) => ({ key, id: dc.id, ordered: dc.ordered, maxRetransmits: dc.maxRetransmits, maxPacketLifeTime: dc.maxPacketLifeTime, readyState: dc.readyState }));
  }

  /** Total bufferedAmount over all transport channels. */
  get bufferedAmount() {
    let n = 0;
    for (const dc of this.#channels.values()) n += dc.bufferedAmount;
    return n;
  }

  close() {
    this.#closed = true;
    for (const dc of this.#channels.values()) {
      dc.onmessage = dc.onopen = dc.onclose = dc.onerror = dc.onbufferedamountlow = null;
      try {
        dc.close();
      } catch {
        // already closed
      }
    }
    this.#channels.clear();
    this.#queues.clear();
    this.removeAllListeners();
  }
}

const BEAT = new Uint8Array([0]);
