// Test page controller: the Node test drives one peer per page through `window.t`.
import { Group, WebSocketSignaling } from "../../../src/index.js";

const BITS = 16;
const BLOCK = 20;
const W = BITS * BLOCK;
const H = 240;

const t = {
  group: null,
  events: [],
  channels: new Map(),
  received: new Map(),
  tracks: [],
  videos: new Map(),
  errors: [],
};
window.t = t;
window.addEventListener("error", (e) => t.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => t.errors.push(String(e.reason?.stack ?? e.reason)));

const now = () => Date.now();
const ev = (type, data) => t.events.push({ time: now(), type, ...data });

t.start = ({ id, signalingUrl, room = "test", config = {}, iceServers = [], hooks = false, autoPeers = false }) => {
  const signaling = new WebSocketSignaling(signalingUrl, id, { room });
  const testHooks = {};
  if (hooks && window.__outgoingSignal) testHooks.outgoingSignal = (to, msg) => window.__outgoingSignal(to, msg);
  if (config.probeIceServers) testHooks.probeIceServers = config.probeIceServers;
  const cfg = { ...config, testHooks };
  delete cfg.probeIceServers;
  const group = new Group({ selfId: id, signaling, iceServers, config: cfg, autoPeers });
  t.group = group;
  group.on("peer", (peer) => wirePeer(peer));
  group.on("peerleft", (peer, reason) => ev("peerleft", { peer: peer.id, reason }));
  return group.selfId;
};

function wirePeer(peer) {
  ev("peer", { peer: peer.id });
  peer.on("statechange", (state, reason) => ev("state", { peer: peer.id, state, reason }));
  peer.on("routechange", (route) => ev("route", { peer: peer.id, route }));
  peer.on("channel", (ch) => {
    ev("channel", { peer: peer.id, label: ch.label });
    registerChannel(peer.id, ch);
  });
  peer.on("track", (e) => {
    ev("track", { peer: peer.id, origin: e.origin, tag: e.tag, kind: e.kind });
    t.tracks.push({ peer: peer.id, ...e });
    if (e.kind === "video") attachVideo(`${e.origin}:${e.tag}`, e.stream);
  });
  peer.on("trackreplaced", (e) => ev("trackreplaced", { peer: peer.id, origin: e.origin, tag: e.tag }));
  peer.on("trackended", (e) => ev("trackended", { peer: peer.id, origin: e.origin, tag: e.tag }));
}

function registerChannel(peerId, ch) {
  const key = `${peerId}:${ch.label}`;
  t.channels.set(key, ch);
  if (!t.received.has(key)) t.received.set(key, []);
  ch.addEventListener("message", (e) => t.received.get(key).push(typeof e.data === "string" ? e.data : `bin:${e.data.byteLength}`));
  ch.addEventListener("open", () => ev("open", { peer: peerId, label: ch.label }));
  ch.addEventListener("close", () => ev("close", { peer: peerId, label: ch.label }));
}

t.addPeer = (id) => void t.group.addPeer(id);
t.removePeer = (id) => t.group.removePeer(id);
t.state = (id) => t.group.peers.get(id)?.state ?? null;
t.route = (id) => t.group.peers.get(id)?.route ?? null;
t.peerInfo = (id) => {
  const p = t.group.peers.get(id);
  return p ? { state: p.state, reason: p.reason, route: p.route, lastError: p.lastError, hint: p.hint } : null;
};
t.linkInfo = (id) => {
  const l = t.group.links.get(id);
  return l ? { state: l.state, liveness: l.liveness, session: l.session, metrics: l.metrics, lastError: l.lastError, hint: l.hint } : null;
};

t.createChannel = (peerId, label, init) => {
  const ch = t.group.peers.get(peerId).createChannel(label, init);
  registerChannel(peerId, ch);
  return ch.id;
};
t.channelState = (peerId, label) => t.channels.get(`${peerId}:${label}`)?.readyState ?? null;
t.send = (peerId, label, data) => {
  try {
    t.channels.get(`${peerId}:${label}`).send(data);
    return "ok";
  } catch (e) {
    return e.name;
  }
};
t.sendMany = (peerId, label, prefix, count, start = 0) => {
  const ch = t.channels.get(`${peerId}:${label}`);
  for (let i = start; i < start + count; i++) {
    try {
      ch.send(`${prefix}${i}`);
    } catch (e) {
      return { sent: i - start, error: e.name };
    }
  }
  return { sent: count };
};
t.sendBinary = (peerId, label, size) => {
  try {
    t.channels.get(`${peerId}:${label}`).send(new Uint8Array(size).fill(7));
    return "ok";
  } catch (e) {
    return e.name;
  }
};
t.messages = (peerId, label) => t.received.get(`${peerId}:${label}`) ?? [];
t.bufferedAmount = (peerId, label) => t.channels.get(`${peerId}:${label}`)?.bufferedAmount;
t.closeChannel = (peerId, label) => t.channels.get(`${peerId}:${label}`)?.close();

// Media: a canvas track that encodes a frame counter in 16 blocks along the top row.
t.counterTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  let n = 0;
  const draw = () => {
    n++;
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, W, H);
    for (let b = 0; b < BITS; b++) {
      ctx.fillStyle = (n >> b) & 1 ? "#fff" : "#000";
      ctx.fillRect(b * BLOCK, 0, BLOCK, BLOCK * 2);
    }
  };
  draw();
  setInterval(draw, 33);
  const track = canvas.captureStream(30).getVideoTracks()[0];
  return track;
};

t.publishCounter = (tag = "camera", to = "all") => {
  const pub = t.group.publish(t.counterTrack(), { tag, to });
  t.pubs = t.pubs ?? new Map();
  t.pubs.set(tag, pub);
  return pub.id;
};
t.publishAudio = async (tag = "mic") => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const pub = t.group.publish(stream.getAudioTracks()[0], { tag });
  t.pubs = t.pubs ?? new Map();
  t.pubs.set(tag, pub);
  return pub.id;
};
t.replaceCounter = async (tag) => {
  await t.pubs.get(tag).replaceTrack(t.counterTrack());
};
t.unpublish = (tag) => t.pubs.get(tag)?.close();

function attachVideo(key, stream) {
  let v = t.videos.get(key);
  if (!v) {
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    document.body.append(video);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = BLOCK * 2;
    v = { video, canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), samples: [] };
    t.videos.set(key, v);
    sample(v);
  }
  v.video.srcObject = stream;
  v.video.play().catch(() => {});
}

function sample(v) {
  const step = () => {
    if (v.video.readyState >= 2 && v.video.videoWidth) {
      v.ctx.drawImage(v.video, 0, 0, v.video.videoWidth, (v.video.videoHeight * BLOCK * 2) / H, 0, 0, W, BLOCK * 2);
      const data = v.ctx.getImageData(0, 0, W, BLOCK * 2).data;
      let n = 0;
      for (let b = 0; b < BITS; b++) {
        const x = Math.round((b + 0.5) * BLOCK * (v.video.videoWidth / W) * (W / v.video.videoWidth));
        const i = (BLOCK * W + x) * 4;
        if (data[i] > 128) n |= 1 << b;
      }
      const last = v.samples.at(-1);
      if (!last || last.n !== n) v.samples.push({ time: now(), n });
      if (v.samples.length > 20000) v.samples.splice(0, 10000);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Frame counter samples of a received video: [{time, n}] (changes only). */
t.frames = (key, since = 0) => (t.videos.get(key)?.samples ?? []).filter((s) => s.time >= since);
/** Largest gap between counter changes in a time window, in ms. */
t.maxGap = (key, from, to = now()) => {
  const s = t.frames(key).filter((x) => x.time >= from && x.time <= to);
  if (!s.length) return to - from;
  let gap = s[0].time - from;
  for (let i = 1; i < s.length; i++) gap = Math.max(gap, s[i].time - s[i - 1].time);
  return Math.max(gap, to - s.at(-1).time);
};
t.trackCount = () => t.tracks.length;

t.log = (filter) => t.group.log.entries(filter);
t.logText = () => t.group.log.text();
t.report = () => t.group.diagnosticReport();
t.requestLog = async (peerId) => {
  try {
    const r = await t.group.peers.get(peerId).requestLog(8000);
    return { ok: true, entries: r.log.length, selfId: r.selfId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
t.stats = () => t.group.getStats();
t.setSubscription = (origin, sub) => t.group.setSubscription(origin, sub);
t.leave = () => t.group.leave();
t.close = () => t.group.close();
t.hook = {
  rebuild: (peerId) => t.group.links.get(peerId)?.rebuild("test hook"),
  abortTransport: (peerId) => t.group.links.get(peerId)?.abortTransport(),
  busy: (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  },
  visibility: (hidden) => {
    Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  },
};
t.ready = true;
