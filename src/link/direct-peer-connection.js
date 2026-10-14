import { sessionId, randomId } from "../util/ids.js";
import { CandidateBatcher } from "../signaling/queue.js";
import { HopChannels, CTL } from "../transport/hop-channels.js";
import { Negotiator } from "./negotiation.js";
import { Watchdog } from "./watchdog.js";
import { LivenessMonitor } from "../liveness/monitor.js";
import { Heartbeat } from "../liveness/heartbeat.js";
import { readStats, selectedPair } from "../diag/pair-dump.js";

const SLOT_TIMEOUT_MS = 15000;
const VERDICT_REPEAT_MS = 1000;
const classes = new WeakMap();

/**
 * @typedef {object} DirectHooks callbacks of the owning RalPeerConnection
 * @property {(msg: object) => void} signal sends a signaling message (session ids added)
 * @property {(task: () => Promise<void>) => void} enqueue runs a negotiation task in order
 * @property {() => void} open `ctl` opened
 * @property {() => void} ctlClosed the remote side closed `ctl`
 * @property {(msg: object) => void} ctl control message not handled here
 * @property {(bytes: Uint8Array, key: string) => void} envelope
 * @property {(key: string) => void} drain a transport channel can take more data
 * @property {() => void} remotetrack the browser fired `track`
 * @property {() => void} negotiated a negotiation round completed
 * @property {(metrics: object, stats: RTCStatsReport) => void} metrics
 * @property {(state: string, silence: number) => void} liveness local liveness verdict changed
 * @property {(state: string) => void} remoteVerdict the remote side's verdict changed
 * @property {() => void} connected ICE connected for the first time
 * @property {() => void} failed the connection state became `failed`
 * @property {() => void} watchdog `ctl` did not open in time after ICE connected
 * @property {() => void} connectTimeout `ctl` did not open within `connectTimeoutMs`
 */

/** @typedef {InstanceType<ReturnType<typeof defineClass>>} RalDirectPeerConnection */

/**
 * The RalDirectPeerConnection class on top of `Base`, the browser's RTCPeerConnection or an
 * injected subclass of it. Classes are cached per base.
 * @param {typeof RTCPeerConnection} Base
 */
export function directPeerConnectionClass(Base) {
  let C = classes.get(Base);
  if (!C) classes.set(Base, (C = defineClass(Base)));
  return C;
}

/** @param {typeof RTCPeerConnection} Base */
function defineClass(Base) {
  /**
   * One RTCPeerConnection to a neighbor, with realtic's state for it (plan section 5): transport
   * channels and `ctl`, negotiation, liveness, metrics and media slots. It is never replaced
   * under its owner; a rebuild creates a new one. realtic's members carry the `ral` prefix so
   * they cannot collide with the WebRTC API.
   */
  return class RalDirectPeerConnection extends Base {
    #hooks;
    #config;
    #clock;
    #l;
    #hop;
    #neg;
    #batcher;
    #monitor;
    #heartbeat;
    #watchdog;
    #checkTimer = null;
    #statsTimer = null;
    #connectTimer = null;
    #polling = false;
    #lastVerdictAt = -Infinity;
    #remoteVerdict = "ok";
    #lastCounters = new Map();
    #ctlRtt = undefined;
    #metrics = { rtt: undefined, bitrate: undefined, loss: undefined, candidateType: undefined, remoteCandidateType: undefined };
    #ctlOpen = false;
    #everConnected = false;
    #closed = false;
    #retired;
    #onRetired;
    /** @type {{tr: RTCRtpTransceiver, kind: string, key: string|null}[]} */
    #slots = [];
    /** @type {Map<string, {kind: string, resolve: Function, reject: Function}>} */
    #slotRequests = new Map();
    /** @type {{req: string, tr: RTCRtpTransceiver}[]} */
    #grants = [];
    /** @type {Set<Function>} */
    #stableWaiters = new Set();

    /** Session id of this connection. */
    ralSession = sessionId();
    /** Session id of the remote side's connection, once known. */
    ralRemoteSession = null;

    /**
     * @param {RTCConfiguration} rtcConfig
     * @param {object} options
     * @param {object} options.connection the owning RalPeerConnection
     * @param {string} options.remoteId
     * @param {boolean} options.impolite
     * @param {Readonly<typeof import("../config.js").DEFAULTS>} options.config
     * @param {import("../util/clock.js").Clock} options.clock
     * @param {ReturnType<import("../diag/log.js").RalLog["scope"]>} options.log
     * @param {DirectHooks} options.hooks
     */
    constructor(rtcConfig, { connection, remoteId, impolite, config, clock, log, hooks }) {
      super(rtcConfig);
      this.#retired = new Promise((resolve) => (this.#onRetired = resolve));
      /** The RalPeerConnection this connection belongs to. */
      this.ralConnection = connection;
      this.ralRemoteId = remoteId;
      this.ralImpolite = impolite;
      this.#hooks = hooks;
      this.#config = config;
      this.#clock = clock;
      this.#l = log;
      const c = config;
      this.#hop = new HopChannels(this, {
        impolite,
        highWater: c.hopHighWaterBytes,
        lowWater: c.hopLowWaterBytes,
        flowLimit: c.relayQueueBytes,
        log: (msg, data) => log.debug(msg, data),
      });
      this.#hop.on("open", (key) => key === CTL && this.#onCtlOpen());
      this.#hop.on("transportclose", (key) => this.#onTransportClose(key));
      this.#hop.on("beat", () => !this.#closed && this.#monitor.noteData());
      this.#hop.on("ctl", (msg) => this.#onCtl(msg));
      this.#hop.on("envelope", (bytes, key) => {
        if (this.#closed) return;
        this.#monitor.noteData();
        hooks.envelope(bytes, key);
      });
      this.#hop.on("sent", () => this.#heartbeat.noteSent());
      this.#hop.on("drain", (key) => hooks.drain(key));
      this.#batcher = new CandidateBatcher(clock, c.candidateBatchMs, (cands) => this.ralSignal({ t: "cand", c: cands }));
      this.#neg = new Negotiator(this, {
        impolite,
        signal: (msg) => this.ralSignal(msg),
        beforeAnswer: (msg) => this.#applyGrants(msg),
        offerExtras: () => this.#offerExtras(),
        onstable: () => this.#onStable(),
        log: (msg, data) => log.debug(msg, data),
      });
      this.onicecandidate = (e) => {
        if (this.#closed) return;
        if (e.candidate && e.candidate.candidate) this.#batcher.add(e.candidate.toJSON());
        else this.#batcher.drain();
      };
      this.onnegotiationneeded = () => {
        if (this.#closed || !impolite) return;
        hooks.enqueue(() => this.#untilRetired(this.#neg.negotiate("negotiationneeded")));
      };
      this.oniceconnectionstatechange = () => this.#onIceState();
      this.onconnectionstatechange = () => this.#onConnState();
      this.ontrack = () => !this.#closed && hooks.remotetrack();
      this.#monitor = LivenessMonitor.fromConfig(c, () => clock.now(), (state, silence) => this.#onLiveness(state, silence));
      this.#heartbeat = new Heartbeat(clock, c.HEARTBEAT_IDLE_MS, () => this.#hop.sendBeat());
      this.#watchdog = new Watchdog(clock, c.CHANNEL_OPEN_TIMEOUT_MS, () => this.#onWatchdog());
      this.#checkTimer = clock.setInterval(() => this.#check(), c.LIVENESS_CHECK_INTERVAL_MS);
      this.#statsTimer = clock.setInterval(() => this.#collectStats(), c.statsIntervalMs);
      this.#heartbeat.start();
      this.#connectTimer = clock.setTimeout(() => {
        this.#connectTimer = null;
        if (!this.#closed && !this.#ctlOpen) hooks.connectTimeout();
      }, c.connectTimeoutMs);
    }

    /** True after ralRetire(). */
    get ralClosed() {
      return this.#closed;
    }

    /** True when `ctl` is open. */
    get ralCtlOpen() {
      return !this.#closed && this.#ctlOpen;
    }

    /** True when `ctl` is open and data arrives in time. */
    get ralHealthy() {
      return this.ralCtlOpen && this.#monitor.state === "ok" && this.#remoteVerdict !== "stale";
    }

    /** True when the connection can carry traffic now (healthy or slow). */
    get ralUsable() {
      return this.ralCtlOpen && this.#monitor.state !== "stale" && this.#remoteVerdict !== "stale";
    }

    /** Milliseconds since data or media last arrived (consent too in background mode). */
    get ralSilence() {
      return this.ralCtlOpen ? this.#monitor.silence : Infinity;
    }

    /** Liveness verdict: `ok`, `slow` or `stale`. */
    get ralLiveness() {
      return this.#monitor.state;
    }

    /** True while the remote side announced background mode. */
    get ralRemoteBackground() {
      return this.#monitor.background;
    }

    /** Latest metrics (plan section 7.1). */
    get ralMetrics() {
      return { ...this.#metrics, state: this.#metricState() };
    }

    /** True when the selected pair runs over TURN on either side. */
    get ralViaTurn() {
      return this.#metrics.candidateType === "relay" || this.#metrics.remoteCandidateType === "relay";
    }

    /** SCTP maximum message size. */
    get ralMaxMessageSize() {
      return this.#hop.maxMessageSize;
    }

    /** Transport channels, for diagnostics. */
    get ralTransports() {
      return this.#hop.describe();
    }

    /** Total bufferedAmount over the transport channels. */
    get ralBufferedAmount() {
      return this.#hop.bufferedAmount;
    }

    /**
     * Sends a signaling message to the neighbor, tagged with both session ids.
     * @param {object} msg
     */
    ralSignal(msg) {
      if (this.#closed) return;
      this.#hooks.signal({ ...msg, s: this.ralSession, rs: this.ralRemoteSession ?? undefined });
    }

    /**
     * Applies an `offer`, `answer` or `cand` message.
     * @param {object} msg
     */
    ralHandleSignal(msg) {
      if (msg.t === "offer") return this.#untilRetired(this.#neg.handleOffer(msg));
      if (msg.t === "answer") return this.#untilRetired(this.#neg.handleAnswer(msg));
      if (msg.t === "cand") return this.#untilRetired(this.#neg.handleCandidates(msg));
    }

    /** Runs a negotiation round (impolite: offer; polite: `renegotiate`). */
    ralNegotiate(reason) {
      return this.#untilRetired(this.#neg.negotiate(reason));
    }

    /** Restarts ICE now, rolling back an unanswered offer first. */
    ralIceRestart() {
      return this.#untilRetired(this.#iceRestart());
    }

    async #iceRestart() {
      if (this.#closed) return;
      if (this.signalingState === "have-local-offer") {
        this.#l.info("rolling back unanswered offer");
        await this.setLocalDescription({ type: "rollback" });
      }
      this.restartIce();
      await this.#neg.negotiate("ice restart");
    }

    /**
     * Settles with `operation` or when this connection is retired, whichever comes first.
     * Chromium leaves the promise of an operation pending forever when the connection closes
     * under it, which would block the owner's negotiation queue for every later connection.
     */
    #untilRetired(operation) {
      return Promise.race([operation, this.#retired]);
    }

    /**
     * Sends a control message on `ctl`.
     * @param {object} msg
     */
    ralSendCtl(msg) {
      return this.#hop.sendCtl(msg);
    }

    /**
     * Queues an envelope on a transport channel.
     * @param {string} key
     * @param {string} flow
     * @param {Uint8Array} bytes
     */
    ralSendEnvelope(key, flow, bytes) {
      return this.#hop.sendEnvelope(key, flow, bytes);
    }

    /** Bytes queued for a flow on a transport channel. */
    ralQueuedBytes(key, flow) {
      return this.#hop.queuedBytes(key, flow);
    }

    /** Sends `bg` or `fg` (plan section 6.1). */
    ralSetBackground(on) {
      this.ralSendCtl({ t: on ? "bg" : "fg" });
      if (!on) this.#heartbeat.now();
    }

    /** Beats and re-checks liveness now. Returns true when the connection is slow or stale. */
    ralCheckNow() {
      if (!this.ralCtlOpen) return false;
      this.#heartbeat.now();
      this.#monitor.check();
      return this.#monitor.state !== "ok" || this.#remoteVerdict !== "ok";
    }

    /**
     * Records a round trip sample measured with the periodic `link-state` echo. It refreshes every
     * link-state period, while the candidate pair RTT refreshes only with consent checks.
     * @param {number} ms
     */
    ralNoteControlRtt(ms) {
      if (!(ms >= 0) || ms > 60000) return;
      this.#ctlRtt = this.#ctlRtt === undefined ? ms : this.#ctlRtt * 0.5 + ms * 0.5;
      this.#metrics = { ...this.#metrics, rtt: this.#ctlRtt };
    }

    /** Test hook: closes all transport channels, like an SCTP abort. */
    ralAbortTransport() {
      this.#hop.close();
    }

    /**
     * Ends this connection. With `silent`, closing waits 30 s, so the remote side learns of a
     * rebuild only from the new session id (test hook for doc §3.6).
     */
    ralRetire(silent = false) {
      if (this.#closed) return;
      this.#closed = true;
      this.#onRetired();
      if (this.#connectTimer !== null) this.#clock.clearTimeout(this.#connectTimer);
      this.#clock.clearInterval(this.#checkTimer);
      this.#clock.clearInterval(this.#statsTimer);
      this.#heartbeat.stop();
      this.#watchdog.clear();
      this.#batcher.close();
      for (const r of this.#slotRequests.values()) r.reject(new Error("link rebuilt"));
      for (const w of this.#stableWaiters) w(false);
      const close = () => {
        this.#hop.close();
        try {
          this.close();
        } catch {
          // already closed
        }
      };
      if (silent) this.#clock.setTimeout(close, 30000);
      else close();
    }

    #onStable() {
      if (this.#closed) return;
      for (const w of this.#stableWaiters) w(true);
      this.#stableWaiters.clear();
      this.#hooks.negotiated();
    }

    #onIceState() {
      if (this.#closed) return;
      const s = this.iceConnectionState;
      this.#l.debug("ice state", { state: s });
      if ((s === "connected" || s === "completed") && !this.#ctlOpen) this.#watchdog.arm();
    }

    #onConnState() {
      if (this.#closed) return;
      const s = this.connectionState;
      this.#l.debug("connection state", { state: s });
      if (s === "connected" && !this.#everConnected) {
        this.#everConnected = true;
        this.#hooks.connected();
      }
      if (s === "failed") this.#hooks.failed();
    }

    #onCtlOpen() {
      if (this.#closed) return;
      this.#ctlOpen = true;
      this.#watchdog.clear();
      this.#monitor.reset();
      this.#heartbeat.now();
      this.#l.info("control channel open", { session: this.ralSession });
      this.#hooks.open();
    }

    #onTransportClose(key) {
      if (this.#closed) return;
      this.#l.warn("transport channel closed by remote", { key });
      if (key !== CTL) return;
      this.#ctlOpen = false;
      this.#hooks.ctlClosed();
    }

    #onWatchdog() {
      if (this.#closed || this.#ctlOpen) return;
      this.#l.warn("control channel did not open in time", { timeoutMs: this.#config.CHANNEL_OPEN_TIMEOUT_MS });
      this.#hooks.watchdog();
    }

    #onCtl(msg) {
      if (this.#closed) return;
      this.#monitor.noteData();
      if (this.#hop.handleCtl(msg)) return;
      switch (msg.t) {
        case "bg":
          this.#l.info("remote entered background mode");
          this.#monitor.setBackground(true);
          return;
        case "fg":
          this.#l.info("remote left background mode");
          this.#monitor.setBackground(false);
          return;
        case "liveness":
          if (msg.state === this.#remoteVerdict) return;
          this.#remoteVerdict = msg.state;
          this.#l.info("remote liveness verdict", { state: msg.state });
          this.#hooks.remoteVerdict(msg.state);
          return;
        case "slot-request":
          this.#onSlotRequest(msg);
          return;
        default:
          this.#hooks.ctl(msg);
      }
    }

    #onLiveness(state, silence) {
      this.#l.info(`liveness ${state}`, { silenceMs: Math.round(silence), background: this.#monitor.background });
      this.#sendVerdict(state);
      this.#hooks.liveness(state, silence);
    }

    #check() {
      if (!this.ralCtlOpen) return;
      this.#monitor.check();
      if (this.#monitor.state !== "ok" && this.#clock.now() - this.#lastVerdictAt >= VERDICT_REPEAT_MS) this.#sendVerdict(this.#monitor.state);
      if (this.#monitor.dataSilence >= this.#config.LIVENESS_CHECK_INTERVAL_MS && !this.#polling) this.#pollLiveness();
    }

    #sendVerdict(state) {
      this.#lastVerdictAt = this.#clock.now();
      this.#hop.sendCtl({ t: "liveness", state });
    }

    /**
     * Local arrival time of the last packet a stats object counts: from
     * `lastPacketReceivedTimestamp`, or, where a browser lacks it, `fallback` when the `counter`
     * grew since the previous poll.
     */
    #lastArrival(s, counter, key, now, fallback) {
      if (typeof s.lastPacketReceivedTimestamp === "number" && typeof s.timestamp === "number") {
        return now - Math.max(0, s.timestamp - s.lastPacketReceivedTimestamp);
      }
      if (typeof s[counter] !== "number") return undefined;
      const prev = this.#lastCounters.get(key);
      this.#lastCounters.set(key, s[counter]);
      return prev !== undefined && s[counter] > prev ? fallback : undefined;
    }

    async #pollLiveness() {
      this.#polling = true;
      try {
        const stats = await readStats(this);
        if (this.#closed) return;
        const now = this.#clock.now();
        for (const s of stats.values()) {
          if (s.type !== "inbound-rtp") continue;
          const at = this.#lastArrival(s, "bytesReceived", s.id, now, now - this.#config.LIVENESS_CHECK_INTERVAL_MS);
          if (at !== undefined) this.#monitor.noteMedia(at);
        }
        const pair = this.#monitor.background ? selectedPair(stats) : undefined;
        if (pair) {
          const at = this.#lastArrival(pair, "responsesReceived", "consent", now, now);
          if (at !== undefined) this.#monitor.noteConsent(at);
        }
        this.#monitor.check();
      } catch {
        // the connection closed while reading stats
      } finally {
        this.#polling = false;
      }
    }

    async #collectStats() {
      if (!this.ralCtlOpen) return;
      try {
        const stats = await readStats(this);
        if (this.#closed) return;
        const pair = selectedPair(stats);
        const local = pair && stats.get(pair.localCandidateId);
        const remote = pair && stats.get(pair.remoteCandidateId);
        let lossSum = 0;
        let lossN = 0;
        let cpu = false;
        for (const s of stats.values()) {
          if (s.type === "remote-inbound-rtp" && typeof s.fractionLost === "number") {
            lossSum += s.fractionLost;
            lossN++;
          }
          if (s.type === "outbound-rtp" && s.qualityLimitationReason === "cpu") cpu = true;
        }
        this.#metrics = {
          rtt: this.#ctlRtt ?? (pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : this.#metrics.rtt),
          bitrate: pair?.availableOutgoingBitrate ?? undefined,
          loss: lossN ? lossSum / lossN : 0,
          candidateType: local?.candidateType,
          remoteCandidateType: remote?.candidateType,
          cpuLimited: cpu,
          maxMessageSize: this.#hop.maxMessageSize,
        };
        this.#hooks.metrics(this.ralMetrics, stats);
      } catch {
        // the connection closed while reading stats
      }
    }

    #metricState() {
      if (!this.ralCtlOpen) return "down";
      if (this.#remoteVerdict === "stale") return "stale";
      const m = this.#monitor.state;
      return m === "ok" && this.#remoteVerdict === "slow" ? "slow" : m;
    }

    // Media slots. The impolite side creates all transceivers; the polite side asks with
    // `slot-request` and gets the mid in the offer (`grants`).

    /**
     * Returns an idle or new send slot of `kind` and marks it used by `key`.
     * @param {"audio"|"video"} kind
     * @param {string} key
     * @returns {Promise<{tr: RTCRtpTransceiver, kind: string, key: string|null}>}
     */
    async ralAcquireSendSlot(kind, key) {
      if (this.#closed) throw new Error("link rebuilt");
      const idle = this.#slots.find((s) => s.kind === kind && s.key === null && s.tr.mid != null);
      if (idle) {
        idle.key = key;
        return idle;
      }
      if (this.ralImpolite) {
        const tr = this.addTransceiver(kind, { direction: "sendonly" });
        const slot = { tr, kind, key };
        this.#slots.push(slot);
        await this.#waitStable(() => tr.mid != null && tr.currentDirection != null);
        return slot;
      }
      const req = randomId(8);
      return new Promise((resolve, reject) => {
        const timer = this.#clock.setTimeout(() => {
          this.#slotRequests.delete(req);
          reject(new Error("slot request timed out"));
        }, SLOT_TIMEOUT_MS);
        this.#slotRequests.set(req, {
          kind,
          resolve: (slot) => {
            this.#clock.clearTimeout(timer);
            slot.key = key;
            resolve(slot);
          },
          reject: (e) => {
            this.#clock.clearTimeout(timer);
            reject(e);
          },
        });
        this.#hop.sendCtl({ t: "slot-request", req, kind });
      });
    }

    /**
     * Marks a slot idle and stops sending on it. No renegotiation.
     * @param {{tr: RTCRtpTransceiver, key: string|null}} slot
     */
    ralReleaseSendSlot(slot) {
      slot.key = null;
      slot.tr.sender.replaceTrack(null).catch(() => {});
    }

    /** True when the slot belongs to this connection and it is not retired. */
    ralOwnsSlot(slot) {
      return !this.#closed && this.#slots.includes(slot);
    }

    /**
     * The receiving transceiver with `mid`.
     * @param {string} mid
     */
    ralTransceiver(mid) {
      return this.getTransceivers().find((t) => t.mid === mid) ?? null;
    }

    #waitStable(cond) {
      return new Promise((resolve, reject) => {
        const timer = this.#clock.setTimeout(() => {
          this.#stableWaiters.delete(check);
          reject(new Error("negotiation timed out"));
        }, SLOT_TIMEOUT_MS);
        const check = (ok) => {
          if (ok === false) {
            this.#clock.clearTimeout(timer);
            this.#stableWaiters.delete(check);
            reject(new Error("link rebuilt"));
            return;
          }
          if (cond()) {
            this.#clock.clearTimeout(timer);
            this.#stableWaiters.delete(check);
            resolve();
          }
        };
        this.#stableWaiters.add(check);
        if (this.signalingState === "stable" && cond()) check(true);
      });
    }

    #onSlotRequest(msg) {
      if (!this.ralImpolite) return;
      const tr = this.addTransceiver(msg.kind, { direction: "recvonly" });
      this.#grants.push({ req: msg.req, tr });
    }

    #offerExtras() {
      if (!this.#grants.length) return {};
      const grants = [];
      this.#grants = this.#grants.filter((g) => {
        if (g.tr.mid == null) return true;
        grants.push({ req: g.req, mid: g.tr.mid });
        return false;
      });
      return grants.length ? { grants } : {};
    }

    #applyGrants(msg) {
      for (const g of msg.grants ?? []) {
        const tr = this.getTransceivers().find((t) => t.mid === g.mid);
        const request = this.#slotRequests.get(g.req);
        if (!tr || !request) continue;
        this.#slotRequests.delete(g.req);
        tr.direction = "sendonly";
        const slot = { tr, kind: request.kind, key: null };
        this.#slots.push(slot);
        queueMicrotask(() => request.resolve(slot));
      }
    }
  };
}
