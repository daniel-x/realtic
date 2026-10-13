import { Emitter } from "./util/emitter.js";
import { realClock } from "./util/clock.js";
import { randomId } from "./util/ids.js";
import { makeConfig, PROTOCOL, VERSION } from "./config.js";
import { Log } from "./diag/log.js";
import { diagnosticReport } from "./diag/report.js";
import { Dedupe } from "./signaling/queue.js";
import { SignalingRouter, RELAYABLE } from "./signaling/router.js";
import { DirectLink } from "./link/direct-link.js";
import { NetworkWatcher } from "./link/network.js";
import { ReatPeerConnection } from "./peer-connection.js";
import { decode } from "./transport/framing.js";
import { generateKeyPair, exportPublic, derivePairKey } from "./crypto/e2e.js";
import { MediaManager } from "./media/media.js";
import { collect as collectCaps, features } from "./media/capabilities.js";
import { wants, normalize } from "./media/subscriptions.js";
import { Routing } from "./routing/route.js";
import { createSignaling } from "./signaling/create.js";

const HELLO_RETRY_MS = 3000;
const isTurnServer = (s) => [].concat(s.urls).some((u) => /^turns?:/i.test(u));
const HELD_SIGNAL_LIMIT = 64;
const MESH_ONLY_REJECT = new Set(["hello", "offer", "answer"]);

/**
 * A group of peers in a mesh (plan section 3). The app owns membership: it calls `addPeer` and
 * `removePeer`, or enables `autoPeers` to follow the adapter's presence events.
 *
 * Events: `connection` (ReatPeerConnection) when a connection is created, `peerleft`
 * (ReatPeerConnection, reason), `presence` ({type, peer}).
 */
export class ReatPeerGroup extends Emitter {
  /**
   * One connection per known peer, also when it could not be opened.
   * @type {Map<string, ReatPeerConnection>}
   */
  connections = new Map();
  /**
   * The direct links of the connections that have one, i.e. every existing RTCPeerConnection.
   * Each link is owned by its connection (`connection.direct`).
   * @type {Map<string, DirectLink>}
   */
  directConns = new Map();
  #pendingHellos = new Map();
  #heldSignals = new Map();
  #helloTimers = new Map();
  #helloDone = new Set();
  #dedupe = new Dedupe();
  #indexTables = new Map();
  #closed = false;
  #keys = null;
  #publicJwk = null;
  #caps = null;
  #ready;
  #subscriptions = new Map();
  #cleanup = [];
  #tickTimer = null;

  /**
   * @param {object} options
   * @param {string} [options.selfId] fresh per page load (doc §7); generated when absent
   * @param {import("./signaling/adapter.js").SignalingAdapter | import("./signaling/create.js").SignalingOptions} options.signaling
   *   an adapter, or the settings of a reference server (see createSignaling)
   * @param {RTCIceServer[]} [options.iceServers]
   * @param {Partial<typeof import("./config.js").DEFAULTS>} [options.config]
   * @param {import("./util/clock.js").Clock} [options.clock]
   * @param {typeof RTCPeerConnection} [options.RTCPeerConnection]
   * @param {boolean} [options.autoPeers] add and remove peers from adapter presence events
   */
  constructor({ selfId = randomId(16), signaling, iceServers = [], config, clock = realClock, RTCPeerConnection: RTC = globalThis.RTCPeerConnection, autoPeers = false }) {
    super();
    this.selfId = selfId;
    this.config = makeConfig(config);
    this.clock = clock;
    this.iceServers = iceServers;
    if (typeof signaling?.send !== "function") signaling = createSignaling(signaling, selfId);
    this.signaling = signaling;
    this.RTC = RTC;
    this.autoPeers = autoPeers;
    this.log = new Log({ capacity: this.config.logCapacity, level: this.config.logLevel, console: this.config.logConsole, redact: this.config.logRedact, clock });
    this.onListenerError = (error, name) => this.log.write("error", "app", `listener for ${name} threw`, { error: error?.message, stack: error?.stack });
    this.l = this.log.scope("signaling");
    this.hooks = this.config.testHooks ?? {};
    /** Protocol version this peer speaks (test hooks may override it). */
    this.protocol = this.hooks.protocol ?? PROTOCOL;
    this.router = new SignalingRouter({
      selfId,
      adapter: () => this.signaling,
      link: (id) => this.directConns.get(id),
      relayFor: (target) => this.routing.relayFor(target),
      log: this.l,
      hooks: this.hooks,
    });
    this.media = new MediaManager(this);
    this.routing = new Routing(this);
    this.network = new NetworkWatcher(this);
    this.linkCtx = {
      selfId,
      config: this.config,
      clock,
      log: this.log,
      RTCPeerConnection: RTC,
      sendSignal: (to, msg) => this.router.send(to, msg),
      rtcConfig: (link, withTurn) => this.rtcConfig(withTurn),
      canAddTurn: (link) => this.routing.canAddTurn(link.remoteId),
    };
    signaling.onmessage = (from, msg) => this.#onServerMessage(from, msg);
    if ("onpresence" in signaling || signaling.onpresence === undefined) signaling.onpresence = (event) => this.#onPresence(event);
    this.log.write("info", "group", "group created", { selfId, version: VERSION, protocol: PROTOCOL, userAgent: globalThis.navigator?.userAgent });
    this.#ready = this.#init();
    this.#installLifecycle();
    this.#tickTimer = clock.setInterval(() => this.routing.tick(), 1000);
  }

  async #init() {
    this.#keys = await generateKeyPair();
    this.#publicJwk = await exportPublic(this.#keys.publicKey);
    this.#caps = { ...(await collectCaps()), ...(this.hooks.caps ?? {}) };
  }

  /** Resolves when keys and capabilities are ready. */
  get ready() {
    return this.#ready;
  }

  /** Local codec capabilities, once collected. */
  get localCaps() {
    return this.#caps;
  }

  /** RTCConfiguration for a link (plan section 11). */
  rtcConfig(withTurn) {
    const mode = this.config.turnMode;
    let servers = this.iceServers;
    if (mode === "fallback" && !withTurn) servers = servers.filter((s) => !isTurnServer(s));
    const cfg = { iceServers: servers, bundlePolicy: "max-bundle" };
    if (mode === "relay-only") cfg.iceTransportPolicy = "relay";
    return cfg;
  }

  /** True when TURN servers are configured. */
  get hasTurn() {
    return this.iceServers.some(isTurnServer);
  }

  // Membership ----------------------------------------------------------------------------------

  /**
   * Adds a peer to the group and starts connecting to it. Returns the stable ReatPeerConnection.
   * @param {string} peerId
   */
  addPeer(peerId) {
    if (this.#closed) throw new Error("group is closed");
    if (peerId === this.selfId) throw new Error("cannot add self");
    let peer = this.connections.get(peerId);
    if (peer) return peer;
    peer = new ReatPeerConnection(this, peerId);
    peer.onListenerError = this.onListenerError;
    this.connections.set(peerId, peer);
    this.log.write("info", "group", "peer added", undefined, { peer: peerId });
    this.emit("connection", peer);
    this.#ready.then(() => {
      if (this.connections.get(peerId) !== peer) return;
      this.#sendHello(peerId, false);
      const pending = this.#pendingHellos.get(peerId);
      this.#pendingHellos.delete(peerId);
      if (pending) this.#onHello(peerId, pending);
    });
    return peer;
  }

  /**
   * Removes a peer: sends `bye` and closes its link.
   * @param {string} peerId
   */
  removePeer(peerId, reason = "removed") {
    const peer = this.connections.get(peerId);
    if (!peer) return;
    this.router.send(peerId, { t: "bye", reason });
    this.#dropPeer(peerId, reason);
  }

  #dropPeer(peerId, reason) {
    const peer = this.connections.get(peerId);
    peer?.setState("closing", reason);
    this.connections.delete(peerId);
    this.#helloDone.delete(peerId);
    this.#pendingHellos.delete(peerId);
    this.#heldSignals.delete(peerId);
    this.#stopHelloRetry(peerId);
    this.routing.peerGone(peerId);
    if (peer?.direct) {
      this.directConns.delete(peerId);
      this.#indexTables.delete(peerId);
      this.media.resetLink(peerId);
      peer.closeDirect(reason);
    }
    this.media.streams.dropOrigin(peerId);
    if (peer) {
      peer.close(reason);
      this.log.write("info", "group", "peer left", { reason }, { peer: peerId });
      this.emit("peerleft", peer, reason);
    }
    this.mediaChanged();
  }

  #onPresence(event) {
    this.emit("presence", event);
    if (!this.autoPeers || this.#closed) return;
    if (event.type === "join" && event.peer !== this.selfId) this.addPeer(event.peer);
    if (event.type === "leave" && this.connections.has(event.peer) && !this.connections.get(event.peer).everConnected) this.#dropPeer(event.peer, "left");
  }

  // Hello ---------------------------------------------------------------------------------------

  #helloMessage(ack, peerId) {
    return {
      t: "hello",
      ack,
      media: this.routing.mediaRelay.kindsFor(peerId),
      proto: { major: this.protocol.major, minor: this.protocol.minor, features: this.protocol.features },
      key: this.#publicJwk,
      caps: this.#caps,
      relay: this.config.relay,
      mediaRelay: this.config.mediaRelay,
    };
  }

  #sendHello(peerId, ack) {
    this.router.send(peerId, this.#helloMessage(ack, peerId), { serverOnly: true });
    if (ack || this.#helloTimers.has(peerId)) return;
    const timer = this.clock.setInterval(() => {
      if (this.#helloDone.has(peerId) || !this.connections.has(peerId)) return this.#stopHelloRetry(peerId);
      this.router.send(peerId, this.#helloMessage(false, peerId), { serverOnly: true });
    }, HELLO_RETRY_MS);
    this.#helloTimers.set(peerId, timer);
  }

  #stopHelloRetry(peerId) {
    this.clock.clearInterval(this.#helloTimers.get(peerId));
    this.#helloTimers.delete(peerId);
  }

  async #onHello(from, msg) {
    const peer = this.connections.get(from);
    if (!peer) {
      this.#pendingHellos.set(from, msg);
      this.emit("presence", { type: "hello", peer: from });
      if (this.autoPeers) this.addPeer(from);
      return;
    }
    await this.#ready;
    if (!msg.ack) this.#sendHello(from, true);
    const first = !this.#helloDone.has(from);
    this.#helloDone.add(from);
    this.#stopHelloRetry(from);
    if (msg.proto?.major !== this.protocol.major) {
      peer.lastError = `protocol major ${msg.proto?.major} differs from ${this.protocol.major}`;
      peer.hint = "protocol-mismatch";
      this.log.write("error", "signaling", "protocol mismatch", { remote: msg.proto, local: this.protocol }, { peer: from });
      peer.setState("unreachable", "protocol-mismatch");
      return;
    }
    if (!first && peer.remote) return;
    const minor = Math.min(this.protocol.minor, msg.proto.minor ?? 0);
    const featuresCommon = this.protocol.features.filter((f) => (msg.proto.features ?? []).includes(f));
    peer.remote = { ...msg, proto: { major: this.protocol.major, minor, features: featuresCommon } };
    this.routing.mediaRelay.onRemoteKinds(from, msg.media);
    try {
      peer.pairKey = await derivePairKey(this.#keys.privateKey, msg.key, this.selfId, from);
    } catch (error) {
      this.log.write("error", "signaling", "key agreement failed", { error: error.message }, { peer: from });
    }
    this.log.write("info", "signaling", "hello complete", { minor, features: featuresCommon }, { peer: from });
    this.#ensureLink(from);
    this.routing.peerReady(from);
  }

  #ensureLink(peerId) {
    const conn = this.connections.get(peerId);
    if (conn.direct) return conn.direct;
    const link = new DirectLink(this.linkCtx, peerId);
    link.onListenerError = this.onListenerError;
    conn.direct = link;
    this.directConns.set(peerId, link);
    this.#indexTables.set(peerId, newIndexTable(this.selfId, peerId));
    link.on("state", (state, reason) => this.routing.linkState(link, state, reason));
    link.on("ctl", (msg) => this.#onLinkCtl(link, msg));
    link.on("envelope", (bytes, key) => this.#onEnvelope(link, bytes, key));
    link.on("open", () => this.#onLinkOpen(link));
    link.on("rebuilt", () => {
      this.#indexTables.set(peerId, newIndexTable(this.selfId, peerId));
      this.media.resetLink(peerId);
      this.routing.linkRebuilt(peerId);
    });
    link.on("negotiated", () => this.media.resolve(link));
    link.on("remotetrack", () => this.media.resolve(link));
    link.on("metrics", (m, stats) => this.routing.onMetrics(link, m, stats));
    link.on("drain", () => this.#onDrain(link));
    link.start();
    const held = this.#heldSignals.get(peerId) ?? [];
    this.#heldSignals.delete(peerId);
    for (const msg of held) link.handleSignal(msg);
    return link;
  }

  // Signaling in ---------------------------------------------------------------------------------

  #onServerMessage(from, msg) {
    if (this.#closed || !msg || typeof msg !== "object") return;
    if (msg.to && msg.to !== this.selfId) return;
    this.#onSignal(from, msg, null);
  }

  #onSignal(from, msg, viaLink) {
    if (!this.#dedupe.first(msg.id)) {
      this.l.debug("dropped duplicate signal", { t: msg.t, id: msg.id, from });
      return;
    }
    if (this.hooks.incomingSignal && this.hooks.incomingSignal(from, msg, viaLink?.remoteId ?? "server") === false) return;
    this.l.debug("signal received", { t: msg.t, from, id: msg.id, path: viaLink ? `mesh:${viaLink.remoteId}` : "server" });
    if (msg.t === "hello") return void this.#onHello(from, msg);
    if (msg.t === "bye") {
      if (this.connections.has(from)) this.#dropPeer(from, msg.reason === "leave" ? "left" : msg.reason ?? "left");
      return;
    }
    const link = this.directConns.get(from);
    if (!link) {
      let held = this.#heldSignals.get(from);
      if (!held) this.#heldSignals.set(from, (held = []));
      if (held.length < HELD_SIGNAL_LIMIT) held.push(msg);
      this.l.debug("signal held until the link exists", { t: msg.t, from });
      return;
    }
    link.handleSignal(msg);
  }

  #onMeshSignal(link, msg) {
    if (!msg || typeof msg !== "object" || typeof msg.from !== "string") return;
    if (msg.to === this.selfId) {
      if (msg.from !== link.remoteId && MESH_ONLY_REJECT.has(msg.t)) {
        this.l.warn("rejected relayed security-relevant signal", { t: msg.t, from: msg.from, via: link.remoteId });
        return;
      }
      if (msg.from !== link.remoteId && !this.connections.has(msg.from)) return;
      this.#onSignal(msg.from, msg, link);
      return;
    }
    if (msg.from !== link.remoteId || !RELAYABLE.has(msg.t)) {
      this.log.write("warn", "relay", "refused to forward signal", { t: msg.t, from: msg.from, to: msg.to });
      return;
    }
    const next = this.directConns.get(msg.to);
    if (!next?.ctlOpen || !this.#helloDone.has(msg.to) || !this.#helloDone.has(msg.from)) return;
    this.log.write("debug", "relay", "forward signal", { t: msg.t, from: msg.from, to: msg.to });
    next.sendCtl({ t: "sig", msg });
  }

  // Links ---------------------------------------------------------------------------------------

  #onLinkOpen(link) {
    const table = this.#indexTables.get(link.remoteId);
    const map = {};
    for (const [id, idx] of table.local) if (idx > 1) map[idx] = id;
    if (Object.keys(map).length) link.sendCtl({ t: "index-map", map, full: true });
    if (typeof document !== "undefined" && document.visibilityState === "hidden") link.setBackground(true);
    this.routing.linkOpen(link);
    this.media.sync(link);
  }

  #onLinkCtl(link, msg) {
    switch (msg.t) {
      case "sig":
        this.#onMeshSignal(link, msg.msg);
        return;
      case "index-map": {
        const table = this.#indexTables.get(link.remoteId);
        if (!table) return;
        if (msg.full) {
          table.remote = new Map([[0, link.remoteId], [1, this.selfId]]);
        }
        for (const [idx, id] of Object.entries(msg.map ?? {})) {
          const n = Number(idx);
          if (n > 1 && n < 256) table.remote.set(n, String(id));
        }
        return;
      }
      case "mid-map":
        this.media.onMidMap(link, msg);
        return;
      case "subscription":
        this.routing.mediaRelay.onSubscription(link, msg);
        return;
      default:
        this.routing.onCtl(link, msg);
    }
  }

  /**
   * The index this side uses for `peerId` on `link`, allocating and announcing a new one.
   * @param {DirectLink} link
   * @param {string} peerId
   */
  localIndex(link, peerId) {
    const table = this.#indexTables.get(link.remoteId);
    let idx = table.local.get(peerId);
    if (idx !== undefined) return idx;
    idx = table.next++;
    if (idx > 255) throw new RangeError("index table full");
    table.local.set(peerId, idx);
    link.sendCtl({ t: "index-map", map: { [idx]: peerId } });
    return idx;
  }

  /** Peer id for an index in the neighbor's table, or undefined. */
  remoteIndex(link, idx) {
    return this.#indexTables.get(link.remoteId)?.remote.get(idx);
  }

  #onEnvelope(link, bytes, key) {
    const e = decode(bytes);
    if (!e) return;
    if (e.version !== this.protocol.major) {
      this.log.write("warn", "channel", "dropped envelope with other major version", { version: e.version }, { peer: link.remoteId });
      return;
    }
    const src = this.remoteIndex(link, e.srcIdx);
    const dst = this.remoteIndex(link, e.dstIdx);
    if (!src || !dst) {
      this.log.write("debug", "channel", "dropped envelope with unknown index", { srcIdx: e.srcIdx, dstIdx: e.dstIdx }, { peer: link.remoteId });
      return;
    }
    if (dst === this.selfId) {
      const peer = this.connections.get(src);
      if (!peer) return;
      const relayed = src !== link.remoteId;
      if (relayed && !this.routing.acceptsRelayed(src, link.remoteId)) {
        this.log.write("debug", "relay", "dropped envelope from unknown relay flow", { via: link.remoteId }, { peer: src });
        return;
      }
      peer.receiveEnvelope(e, relayed, link.remoteId);
      return;
    }
    this.routing.forward(link, src, dst, bytes, e, key);
  }

  #onDrain(link) {
    for (const peer of this.connections.values()) {
      const r = peer.routeInfo;
      if (r && (r.kind === "direct" ? peer.id : r.via) === link.remoteId) peer.pump();
    }
  }

  // Hooks for peers, routing and media ------------------------------------------------------------

  /** @internal link id whose received tracks of `origin` the stable stream should use */
  mediaSourceFor(origin) {
    const r = this.connections.get(origin)?.routeInfo;
    if (!r) return origin;
    return r.kind === "direct" ? origin : r.via;
  }

  /** @internal re-plans media on all open links */
  mediaChanged() {
    for (const link of this.directConns.values()) if (link.ctlOpen) this.media.sync(link);
  }

  /** True when this side wants `origin`'s track of `kind` and `tag`. */
  subscribed(origin, kind, tag) {
    return wants(this.#subscriptions.get(origin), kind, tag);
  }

  /** This side's subscription for `origin`. */
  subscription(origin) {
    return this.#subscriptions.get(origin);
  }

  /** True when hello with `peerId` completed. */
  helloDone(peerId) {
    return this.#helloDone.has(peerId);
  }

  // Media API -----------------------------------------------------------------------------------

  /**
   * Publishes a local track to all peers or a list of peer ids.
   * @param {MediaStreamTrack} track
   * @param {{tag?: string, to?: "all" | string[]}} [options]
   */
  publish(track, options) {
    return this.media.publish(track, options);
  }

  /**
   * Sets which media of `origin` this side wants. Unsubscribed flows stop at their source.
   * @param {string} origin
   * @param {import("./media/subscriptions.js").Subscription} sub
   */
  setSubscription(origin, sub) {
    const n = normalize(sub);
    this.#subscriptions.set(origin, n);
    this.log.write("info", "media", "subscription", n, { peer: origin });
    this.routing.subscriptionChanged(origin);
  }

  // Lifecycle -----------------------------------------------------------------------------------

  #installLifecycle() {
    const g = globalThis;
    const on = (target, name, fn) => {
      if (!target?.addEventListener) return;
      target.addEventListener(name, fn);
      this.#cleanup.push(() => target.removeEventListener(name, fn));
    };
    if (typeof document !== "undefined") {
      on(document, "visibilitychange", () => this.#onVisibility(document.visibilityState === "hidden"));
    }
    on(g, "pagehide", () => this.leave());
    on(g, "online", () => this.checkLinks("online"));
    on(g.navigator?.connection, "change", () => this.network.onConnectionChange());
    this.network.start();
  }

  #onVisibility(hidden) {
    this.log.write("info", "group", hidden ? "page hidden" : "page visible");
    for (const link of this.directConns.values()) if (link.ctlOpen) link.setBackground(hidden);
    for (const peer of this.connections.values()) {
      if (peer.routeInfo?.kind === "relay") peer.session.sendControl({ t: hidden ? "bg" : "fg" });
    }
    if (!hidden) {
      this.checkLinks("visible");
      this.network.probeNow("visible");
    }
  }

  /** Runs a liveness check on all links at once; restarts ICE on slow or stale ones. */
  checkLinks(reason) {
    this.log.write("info", "group", "checking links", { reason });
    for (const link of this.directConns.values()) link.checkNow(reason);
  }

  /** ICE restart on every live direct link (decision D15). */
  restartAll(reason) {
    for (const link of this.directConns.values()) if (link.ctlOpen) link.iceRestart(reason);
  }

  /** Sends `bye` to all peers via mesh and signaling. Usable from `pagehide`. */
  leave() {
    if (this.#closed) return;
    for (const id of this.connections.keys()) {
      const msg = { t: "bye", reason: "leave" };
      const link = this.directConns.get(id);
      if (link?.ctlOpen) link.sendCtl({ t: "sig", msg: { ...msg, from: this.selfId, to: id, id: randomId(12) } });
      this.router.beacon(id, msg);
    }
    this.close("leave");
  }

  /** Browser and library features (plan section 10.6). */
  capabilities() {
    return features();
  }

  /** Per link and per route metrics, relay load and budgets. */
  getStats() {
    return this.routing.stats();
  }

  /** JSON-serializable bundle for problem reports (plan section 12.1). */
  diagnosticReport() {
    return diagnosticReport(this);
  }

  /** Closes all connections. */
  close(reason = "closed") {
    if (this.#closed) return;
    this.log.write("info", "group", "group closed", { reason });
    for (const id of [...this.connections.keys()]) this.#dropPeer(id, reason);
    this.#closed = true;
    this.clock.clearInterval(this.#tickTimer);
    for (const t of this.#helloTimers.values()) this.clock.clearInterval(t);
    this.network.stop();
    this.routing.close();
    for (const fn of this.#cleanup) fn();
    try {
      this.signaling.close?.();
    } catch {
      // adapter already closed
    }
  }

  /** True after close(). */
  get closed() {
    return this.#closed;
  }
}

function newIndexTable(selfId, remoteId) {
  return {
    local: new Map([[selfId, 0], [remoteId, 1]]),
    remote: new Map([[0, remoteId], [1, selfId]]),
    next: 2,
  };
}
