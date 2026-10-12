// Mesh call demo: every page in the same group calls every other. Open
// http://localhost:8080/examples/call/?group=test in several tabs or devices (add &server=node
// for the Node server).
import { RealticGroup, HINT_TEXT, attachMedia } from "../../src/index.js";
import { demoSignaling } from "../signaling.js";

const params = new URLSearchParams(location.search);
const groupName = params.get("group") ?? "demo";
const selfId = crypto.randomUUID().slice(0, 8);
const group = new RealticGroup({ selfId, signaling: demoSignaling(groupName), autoPeers: true, iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
document.getElementById("me").textContent = `you: ${selfId}, group: ${groupName}`;

const tiles = document.getElementById("tiles");
const tileFor = new Map();

function tile(peerId) {
  let t = tileFor.get(peerId);
  if (t) return t;
  const el = document.createElement("div");
  el.className = "tile";
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  const label = document.createElement("div");
  label.className = "label";
  label.title = "click to copy the last error";
  el.append(video, label);
  tiles.append(el);
  t = { el, video, label };
  tileFor.set(peerId, t);
  label.onclick = () => navigator.clipboard?.writeText(label.textContent);
  return t;
}

function render(peer) {
  const t = tile(peer.id);
  const route = peer.route ? (peer.route.kind === "relay" ? ` via ${peer.route.via}` : ` ${peer.route.candidateType}`) : "";
  const hint = peer.hint ? ` - ${HINT_TEXT[peer.hint] ?? peer.hint}` : "";
  t.label.textContent = `${peer.id}: ${peer.state}${route}${peer.state === "unreachable" ? ` (${peer.lastError ?? ""})` : ""}${hint}`;
  t.el.className = `tile state-${peer.state}`;
}

group.on("connection", (peer) => {
  render(peer);
  peer.on("statechange", () => render(peer));
  peer.on("routechange", () => render(peer));
  peer.on("track", ({ stream, kind }) => {
    if (kind === "video" || !tile(peer.id).video.srcObject) attachMedia(tile(peer.id).video, stream);
  });
});
group.on("peerleft", (peer) => {
  tileFor.get(peer.id)?.el.remove();
  tileFor.delete(peer.id);
});

// Joining without devices is normal: publish what exists, receive the rest.
let mic = null;
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  const me = tile(selfId);
  me.video.muted = true;
  me.video.srcObject = stream;
  me.label.textContent = `${selfId} (you)`;
  for (const track of stream.getTracks()) {
    const pub = group.publish(track, { tag: track.kind === "audio" ? "mic" : "camera" });
    if (track.kind === "audio") mic = pub;
  }
} catch (error) {
  tile(selfId).label.textContent = `${selfId} (you, no camera/microphone: ${error.name})`;
}

document.getElementById("mute").onclick = (e) => {
  if (!mic) return;
  mic.track.enabled = !mic.track.enabled;
  e.target.textContent = mic.track.enabled ? "Mute" : "Unmute";
};

const caps = group.capabilities();
const screenBtn = document.getElementById("screen");
screenBtn.hidden = !caps.getDisplayMedia;
let screen = null;
screenBtn.onclick = async () => {
  if (screen) {
    screen.close();
    screen = null;
    return;
  }
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
  screen = group.publish(s.getVideoTracks()[0], { tag: "screen" });
};

const diag = document.getElementById("diag");
document.getElementById("diagBtn").onclick = () => {
  diag.style.display = diag.style.display === "block" ? "none" : "block";
  diag.textContent = group.log.text();
};
group.log.on("entry", () => {
  if (diag.style.display === "block") diag.textContent = group.log.text();
});
document.getElementById("copy").onclick = () => navigator.clipboard?.writeText(group.log.text());
