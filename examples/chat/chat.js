// Data-only demo: a reliable chat channel to every peer in the group.
import { ReatPeerGroup } from "../../src/index.js";
import { demoSignaling } from "../signaling.js";

const groupName = new URLSearchParams(location.search).get("group") ?? "chat";
const selfId = crypto.randomUUID().slice(0, 8);
const group = new ReatPeerGroup({ selfId, signaling: demoSignaling(groupName), autoPeers: true });
const channels = new Map();
const log = document.getElementById("log");

function line(text) {
  const div = document.createElement("div");
  div.textContent = text;
  log.append(div);
  log.scrollTop = log.scrollHeight;
}

function showPeers() {
  document.getElementById("peers").textContent =
    `you: ${selfId} | ` + [...group.connections.values()].map((p) => `${p.id}: ${p.state}${p.route?.kind === "relay" ? ` via ${p.route.via}` : ""}`).join(", ");
}

function use(peer, channel) {
  channels.set(peer.id, channel);
  channel.onmessage = (e) => line(`${peer.id}: ${e.data}`);
}

group.on("connection", (peer) => {
  peer.on("statechange", showPeers);
  peer.on("routechange", showPeers);
  peer.on("channel", (ch) => ch.label === "chat" && use(peer, ch));
  // Both sides may create the channel; ids never collide. The lower id keeps the one it created.
  if (selfId < peer.id) use(peer, peer.createChannel("chat"));
  showPeers();
});
group.on("peerleft", (peer) => {
  channels.delete(peer.id);
  showPeers();
});

document.getElementById("f").onsubmit = (e) => {
  e.preventDefault();
  const input = document.getElementById("text");
  for (const ch of channels.values()) if (ch.readyState === "open") ch.send(input.value);
  line(`you: ${input.value}`);
  input.value = "";
};
