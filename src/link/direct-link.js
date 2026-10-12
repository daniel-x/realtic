import { Emitter } from "../util/emitter.js";
import { sessionId, isImpolite, randomId } from "../util/ids.js";
import { SerialQueue, CandidateBatcher } from "../signaling/queue.js";
import { HopChannels, CTL } from "../transport/hop-channels.js";
import { Negotiator } from "./negotiation.js";
import { Watchdog } from "./watchdog.js";
import { RecoverySchedule } from "./ice-restart.js";
import { LivenessMonitor } from "../liveness/monitor.js";
import { Heartbeat } from "../liveness/heartbeat.js";
import { readStats, selectedPair, pairDump, summarizeDump } from "../diag/pair-dump.js";
import { failureHint } from "../diag/hints.js";

const SLOT_TIMEOUT_MS = 15000;
const RESTART_REQUEST_GAP_MS = 2000;

/**
 * One RTCPeerConnection generation: the connection, its transport channels and per-generation
 * state. A rebuild replaces the whole generation.
 */
class Conn {
  /** @type {RTCPeerConnection} */ pc;
  /** @type {HopChannels} */ hop;
  /** @type {Negotiator} */ neg;
  /** @type {CandidateBatcher} */ batcher;
  session = sessionId();
  remoteSession = null;
  everConnected = false;
  ctlOpen = false;
  connectTimer = null;
  /** @type {{tr: RTCRtpTransceiver, kind: string, key: string|null}[]} */
  slots = [];
  /** @type {Map<string, {kind: string, resolve: Function, reject: Function}>} */
  slotRequests = new Map();
  /** @type {{req: string, tr: RTCRtpTransceiver}[]} */
  grants = [];
  /** @type {Set<Function>} */
  stableWaiters = new Set();
  closed = false;
}

/**
 * A direct link to one neighbor (plan section 5). The object lives as long as the neighbor is in
 * the group; RTCPeerConnection generations come and go under it.
 *
 * Events:
 * - `state` (state, reason): `connecting` | `connected` | `slow` | `recovering` | `unreachable` | `closed`
 * - `ctl` (msg): control message from the neighbor, after transport messages were handled
 * - `envelope` (bytes, key): binary envelope from a transport channel
 * - `open`: `ctl` opened in a new generation
 * - `rebuilt`: a new generation replaced the old one; slots and transceivers are gone
 * - `negotiated`: a negotiation round completed
 * - `metrics` (metrics): periodic link metrics
 * - `drain` (key): a transport channel can take more data
 * - `remotetrack` (transceiver): the browser fired `track`
 */
export class DirectLink extends Emitter {
  /** @type {Conn} */
  #conn = null;
  #queue;
  #localRetired = new Set();
  #remoteRetired = new Set();
  #state = "connecting";
  #reason = "";
  #monitor;
  #heartbeat;
  #watchdog;
  #recovery;
  #checkTimer = null;
  #statsTimer = null;
  #polling = false;
  #lastRestartAt = -Infinity;
  #remoteVerdict = "ok";
  #turnAdded = false;
  #closed = false;
  #lastDump = null;
  #lastMediaBytes = new Map();

  /** Latest link metrics (plan section 7.1). */
  metrics = { state: "down", rtt: undefined, bitrate: undefined, loss: undefined, candidateType: undefined, remoteCandidateType: undefined };
  /** Last error text and hint. */
  lastError = null;
  hint = null;

  /**
   * @param {object} ctx group context
   * @param {string} ctx.selfId
   * @param {Readonly<typeof import("../config.js").DEFAULTS>} ctx.config
   * @param {import("../util/clock.js").Clock} ctx.clock
   * @param {import("../diag/log.js").Log} ctx.log
   * @param {(to: string, msg: object, link: DirectLink) => void} ctx.sendSignal
   * @param {(link: DirectLink, withTurn: boolean) => RTCConfiguration} ctx.rtcConfig
   * @param {typeof RTCPeerConnection} ctx.RTCPeerConnection
   * @param {(link: DirectLink) => boolean} [ctx.canAddTurn]
   * @param {string} remoteId
   */
  constructor(ctx, remoteId) {
    super();
    this.ctx = ctx;
    this.remoteId = remoteId;
    this.impolite = isImpolite(ctx.selfId, remoteId);
    this.config = ctx.config;
    this.clock = ctx.clock;
    this.l = ctx.log.scope("link", { peer: remoteId });
    this.#queue = new SerialQueue((error) => this.#noteError("signaling", error));
    const c = this.config;
    this.#monitor = new LivenessMonitor({
      now: () => this.clock.now(),
      slowMs: c.SLOW_CONNECTION_MS,
      staleMs: c.STALE_CONNECTION_MS,
      backgroundSlowMs: c.BACKGROUND_SLOW_MS,
      backgroundStaleMs: c.BACKGROUND_STALE_MS,
      onchange: (state, silence) => this.#onLiveness(state, silence),
    });
    this.#heartbeat = new Heartbeat(this.clock, c.HEARTBEAT_IDLE_MS, () => this.#conn?.hop.sendBeat());
    this.#watchdog = new Watchdog(this.clock, c.CHANNEL_OPEN_TIMEOUT_MS, () => this.#onWatchdog());
    this.#recovery = new RecoverySchedule({
      clock: this.clock,
      backoffMs: c.iceRestartBackoffMs,
      rebuildAttempts: c.rebuildAttempts,
      stepTimeoutMs: c.recoveryStepTimeoutMs,
      reprobeMs: c.reprobeIntervalsMs,
      healthy: () => this.healthy,
      act: (step) => this.#recoveryStep(step),
      canAddTurn: () => !this.#turnAdded && (ctx.canAddTurn?.(this) ?? false),
      onreprobe: () => this.l.info("background re-probe"),
    });
  }

  /** Link state. */
  get state() {
    return this.#state;
  }

  /** Reason of the last state change. */
  get reason() {
    return this.#reason;
  }

  /** Liveness verdict: `ok`, `slow` or `stale`. */
  get liveness() {
    return this.#monitor.state;
  }

  /** True when `ctl` is open and data arrives in time. */
  get healthy() {
    return !!this.#conn?.ctlOpen && this.#monitor.state === "ok" && this.#remoteVerdict !== "stale";
  }

  /** True when the link can carry traffic now (healthy or slow). */
  get usable() {
    return !!this.#conn?.ctlOpen && this.#monitor.state !== "stale" && this.#remoteVerdict !== "stale";
  }

  /** The current connection session id. */
  get session() {
    return this.#conn?.session;
  }

  /** The current RTCPeerConnection, for advanced use. */
  get pc() {
    return this.#conn?.pc ?? null;
  }

  /** SCTP maximum message size of the current generation. */
  get maxMessageSize() {
    return this.#conn?.hop.maxMessageSize ?? 65536;
  }

  /** The last candidate pair dump. */
  get lastDump() {
    return this.#lastDump;
  }

  /** True while the remote side announced background mode. */
  get remoteBackground() {
    return this.#monitor.background;
  }

  /** Starts the first generation. */
  start() {
    if (this.#conn) return;
    this.#newConn("start");
    this.#checkTimer = this.clock.setInterval(() => this.#check(), this.config.LIVENESS_CHECK_INTERVAL_MS);
    this.#statsTimer = this.clock.setInterval(() => this.#collectStats(), this.config.statsIntervalMs);
    this.#heartbeat.start();
  }

  #newConn(reason) {
    const old = this.#conn;
    if (old) this.#retire(old);
    const conn = new Conn();
    this.#conn = conn;
    const pc = new this.ctx.RTCPeerConnection(this.ctx.rtcConfig(this, this.#turnAdded));
    conn.pc = pc;
    this.l.info("new connection", { session: conn.session, reason, impolite: this.impolite });
    conn.hop = new HopChannels(pc, {
      impolite: this.impolite,
      highWater: this.config.hopHighWaterBytes,
      lowWater: this.config.hopLowWaterBytes,
      flowLimit: this.config.relayQueueBytes,
      log: (msg, data) => this.l.debug(msg, data),
    });
    conn.hop.on("open", (key) => key === CTL && this.#onCtlOpen(conn));
    conn.hop.on("transportclose", (key) => this.#onTransportClose(conn, key));
    conn.hop.on("beat", () => this.#monitor.noteData());
    conn.hop.on("ctl", (msg) => this.#onCtl(conn, msg));
    conn.hop.on("envelope", (bytes, key) => {
      this.#monitor.noteData();
      this.emit("envelope", bytes, key);
    });
    conn.hop.on("sent", () => this.#heartbeat.noteSent());
    conn.hop.on("drain", (key) => this.emit("drain", key));
    conn.batcher = new CandidateBatcher(this.clock, this.config.candidateBatchMs, (c) => this.#signal(conn, { t: "cand", c }));
    conn.neg = new Negotiator(pc, {
      impolite: this.impolite,
      signal: (msg) => this.#signal(conn, msg),
      beforeAnswer: (msg) => this.#applyGrants(conn, msg),
      offerExtras: () => this.#offerExtras(conn),
      onstable: () => this.#onStable(conn),
      log: (msg, data) => this.l.debug(msg, data),
    });
    pc.onicecandidate = (e) => {
      if (conn.closed) return;
      if (e.candidate && e.candidate.candidate) conn.batcher.add(e.candidate.toJSON());
      else conn.batcher.drain();
    };
    pc.onnegotiationneeded = () => {
      if (conn.closed || !this.impolite) return;
      this.#queue.push(() => conn.neg.negotiate("negotiationneeded"));
    };
    pc.oniceconnectionstatechange = () => this.#onIceState(conn);
    pc.onconnectionstatechange = () => this.#onConnState(conn);
    pc.ontrack = (e) => !conn.closed && this.emit("remotetrack", e.transceiver, e);
    this.#monitor.reset();
    this.#remoteVerdict = "ok";
    conn.connectTimer = this.clock.setTimeout(() => {
      conn.connectTimer = null;
      if (!conn.closed && !conn.ctlOpen && !this.#recovery.running) this.#startRecovery("connect timeout");
    }, this.config.connectTimeoutMs);
    if (old) this.emit("rebuilt");
    if (this.impolite) this.#queue.push(() => conn.neg.negotiate("initial"));
  }

  #retire(conn) {
    conn.closed = true;
    if (conn.connectTimer !== null) this.clock.clearTimeout(conn.connectTimer);
    this.#localRetired.add(conn.session);
    if (conn.remoteSession) this.#remoteRetired.add(conn.remoteSession);
    conn.batcher.close();
    for (const r of conn.slotRequests.values()) r.reject(new Error("link rebuilt"));
    for (const w of conn.stableWaiters) w(false);
    conn.hop.close();
    try {
      conn.pc.close();
    } catch {
      // already closed
    }
    this.#watchdog.clear();
  }

  #signal(conn, msg) {
    if (conn.closed) return;
    this.ctx.sendSignal(this.remoteId, { ...msg, s: conn.session, rs: conn.remoteSession ?? undefined }, this);
  }

  /**
   * Handles a signaling message from the neighbor (from the server or the mesh).
   * @param {object} msg
   */
  handleSignal(msg) {
    if (this.#closed) return;
    this.#queue.push(() => this.#handleSignal(msg));
  }

  async #handleSignal(msg) {
    if (this.#closed) return;
    if (msg.rs && this.#localRetired.has(msg.rs)) {
      this.l.debug("dropped signal for retired session", { t: msg.t, rs: msg.rs });
      return;
    }
    if (msg.s && this.#remoteRetired.has(msg.s)) {
      this.l.debug("dropped signal from retired session", { t: msg.t, s: msg.s });
      return;
    }
    if (!this.#conn) this.start();
    let conn = this.#conn;
    if (msg.s && msg.s !== conn.remoteSession) {
      if (conn.remoteSession === null || !conn.pc.remoteDescription) {
        if (conn.remoteSession) this.#remoteRetired.add(conn.remoteSession);
        conn.remoteSession = msg.s;
      } else {
        this.l.warn("remote session changed, rebuilding", { old: conn.remoteSession, new: msg.s });
        this.#newConn("remote session changed");
        conn = this.#conn;
        conn.remoteSession = msg.s;
      }
    }
    switch (msg.t) {
      case "offer":
        await conn.neg.handleOffer(msg);
        break;
      case "answer":
        await conn.neg.handleAnswer(msg);
        break;
      case "cand":
        await conn.neg.handleCandidates(msg);
        break;
      case "renegotiate":
        await this.#onRenegotiate(conn, msg);
        break;
      default:
        this.l.debug("unknown signal", { t: msg.t });
    }
  }

  async #onRenegotiate(conn, msg) {
    if (!this.impolite) return;
    if (msg.rebuild && conn.pc.remoteDescription) {
      this.#newConn("rebuild requested");
      return;
    }
    if (msg.iceRestart) {
      if (this.clock.now() - this.#lastRestartAt < RESTART_REQUEST_GAP_MS) return;
      this.#iceRestartNow(conn, msg.reason ?? "requested");
      return;
    }
    await conn.neg.negotiate(msg.reason ?? "requested");
  }

  #onStable(conn) {
    if (conn.closed) return;
    for (const w of conn.stableWaiters) w(true);
    conn.stableWaiters.clear();
    this.emit("negotiated");
  }

  #onIceState(conn) {
    if (conn.closed) return;
    const s = conn.pc.iceConnectionState;
    this.l.debug("ice state", { state: s });
    if ((s === "connected" || s === "completed") && !conn.ctlOpen) this.#watchdog.arm();
  }

  #onConnState(conn) {
    if (conn.closed) return;
    const s = conn.pc.connectionState;
    this.l.debug("connection state", { state: s });
    if (s === "connected" && !conn.everConnected) {
      conn.everConnected = true;
      this.#dump(conn, false, "connected");
    }
    if (s === "failed") this.#startRecovery("ice failed");
  }

  #onCtlOpen(conn) {
    if (conn.closed) return;
    conn.ctlOpen = true;
    this.#watchdog.clear();
    this.#monitor.reset();
    this.#heartbeat.now();
    this.l.info("control channel open", { session: conn.session });
    this.emit("open");
    this.#evaluate("open");
  }

  #onTransportClose(conn, key) {
    if (conn.closed || this.#closed) return;
    this.l.warn("transport channel closed by remote", { key });
    if (key === CTL) {
      conn.ctlOpen = false;
      this.#startRecovery("control channel closed");
    }
  }

  #onWatchdog() {
    const conn = this.#conn;
    if (!conn || conn.ctlOpen || this.#closed) return;
    this.l.warn("control channel did not open in time", { timeoutMs: this.config.CHANNEL_OPEN_TIMEOUT_MS });
    this.lastError = "data channel open timeout";
    this.#rebuild("watchdog");
  }

  #onCtl(conn, msg) {
    if (conn.closed) return;
    this.#monitor.noteData();
    if (conn.hop.handleCtl(msg)) return;
    switch (msg.t) {
      case "bg":
        this.l.info("remote entered background mode");
        this.#monitor.setBackground(true);
        return;
      case "fg":
        this.l.info("remote left background mode");
        this.#monitor.setBackground(false);
        return;
      case "liveness":
        this.#onRemoteVerdict(msg.state);
        return;
      case "slot-request":
        this.#onSlotRequest(conn, msg);
        return;
      default:
        this.emit("ctl", msg);
    }
  }

  #onRemoteVerdict(state) {
    if (state === this.#remoteVerdict) return;
    this.#remoteVerdict = state;
    this.l.info("remote liveness verdict", { state });
    if (state === "stale") this.#startRecovery("remote side reports silence");
    else this.#evaluate("remote verdict");
  }

  #onLiveness(state, silence) {
    this.l.info(`liveness ${state}`, { silenceMs: Math.round(silence), background: this.#monitor.background });
    this.#conn?.hop.sendCtl({ t: "liveness", state });
    if (state === "stale") this.#startRecovery("stale: no data for " + Math.round(silence) + " ms");
    else this.#evaluate("liveness " + state);
  }

  #check() {
    if (this.#closed || !this.#conn?.ctlOpen) return;
    this.#monitor.check();
    if (this.#monitor.dataSilence >= this.config.LIVENESS_CHECK_INTERVAL_MS && !this.#polling) this.#pollLiveness();
  }

  async #pollLiveness() {
    const conn = this.#conn;
    this.#polling = true;
    try {
      const stats = await readStats(conn.pc);
      if (conn.closed) return;
      const now = this.clock.now();
      for (const s of stats.values()) {
        if (s.type !== "inbound-rtp") continue;
        if (typeof s.lastPacketReceivedTimestamp === "number" && typeof s.timestamp === "number") {
          this.#monitor.noteMedia(now - Math.max(0, s.timestamp - s.lastPacketReceivedTimestamp));
        } else if (typeof s.bytesReceived === "number") {
          const prev = this.#lastMediaBytes.get(s.id);
          this.#lastMediaBytes.set(s.id, s.bytesReceived);
          if (prev !== undefined && s.bytesReceived > prev) this.#monitor.noteMedia(now - this.config.LIVENESS_CHECK_INTERVAL_MS);
        }
      }
      if (this.#monitor.background) {
        const pair = selectedPair(stats);
        if (pair) {
          if (typeof pair.lastPacketReceivedTimestamp === "number" && typeof pair.timestamp === "number") {
            this.#monitor.noteConsent(now - Math.max(0, pair.timestamp - pair.lastPacketReceivedTimestamp));
          } else if (typeof pair.responsesReceived === "number") {
            const prev = this.#lastMediaBytes.get("consent");
            this.#lastMediaBytes.set("consent", pair.responsesReceived);
            if (prev !== undefined && pair.responsesReceived > prev) this.#monitor.noteConsent(now);
          }
        }
      }
      this.#monitor.check();
    } catch {
      // the connection closed while reading stats
    } finally {
      this.#polling = false;
    }
  }

  async #collectStats() {
    const conn = this.#conn;
    if (!conn || !conn.ctlOpen || conn.closed) {
      this.metrics = { ...this.metrics, state: this.#metricState() };
      return;
    }
    try {
      const stats = await readStats(conn.pc);
      if (conn.closed) return;
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
      this.metrics = {
        state: this.#metricState(),
        rtt: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : this.metrics.rtt,
        bitrate: pair?.availableOutgoingBitrate ?? undefined,
        loss: lossN ? lossSum / lossN : 0,
        candidateType: local?.candidateType,
        remoteCandidateType: remote?.candidateType,
        cpuLimited: cpu,
        maxMessageSize: conn.hop.maxMessageSize,
      };
      this.emit("metrics", this.metrics, stats);
    } catch {
      // the connection closed while reading stats
    }
  }

  #metricState() {
    if (!this.#conn?.ctlOpen) return "down";
    if (this.#remoteVerdict === "stale") return "stale";
    const m = this.#monitor.state;
    return m === "ok" && this.#remoteVerdict === "slow" ? "slow" : m;
  }

  /** True when the selected pair runs over TURN on either side. */
  get viaTurn() {
    return this.metrics.candidateType === "relay" || this.metrics.remoteCandidateType === "relay";
  }

  #evaluate(reason) {
    if (this.#closed) return;
    if (this.healthy) {
      if (this.#recovery.running || this.#state === "unreachable" || this.#state === "recovering") {
        this.#recovery.noteHealthy();
        this.#recovery.resetReprobe();
      }
      this.#setState("connected", reason);
    } else if (this.usable) {
      if (this.#state !== "recovering" && this.#state !== "unreachable") this.#setState("slow", reason);
    }
  }

  #setState(state, reason) {
    if (state === this.#state) return;
    const prev = this.#state;
    this.#state = state;
    this.#reason = reason;
    if (state === "connected") {
      this.lastError = null;
      this.hint = null;
    }
    this.metrics = { ...this.metrics, state: this.#metricState() };
    const level = state === "unreachable" ? "error" : state === "recovering" ? "warn" : "info";
    this.l[level](`state ${prev} -> ${state}`, { reason, hint: this.hint ?? undefined });
    this.emit("state", state, reason);
  }

  #startRecovery(reason) {
    if (this.#closed) return;
    this.lastError = reason;
    if (this.#state !== "unreachable") this.#setState("recovering", reason);
    const conn = this.#conn;
    if (conn) this.#dump(conn, true, reason);
    if (this.#recovery.running) return;
    this.#recovery.run().then((result) => {
      if (result === "unreachable" && !this.#closed) this.#setState("unreachable", this.lastError ?? reason);
    });
  }

  #recoveryStep(step) {
    if (this.#closed) return;
    this.l.info(`recovery step ${step.kind}`, { attempt: step.attempt });
    const conn = this.#conn;
    if (step.kind === "restart") {
      if (this.impolite) {
        if (this.clock.now() - this.#lastRestartAt >= RESTART_REQUEST_GAP_MS) this.#iceRestartNow(conn, "recovery");
      }
      else this.#signal(conn, { t: "renegotiate", iceRestart: true, reason: "recovery" });
    } else if (step.kind === "rebuild") {
      this.#rebuild("recovery");
    } else if (step.kind === "turn") {
      this.#turnAdded = true;
      this.l.info("adding TURN servers");
      try {
        conn.pc.setConfiguration(this.ctx.rtcConfig(this, true));
      } catch (error) {
        this.l.warn("setConfiguration failed", { error: error.message });
      }
      if (this.impolite) this.#iceRestartNow(conn, "turn fallback");
      else this.#signal(conn, { t: "renegotiate", iceRestart: true, reason: "turn fallback" });
    }
  }

  #iceRestartNow(conn, reason) {
    if (conn.closed) return;
    this.#lastRestartAt = this.clock.now();
    this.l.info("ICE restart", { reason });
    if (!conn.pc.remoteDescription) {
      this.#rebuild("restart before first answer");
      return;
    }
    conn.pc.restartIce();
  }

  #rebuild(reason) {
    if (this.#closed) return;
    if (this.impolite) this.#newConn(reason);
    else {
      this.l.info("asking for rebuild", { reason });
      this.#signal(this.#conn, { t: "renegotiate", rebuild: true, reason });
    }
  }

  /**
   * ICE restart on a working link, e.g. after a network change (decision D15). The impolite
   * side restarts, the polite side asks for it.
   * @param {string} reason
   */
  iceRestart(reason) {
    const conn = this.#conn;
    if (!conn || this.#closed) return;
    if (this.impolite) this.#queue.push(() => this.#iceRestartNow(conn, reason));
    else this.#signal(conn, { t: "renegotiate", iceRestart: true, reason });
  }

  /** Rebuilds the connection now (also used by test hooks to rebuild silently). */
  rebuild(reason = "requested") {
    if (this.#closed) return;
    this.#newConn(reason);
    if (!this.impolite) this.#signal(this.#conn, { t: "renegotiate", rebuild: true, reason });
  }

  /** Test hook: closes all transport channels of the current generation, like an SCTP abort. */
  abortTransport() {
    this.#conn?.hop.close();
  }

  async #dump(conn, all, reason) {
    try {
      const stats = await readStats(conn.pc);
      const dump = pairDump(stats, all);
      this.#lastDump = { time: this.clock.wallNow(), reason, ...dump };
      if (all) {
        const hint = failureHint(dump);
        if (hint) this.hint = hint;
        this.l.warn("candidate pairs on failure", { reason, hint, ...summarizeDump(dump) });
      } else {
        this.l.info("selected candidate pair", summarizeDump(dump));
      }
    } catch {
      // connection gone
    }
  }

  /** Re-checks liveness now and restarts ICE when the link is slow or stale. */
  checkNow(reason) {
    if (!this.#conn?.ctlOpen) return;
    this.#heartbeat.now();
    this.#monitor.check();
    if (this.#monitor.state !== "ok" || this.#remoteVerdict !== "ok") this.iceRestart(reason);
  }

  /** Sends `bg` or `fg` (plan section 6.1). */
  setBackground(on) {
    this.sendCtl({ t: on ? "bg" : "fg" });
    if (!on) this.#heartbeat.now();
  }

  /**
   * Sends a control message on `ctl`.
   * @param {object} msg
   */
  sendCtl(msg) {
    return this.#conn?.hop.sendCtl(msg) ?? false;
  }

  /** True when `ctl` is open in the current generation. */
  get ctlOpen() {
    return !!this.#conn?.ctlOpen;
  }

  /**
   * Queues an envelope on a transport channel.
   * @param {string} key
   * @param {string} flow
   * @param {Uint8Array} bytes
   */
  sendEnvelope(key, flow, bytes) {
    return this.#conn?.hop.sendEnvelope(key, flow, bytes) ?? false;
  }

  /** Bytes queued for a flow on a transport channel. */
  queuedBytes(key, flow) {
    return this.#conn?.hop.queuedBytes(key, flow) ?? 0;
  }

  /** Total bufferedAmount over the transport channels. */
  get bufferedAmount() {
    return this.#conn?.hop.bufferedAmount ?? 0;
  }

  // Media slots. The impolite side creates all transceivers; the polite side asks with
  // `slot-request` and gets the mid in the offer (`grants`).

  /**
   * Returns an idle or new send slot of `kind` and marks it used by `key`.
   * @param {"audio"|"video"} kind
   * @param {string} key
   * @returns {Promise<{tr: RTCRtpTransceiver, kind: string, key: string|null}>}
   */
  async acquireSendSlot(kind, key) {
    const conn = this.#conn;
    if (!conn) throw new Error("link not started");
    const idle = conn.slots.find((s) => s.kind === kind && s.key === null && s.tr.mid != null);
    if (idle) {
      idle.key = key;
      return idle;
    }
    if (this.impolite) {
      const tr = conn.pc.addTransceiver(kind, { direction: "sendonly" });
      const slot = { tr, kind, key };
      conn.slots.push(slot);
      await this.#waitStable(conn, () => tr.mid != null && tr.currentDirection != null);
      return slot;
    }
    const req = randomId(8);
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        conn.slotRequests.delete(req);
        reject(new Error("slot request timed out"));
      }, SLOT_TIMEOUT_MS);
      conn.slotRequests.set(req, {
        kind,
        resolve: (slot) => {
          this.clock.clearTimeout(timer);
          slot.key = key;
          resolve(slot);
        },
        reject: (e) => {
          this.clock.clearTimeout(timer);
          reject(e);
        },
      });
      conn.hop.sendCtl({ t: "slot-request", req, kind });
    });
  }

  /**
   * Marks a slot idle and stops sending on it. No renegotiation.
   * @param {{tr: RTCRtpTransceiver, key: string|null}} slot
   */
  releaseSendSlot(slot) {
    slot.key = null;
    slot.tr.sender.replaceTrack(null).catch(() => {});
  }

  /** True when the slot belongs to the current generation. */
  ownsSlot(slot) {
    return !!this.#conn?.slots.includes(slot);
  }

  #waitStable(conn, cond) {
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        conn.stableWaiters.delete(check);
        reject(new Error("negotiation timed out"));
      }, SLOT_TIMEOUT_MS);
      const check = (ok) => {
        if (ok === false) {
          this.clock.clearTimeout(timer);
          conn.stableWaiters.delete(check);
          reject(new Error("link rebuilt"));
          return;
        }
        if (cond()) {
          this.clock.clearTimeout(timer);
          conn.stableWaiters.delete(check);
          resolve();
        }
      };
      conn.stableWaiters.add(check);
      if (conn.pc.signalingState === "stable" && cond()) check(true);
    });
  }

  #onSlotRequest(conn, msg) {
    if (!this.impolite) return;
    const tr = conn.pc.addTransceiver(msg.kind, { direction: "recvonly" });
    conn.grants.push({ req: msg.req, tr });
  }

  #offerExtras(conn) {
    if (!conn.grants.length) return {};
    const grants = [];
    conn.grants = conn.grants.filter((g) => {
      if (g.tr.mid == null) return true;
      grants.push({ req: g.req, mid: g.tr.mid });
      return false;
    });
    return grants.length ? { grants } : {};
  }

  #applyGrants(conn, msg) {
    for (const g of msg.grants ?? []) {
      const tr = conn.pc.getTransceivers().find((t) => t.mid === g.mid);
      const request = conn.slotRequests.get(g.req);
      if (!tr || !request) continue;
      conn.slotRequests.delete(g.req);
      tr.direction = "sendonly";
      const slot = { tr, kind: request.kind, key: null };
      conn.slots.push(slot);
      queueMicrotask(() => request.resolve(slot));
    }
  }

  /**
   * The receiving transceiver with `mid` in the current generation.
   * @param {string} mid
   */
  transceiver(mid) {
    return this.#conn?.pc.getTransceivers().find((t) => t.mid === mid) ?? null;
  }

  /** Asks for a renegotiation (impolite: offer; polite: `renegotiate`). */
  renegotiate(reason) {
    const conn = this.#conn;
    if (conn) this.#queue.push(() => conn.neg.negotiate(reason));
  }

  #noteError(area, error) {
    this.lastError = error?.message ?? String(error);
    this.l.error(`${area} error`, { error: this.lastError, stack: error?.stack?.split("\n").slice(0, 4).join(" | ") });
  }

  /** Closes the link for good. */
  close(reason = "closed") {
    if (this.#closed) return;
    this.#setState("closed", reason);
    this.#closed = true;
    this.#recovery.cancel();
    this.#heartbeat.stop();
    this.#watchdog.clear();
    if (this.#checkTimer !== null) this.clock.clearInterval(this.#checkTimer);
    if (this.#statsTimer !== null) this.clock.clearInterval(this.#statsTimer);
    if (this.#conn) this.#retire(this.#conn);
    this.metrics = { ...this.metrics, state: "down" };
    this.removeAllListeners();
  }
}
