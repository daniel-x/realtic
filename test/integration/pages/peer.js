// Test page controller: the Node test drives one peer per page through `window.t`.
import { Group, WebSocketSignaling, attachMedia } from "../../../src/index.js";

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
  if (config.protocol) testHooks.protocol = config.protocol;
  if (config.caps) testHooks.caps = config.caps;
  testHooks.onForward = (bytes) => t.forwarded && t.forwarded.length < 2000 && t.forwarded.push(new TextDecoder().decode(bytes));
  const cfg = { ...config, testHooks };
  if (config.relayDenyAll) cfg.allowRelay = () => false;
  for (const k of ["probeIceServers", "protocol", "caps", "relayDenyAll"]) delete cfg[k];
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
/** A 640x360 noise video track at 15 fps: incompressible, so the encoder uses all bitrate it gets. */
t.noiseTrack = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(640, 360);
  const words = new Uint32Array(img.data.buffer);
  setInterval(() => {
    for (let i = 0; i < words.length; i++) words[i] = (Math.random() * 0xffffffff) | 0xff000000;
    ctx.putImageData(img, 0, 0);
  }, 66);
  return canvas.captureStream(15).getVideoTracks()[0];
};
t.publishNoise = (tag = "noise") => {
  const pub = t.group.publish(t.noiseTrack(), { tag });
  t.pubs = t.pubs ?? new Map();
  t.pubs.set(tag, pub);
  return pub.id;
};
t.publishCamera = async (tag = "camera", size = { width: 320, height: 240 }) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: size });
  const pub = t.group.publish(stream.getVideoTracks()[0], { tag });
  t.pubs = t.pubs ?? new Map();
  t.pubs.set(tag, pub);
  return pub.id;
};
/** Outbound video bitrate in bps toward peerId over `ms`. */
t.outboundBitrate = async (peerId, ms = 2000) => {
  const pc = t.group.links.get(peerId)?.pc;
  const bytes = async () => {
    let n = 0;
    (await pc.getStats()).forEach((s) => {
      if (s.type === "outbound-rtp" && s.kind === "video") n += s.bytesSent;
    });
    return n;
  };
  const b0 = await bytes();
  await new Promise((r) => setTimeout(r, ms));
  return ((await bytes()) - b0) * 8 / (ms / 1000);
};
/** Inbound media bytes from peerId. */
t.inboundBytes = async (peerId, kind) => {
  const pc = t.group.links.get(peerId)?.pc;
  let n = 0;
  (await pc.getStats()).forEach((s) => {
    if (s.type === "inbound-rtp" && (!kind || s.kind === kind)) n += s.bytesReceived;
  });
  return n;
};
/** maxBitrate of the video senders toward peerId. */
t.senderParams = (peerId) => {
  const pc = t.group.links.get(peerId)?.pc;
  return pc.getSenders().filter((s) => s.track?.kind === "video").map((s) => s.getParameters().encodings?.map((e) => ({ active: e.active, maxBitrate: e.maxBitrate, scale: e.scaleResolutionDownBy })));
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
  v.detach?.();
  v.detach = attachMedia(v.video, stream);
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
  rebuild: (peerId) => t.group.links.get(peerId)?.rebuild("test hook", true),
  abortTransport: (peerId) => t.group.links.get(peerId)?.abortTransport(),
  busy: (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end);
  },
  captureForwarded: () => (t.forwarded = []),
  transports: (peerId) => t.group.links.get(peerId)?.transports ?? [],
  sendCtl: (peerId, msg) => t.group.links.get(peerId)?.sendCtl(msg),
  rawEnvelope: async (via, target) => {
    const { encode } = await import("../../../src/transport/framing.js");
    const link = t.group.links.get(via);
    const dstIdx = t.group.localIndex(link, target);
    link.sendEnvelope("rel", "raw", encode({ version: 1, type: 0, flags: 1, srcIdx: 0, dstIdx, channelId: 9, seq: 1, payload: new Uint8Array(40) }));
  },
  visibility: (hidden) => {
    Object.defineProperty(document, "visibilityState", { value: hidden ? "hidden" : "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  },
};
t.ready = true;
