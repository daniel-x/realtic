import { Emitter } from "./util/emitter.js";
import { isImpolite, randomId } from "./util/ids.js";
import { Session } from "./channel/session.js";
import { encode, split, aad, FLAG, TYPE, Reassembler, headerLength } from "./transport/framing.js";
import { encrypt, decrypt, OVERHEAD } from "./crypto/e2e.js";
import { LivenessMonitor } from "./liveness/monitor.js";
import { SerialQueue } from "./signaling/queue.js";
import { RecoverySchedule } from "./link/ice-restart.js";
import { directPeerConnectionClass } from "./link/direct-peer-connection.js";
import { readStats, pairDump, summarizeDump } from "./diag/pair-dump.js";
import { failureHint } from "./diag/hints.js";

const LOG_PART_BYTES = 16384;
const RESTART_REQUEST_GAP_MS = 2000;

/**
 * The connection to one other peer of the group, kept up as long as the peer is known (plan
 * section 3). It is direct, wrapping the RTCPeerConnection of its direct link, or routed through a
 * relay, using the relay's direct link. Finding routes, keeping standby routes warm and switching
 * routes happen inside; the object survives link rebuilds, ICE restarts and route switches, so app
 * state bound to it never has to be rebuilt (doc §3.8).
 *
 * Events: `statechange` (state, reason), `routechange` (route), `channel` (RalChannel),
 * `track` ({track, stream, tag, origin, kind}), `trackreplaced` ({track, oldTrack, stream, tag}),
 * `trackended` ({track, stream, tag}).
 */
export class RalPeerConnection extends Emitter {
  #state = "connecting";
  #reason = "";
  #group;
  #route = null;
  #everConnected = false;
  #reassembler;
  #encChain = Promise.resolve();
  #decChain = Promise.resolve();
  #e2eMonitor;
  #logRequests = new Map();
  #logParts = new Map();
  #beatTimer = null;
  #ll;
  /** @type {any} */
  #directConn = null;
  #directHooks = null;
  #directState = "connecting";
  #directReason = "";
  #directClosed = false;
  #queue = null;
  #recovery = null;
  #localRetired = new Set();
  #remoteRetired = new Set();
  #lastRestartAt = -Infinity;
  #lastRebuildAt = -Infinity;
  #turnAdded = false;
  #lastDump = null;

  /** Last error text and hint of the direct connection. */
  directError = null;
  directHint = null;
  /** Remote hello (protocol, keys, capabilities), once received. */
  remote = null;
  /** End to end AES-GCM key for relayed data. */
  pairKey = null;
  /** Last error text and hint. */
  lastError = null;
  hint = null;

  /**
   * @param {object} group internal group interface
   * @param {string} id
   */
  constructor(group, id) {
    super();
    this.#group = group;
    this.id = id;
    this.impolite = isImpolite(group.selfId, id);
    this.l = group.log.scope("routing", { peer: id });
    this.#ll = group.log.scope("link", { peer: id });
    this.#reassembler = new Reassembler(group.clock);
    this.session = new Session({
      impolite: this.impolite,
      config: group.config,
      clock: group.clock,
      log: group.log.scope("channel", { peer: id }),
      transmit: (e, key) => this.#transmit(e, key),
    });
    this.session.on("channel", (ch) => this.emit("channel", ch));
    this.session.on("control", (msg) => this.#onControl(msg));
    this.#e2eMonitor = LivenessMonitor.fromConfig(group.config, () => group.clock.now(), (state, silence) => group.routing.onE2ELiveness(this, state, silence));
  }

  /** `connecting` | `connected` | `slow` | `reconnecting` | `unreachable` | `closing` | `closed` */
  get state() {
    return this.#state;
  }

  /** Reason of the last state change. */
  get reason() {
    return this.#reason;
  }

  /** `{ kind: "direct" | "relay", via, candidateType }` or null without a route. */
  get route() {
    const r = this.#route;
    if (!r) return null;
    if (r.kind === "direct") {
      const d = this.#directConn;
      return { kind: "direct", via: null, candidateType: d?.ralViaTurn ? "relay" : d?.ralMetrics.candidateType ?? "host" };
    }
    return { kind: "relay", via: r.via, candidateType: this.#group.directConns.get(r.via)?.ralMetrics.candidateType ?? "host" };
  }

  /** Internal route descriptor. */
  get routeInfo() {
    return this.#route;
  }

  /**
   * The current RalDirectPeerConnection to this peer (an RTCPeerConnection), or null without one.
   * A rebuild replaces it.
   */
  get directConn() {
    return this.#directConn;
  }

  /** End to end liveness monitor of relayed routes. */
  get e2e() {
    return this.#e2eMonitor;
  }

  /**
   * Creates an end to end data channel (plan section 9.2).
   * @param {string} label
   * @param {{ordered?: boolean, maxRetransmits?: number, maxPacketLifeTime?: number, protocol?: string}} [init]
   */
  createChannel(label, init) {
    if (this.#state === "closing" || this.#state === "closed") throw new DOMException("connection is closed", "InvalidStateError");
    return this.session.createChannel(label, init);
  }

  /**
   * Fetches the remote side's diagnostic report. Rejects when the remote app did not enable
   * `shareLogWithPeers`.
   * @param {number} [timeoutMs]
   */
  requestLog(timeoutMs = 15000) {
    const id = randomId(8);
    return new Promise((resolve, reject) => {
      const timer = this.#group.clock.setTimeout(() => {
        this.#logRequests.delete(id);
        reject(new Error("log request timed out"));
      }, timeoutMs);
      this.#logRequests.set(id, { resolve, reject, timer });
      this.session.sendControl({ t: "log-request", id });
    });
  }

  async #onControl(msg) {
    switch (msg.t) {
      case "log-request": {
        if (!this.#group.config.shareLogWithPeers) {
          this.session.sendControl({ t: "log-response", id: msg.id, refused: true });
          return;
        }
        const text = JSON.stringify(await this.#group.diagnosticReport());
        const parts = Math.max(1, Math.ceil(text.length / LOG_PART_BYTES));
        for (let i = 0; i < parts; i++) {
          this.session.sendControl({ t: "log-response", id: msg.id, part: i, parts, data: text.slice(i * LOG_PART_BYTES, (i + 1) * LOG_PART_BYTES) });
        }
        return;
      }
      case "log-response": {
        const req = this.#logRequests.get(msg.id);
        if (!req) return;
        if (msg.refused) {
          this.#finishLog(msg.id, null, new Error("remote peer does not share its log"));
          return;
        }
        let parts = this.#logParts.get(msg.id);
        if (!parts) this.#logParts.set(msg.id, (parts = []));
        parts[msg.part] = msg.data;
        if (parts.filter((p) => p !== undefined).length === msg.parts) {
          try {
            this.#finishLog(msg.id, JSON.parse(parts.join("")));
          } catch (error) {
            this.#finishLog(msg.id, null, error);
          }
        }
        return;
      }
      case "bg":
        this.#e2eMonitor.setBackground(true);
        this.l.info("remote entered background mode (end to end)");
        return;
      case "fg":
        this.#e2eMonitor.setBackground(false);
        this.l.info("remote left background mode (end to end)");
        return;
      default:
        this.#group.routing.onPeerControl(this, msg);
    }
  }

  #finishLog(id, report, error) {
    const req = this.#logRequests.get(id);
    this.#logRequests.delete(id);
    this.#logParts.delete(id);
    if (!req) return;
    this.#group.clock.clearTimeout(req.timer);
    if (error) req.reject(error);
    else req.resolve(report);
  }

  // Routing ------------------------------------------------------------------------------------

  /**
   * Switches the sending route. Unacknowledged reliable data is resent on the new route.
   * @param {{kind: "direct"} | {kind: "relay", via: string, flow: string} | null} route
   * @param {string} reason
   */
  setRoute(route, reason) {
    const prev = this.#route;
    const same = prev && route && prev.kind === route.kind && prev.via === route.via && prev.flow === route.flow;
    if (same || (!prev && !route)) return;
    this.#route = route;
    this.l.info("route change", { from: describe(prev), to: describe(route), reason });
    if (route?.kind === "relay") {
      this.#e2eMonitor.reset();
      this.#startBeats();
    } else {
      this.#stopBeats();
    }
    if (route) {
      this.session.routeChanged();
      this.session.pump();
    }
    this.emit("routechange", this.route);
  }

  #startBeats() {
    if (this.#beatTimer !== null) return;
    const c = this.#group.config;
    let last = 0;
    this.#beatTimer = this.#group.clock.setInterval(() => {
      this.#e2eMonitor.check();
      const now = this.#group.clock.now();
      if (now - last >= c.HEARTBEAT_IDLE_MS) {
        last = now;
        this.session.sendBeat();
      }
    }, c.LIVENESS_CHECK_INTERVAL_MS);
  }

  #stopBeats() {
    if (this.#beatTimer === null) return;
    this.#group.clock.clearInterval(this.#beatTimer);
    this.#beatTimer = null;
  }

  /**
   * Sends one end to end message on the current route, fragmented to the path's message size and
   * encrypted on relayed routes. Returns false when the route cannot take it now.
   * @param {{type: number, channelId: number, seq: number, payload: Uint8Array, lifetime?: number}} e
   * @param {string} key transport key
   */
  #transmit(e, key) {
    const route = this.#route;
    const reliable = key === "rel";
    if (!route) return !reliable;
    const extra = this.#group.routing.extraRoutes(this);
    const ok = this.#sendOn(route, e, key);
    for (const r of extra) this.#sendOn(r, e, key);
    return ok || !reliable;
  }

  #sendOn(route, e, key) {
    const link = route.kind === "direct" ? this.#directConn : this.#group.directConns.get(route.via);
    if (!link || !link.ralUsable) return false;
    const encrypted = route.kind === "relay";
    if (encrypted && !this.pairKey) return false;
    const flow = `${this.id}:${e.channelId}`;
    const dstIdx = route.kind === "direct" ? 1 : this.#group.localIndex(link, this.id);
    const flags = encrypted ? FLAG.ENCRYPTED : 0;
    const lifetimeFlag = e.lifetime !== undefined ? FLAG.LIFETIME : 0;
    const mtu = Math.min(link.ralMaxMessageSize, this.#group.config.maxFragmentBytes, this.#group.routing.pathMessageSize(route));
    const room = mtu - headerLength(FLAG.FRAGMENTED | lifetimeFlag) - (encrypted ? OVERHEAD : 0);
    const parts = split(e.payload, Math.max(256, room));
    const total = e.payload.length + parts.length * 64;
    if (link.ralQueuedBytes(key, flow) + total > this.#group.config.relayQueueBytes) return false;
    const base = { version: this.#group.protocol.major, type: e.type, flags, srcIdx: 0, dstIdx, channelId: e.channelId, seq: e.seq, lifetime: e.lifetime };
    const fragmented = parts.length > 1;
    const envelopes = parts.map((payload, i) => (fragmented ? { ...base, fragIndex: i, fragCount: parts.length, payload } : { ...base, payload }));
    if (!encrypted) {
      for (const env of envelopes) link.ralSendEnvelope(key, flow, encode(env));
      return true;
    }
    const keyRef = this.pairKey;
    this.#encChain = this.#encChain.then(async () => {
      for (const env of envelopes) {
        const ct = await encrypt(keyRef, aad(env), env.payload);
        link.ralSendEnvelope(key, flow, encode({ ...env, payload: ct }));
      }
    }).catch((error) => this.l.warn("encryption failed", { error: error.message }));
    return true;
  }

  /**
   * Sends an end to end beat on a specific route (standby relays, plan section 7.2a).
   * @param {{kind: "relay", via: string, flow: string}} route
   */
  beatOn(route) {
    this.#sendOn(route, { type: TYPE.BEAT, channelId: 0, seq: 0, payload: new Uint8Array(0) }, "unrel");
  }

  /**
   * Handles an envelope addressed to us from this peer.
   * @param {import("./transport/framing.js").Envelope} e
   * @param {boolean} relayed
   * @param {string} via neighbor the envelope arrived from
   */
  receiveEnvelope(e, relayed, via) {
    const encrypted = (e.flags & FLAG.ENCRYPTED) !== 0;
    if (relayed !== encrypted) {
      this.l.warn("dropped envelope with wrong encryption", { relayed, encrypted });
      return;
    }
    const onActive = relayed && this.#route?.kind === "relay" && this.#route.via === via;
    if (onActive) this.#e2eMonitor.noteData();
    if (!encrypted) return this.#complete(e, e.payload);
    if (!this.pairKey) return;
    const keyRef = this.pairKey;
    const payload = e.payload.slice();
    this.#decChain = this.#decChain
      .then(() => decrypt(keyRef, aad(e), payload))
      .then((plain) => this.#complete(e, plain))
      .catch(() => this.l.warn("dropped envelope that failed authentication", { type: e.type, channelId: e.channelId }));
  }

  #complete(e, payload) {
    if (e.fragCount !== undefined) {
      const full = this.#reassembler.add(`${e.type}:${e.channelId}:${e.seq}`, e.fragIndex, e.fragCount, payload);
      if (!full) return;
      payload = full;
    }
    this.session.receive(e, payload);
  }

  /** Lets end to end senders continue after a transport drained. */
  pump() {
    this.session.pump();
  }

  // Direct connection --------------------------------------------------------------------------
  // The only place where the RTCPeerConnection to this peer is replaced: a rebuild creates a new
  // RalDirectPeerConnection and retires the old one.

  /** True once the direct connection was started (after hello). */
  get directStarted() {
    return this.#directHooks !== null;
  }

  /** `connecting` | `connected` | `slow` | `recovering` | `unreachable` | `closed` */
  get directState() {
    return this.#directState;
  }

  /** Reason of the last direct state change. */
  get directReason() {
    return this.#directReason;
  }

  /** The last candidate pair dump. */
  get lastDump() {
    return this.#lastDump;
  }

  /**
   * Starts the direct connection. `hooks` are the group's handlers; each gets the current
   * RalDirectPeerConnection first.
   * @param {object} hooks
   */
  startDirect(hooks) {
    if (this.#directHooks || this.#directClosed) return;
    this.#directHooks = hooks;
    const g = this.#group;
    const c = g.config;
    this.#queue = new SerialQueue((error) => this.#noteDirectError("signaling", error));
    this.#recovery = new RecoverySchedule({
      clock: g.clock,
      backoffMs: c.iceRestartBackoffMs,
      rebuildAttempts: c.rebuildAttempts,
      stepTimeoutMs: c.recoveryStepTimeoutMs,
      reprobeMs: c.reprobeIntervalsMs,
      healthy: () => !!this.#directConn?.ralHealthy,
      act: (step) => this.#recoveryStep(step),
      canAddTurn: () => !this.#turnAdded && g.routing.canAddTurn(this.id),
      onreprobe: () => this.#ll.info("background re-probe"),
    });
    this.#newDirect("start");
  }

  #newDirect(reason, silent = false) {
    const g = this.#group;
    const old = this.#directConn;
    if (old) {
      this.#retireDirect(old, silent);
      this.#lastRebuildAt = g.clock.now();
    }
    const ref = { d: null };
    try {
      const Direct = directPeerConnectionClass(g.RTC);
      ref.d = new Direct(g.rtcConfig(this.#turnAdded), {
        connection: this,
        remoteId: this.id,
        impolite: this.impolite,
        config: g.config,
        clock: g.clock,
        log: this.#ll,
        hooks: this.#hooksFor(ref),
      });
    } catch (error) {
      this.#noteDirectError("RTCPeerConnection", error);
      this.#directConn = null;
      g.directConns.delete(this.id);
      this.#setDirectState("unreachable", `cannot create RTCPeerConnection: ${error.message}`);
      return;
    }
    const d = ref.d;
    this.#directConn = d;
    g.directConns.set(this.id, d);
    this.#ll.info("new connection", { session: d.ralSession, reason, impolite: this.impolite });
    if (old) this.#directHooks.rebuilt();
    if (this.impolite) this.#queue.push(() => d.ralNegotiate("initial"));
  }

  #hooksFor(ref) {
    const h = this.#directHooks;
    return {
      signal: (msg) => this.#group.router.send(this.id, msg),
      enqueue: (task) => this.#queue.push(task),
      open: () => {
        h.open(ref.d);
        this.#evaluateDirect("open");
      },
      ctlClosed: () => this.#onCtlClosed(),
      ctl: (msg) => h.ctl(ref.d, msg),
      envelope: (bytes, key) => h.envelope(ref.d, bytes, key),
      drain: (key) => h.drain(ref.d, key),
      remotetrack: () => h.remotetrack(ref.d),
      negotiated: () => h.negotiated(ref.d),
      metrics: (m, stats) => h.metrics(ref.d, m, stats),
      liveness: (state, silence) => {
        if (state === "stale") this.#startRecovery("stale: no data for " + Math.round(silence) + " ms");
        else this.#evaluateDirect("liveness " + state);
      },
      remoteVerdict: (state) => {
        if (state === "stale") this.#startRecovery("remote side reports silence");
        else this.#evaluateDirect("remote verdict");
      },
      connected: () => this.#dump(ref.d, false, "connected"),
      failed: () => this.#startRecovery("ice failed"),
      watchdog: () => {
        this.directError = "data channel open timeout";
        this.#rebuild("watchdog");
      },
      connectTimeout: () => {
        if (!this.#recovery.running) this.#startRecovery("connect timeout");
      },
    };
  }

  #retireDirect(d, silent = false) {
    this.#localRetired.add(d.ralSession);
    if (d.ralRemoteSession) this.#remoteRetired.add(d.ralRemoteSession);
    d.ralRetire(silent);
  }

  /**
   * Handles a signaling message of the direct connection (from the server or the mesh).
   * @param {object} msg
   */
  handleDirectSignal(msg) {
    if (this.#directClosed || !this.#queue) return;
    this.#queue.push(() => this.#handleDirectSignal(msg));
  }

  async #handleDirectSignal(msg) {
    if (this.#directClosed) return;
    if (msg.rs && this.#localRetired.has(msg.rs)) {
      this.#ll.debug("dropped signal for retired session", { t: msg.t, rs: msg.rs });
      return;
    }
    if (msg.s && this.#remoteRetired.has(msg.s)) {
      this.#ll.debug("dropped signal from retired session", { t: msg.t, s: msg.s });
      return;
    }
    if (!this.#directConn) this.#newDirect("signal");
    let d = this.#directConn;
    if (!d) return;
    if (msg.s && msg.s !== d.ralRemoteSession) {
      if (d.ralRemoteSession === null || !d.remoteDescription) {
        if (d.ralRemoteSession) this.#remoteRetired.add(d.ralRemoteSession);
        d.ralRemoteSession = msg.s;
      } else {
        this.#ll.warn("remote session changed, rebuilding", { old: d.ralRemoteSession, new: msg.s });
        this.#newDirect("remote session changed");
        d = this.#directConn;
        if (!d) return;
        d.ralRemoteSession = msg.s;
      }
    }
    if (msg.t === "renegotiate") await this.#onRenegotiate(d, msg);
    else if (msg.t === "offer" || msg.t === "answer" || msg.t === "cand") await d.ralHandleSignal(msg);
    else this.#ll.debug("unknown signal", { t: msg.t });
  }

  async #onRenegotiate(d, msg) {
    if (!this.impolite) return;
    const now = this.#group.clock.now();
    if (msg.rebuild) {
      if (d.remoteDescription && now - this.#lastRebuildAt > RESTART_REQUEST_GAP_MS) this.#newDirect("rebuild requested");
      return;
    }
    if (msg.iceRestart) {
      if (now - this.#lastRestartAt < RESTART_REQUEST_GAP_MS) return;
      this.#iceRestartNow(d, msg.reason ?? "requested");
      return;
    }
    await d.ralNegotiate(msg.reason ?? "requested");
  }

  #onCtlClosed() {
    if (this.#directClosed) return;
    this.directError = "control channel closed";
    if (this.#directState !== "unreachable") this.#setDirectState("recovering", "control channel closed");
    this.#rebuild("control channel closed");
    this.#startRecovery("control channel closed");
  }

  #evaluateDirect(reason) {
    if (this.#directClosed) return;
    const d = this.#directConn;
    if (d?.ralHealthy) {
      if (this.#recovery.running || this.#directState === "unreachable" || this.#directState === "recovering") {
        this.#recovery.noteHealthy();
        this.#recovery.resetReprobe();
      }
      this.#setDirectState("connected", reason);
    } else if (d?.ralUsable) {
      if (this.#directState !== "recovering" && this.#directState !== "unreachable") this.#setDirectState("slow", reason);
    }
  }

  #setDirectState(state, reason) {
    if (state === this.#directState) return;
    const prev = this.#directState;
    this.#directState = state;
    this.#directReason = reason;
    if (state === "connected") {
      this.directError = null;
      this.directHint = null;
    }
    const level = state === "unreachable" ? "error" : state === "recovering" ? "warn" : "info";
    this.#ll[level](`state ${prev} -> ${state}`, { reason, hint: this.directHint ?? undefined });
    this.#directHooks.state(state, reason);
  }

  #startRecovery(reason) {
    if (this.#directClosed) return;
    this.directError = reason;
    if (this.#directState !== "unreachable") this.#setDirectState("recovering", reason);
    if (this.#directConn) this.#dump(this.#directConn, true, reason);
    if (this.#recovery.running) return;
    this.#recovery.run().then((result) => {
      if (result === "unreachable" && !this.#directClosed) this.#setDirectState("unreachable", this.directError ?? reason);
    });
  }

  #recoveryStep(step) {
    if (this.#directClosed) return;
    this.#ll.info(`recovery step ${step.kind}`, { attempt: step.attempt });
    const d = this.#directConn;
    if (step.kind === "rebuild") {
      this.#rebuild("recovery");
      return;
    }
    if (!d) return;
    if (step.kind === "restart") {
      if (!this.impolite || this.#group.clock.now() - this.#lastRestartAt >= RESTART_REQUEST_GAP_MS) this.#restartIce(d, "recovery");
    } else if (step.kind === "turn") {
      this.#turnAdded = true;
      this.#ll.info("adding TURN servers");
      try {
        d.setConfiguration(this.#group.rtcConfig(true));
      } catch (error) {
        this.#ll.warn("setConfiguration failed", { error: error.message });
      }
      this.#restartIce(d, "turn fallback");
    }
  }

  /** The impolite side restarts ICE, the polite side asks for it. */
  #restartIce(d, reason) {
    if (this.impolite) this.#iceRestartNow(d, reason);
    else d.ralSignal({ t: "renegotiate", iceRestart: true, reason });
  }

  #iceRestartNow(d, reason) {
    if (d.ralClosed) return;
    this.#lastRestartAt = this.#group.clock.now();
    this.#ll.info("ICE restart", { reason });
    if (!d.remoteDescription) {
      this.#rebuild("restart before first answer");
      return;
    }
    this.#queue.push(() => d.ralIceRestart());
  }

  #rebuild(reason) {
    if (this.#directClosed) return;
    if (this.#group.clock.now() - this.#lastRebuildAt < RESTART_REQUEST_GAP_MS) return;
    if (this.impolite) this.#newDirect(reason);
    else {
      this.#ll.info("asking for rebuild", { reason });
      this.#directConn?.ralSignal({ t: "renegotiate", rebuild: true, reason });
    }
  }

  /**
   * ICE restart on a working direct connection, e.g. after a network change (decision D15). The
   * impolite side restarts, the polite side asks for it.
   * @param {string} reason
   */
  directIceRestart(reason) {
    const d = this.#directConn;
    if (!d || this.#directClosed) return;
    this.#restartIce(d, reason);
  }

  /** Re-checks liveness now and restarts ICE when the direct connection is slow or stale. */
  checkDirect(reason) {
    if (this.#directConn?.ralCheckNow()) this.directIceRestart(reason);
  }

  /**
   * Rebuilds the direct connection now. With `silent`, the old one is abandoned without closing
   * it, so the remote side learns of the rebuild only from the new session id (test hook for
   * doc §3.6).
   */
  rebuildDirect(reason = "requested", silent = false) {
    if (this.#directClosed || !this.#directHooks) return;
    this.#newDirect(reason, silent);
    if (!this.impolite) this.#directConn?.ralSignal({ t: "renegotiate", rebuild: true, reason });
  }

  async #dump(d, all, reason) {
    try {
      const stats = await readStats(d);
      const dump = pairDump(stats, all);
      this.#lastDump = { time: this.#group.clock.wallNow(), reason, ...dump };
      if (all) {
        const hint = failureHint(dump);
        if (hint) this.directHint = hint;
        this.#ll.warn("candidate pairs on failure", { reason, hint, ...summarizeDump(dump) });
      } else {
        this.#ll.info("selected candidate pair", summarizeDump(dump));
      }
    } catch {
      // connection gone
    }
  }

  #noteDirectError(area, error) {
    this.directError = error?.message ?? String(error);
    this.#ll.error(`${area} error`, { error: this.directError, stack: error?.stack?.split("\n").slice(0, 4).join(" | ") });
  }

  /**
   * Closes the direct connection for good.
   * @param {string} reason
   */
  closeDirect(reason) {
    if (this.#directClosed) return;
    this.#directClosed = true;
    if (!this.#directHooks) return;
    this.#setDirectState("closed", reason);
    this.#recovery.cancel();
    const d = this.#directConn;
    this.#directConn = null;
    if (this.#group.directConns.get(this.id) === d) this.#group.directConns.delete(this.id);
    if (d) this.#retireDirect(d);
  }

  // State ---------------------------------------------------------------------------------------

  /**
   * Sets the state, emitting `statechange` on change.
   * @param {string} state
   * @param {string} reason
   */
  setState(state, reason) {
    if (state === this.#state) return;
    if (this.#state === "closed") return;
    if (this.#state === "closing" && state !== "closed") return;
    const prev = this.#state;
    this.#state = state;
    this.#reason = reason;
    if (state === "connected") {
      this.#everConnected = true;
      this.lastError = null;
      this.hint = null;
    }
    const level = state === "unreachable" ? "error" : state === "reconnecting" ? "warn" : "info";
    this.#group.log.write(level, "routing", `peer state ${prev} -> ${state}`, { reason, hint: this.hint ?? undefined }, { peer: this.id });
    this.emit("statechange", state, reason);
  }

  /** True after the peer was connected once. */
  get everConnected() {
    return this.#everConnected;
  }

  /**
   * Closes the connection: `closing` before anything is shut down, `closed` at the end.
   * @param {string} [reason]
   */
  close(reason = "closed") {
    if (this.#state === "closed") return;
    this.setState("closing", reason);
    this.closeDirect(reason);
    this.#stopBeats();
    this.session.close();
    for (const [id] of this.#logRequests) this.#finishLog(id, null, new Error("peer closed"));
    this.setState("closed", reason);
  }
}

function describe(r) {
  if (!r) return "none";
  return r.kind === "direct" ? "direct" : `relay:${r.via}`;
}
