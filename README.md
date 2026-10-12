# realtic

A WebRTC mesh library in plain JavaScript (ES modules, no runtime dependencies) that adds what
the browser API leaves out:

- **Peer relays.** When two peers cannot connect directly, a third peer of the group relays
  their data (end to end encrypted) and media (re-encoded once, sent to every target). TURN is
  used only when no peer can relay.
- **Fast liveness and recovery.** One way idle heartbeats with receiver side judgment: a link is
  `slow` after 1 s of silence and stale after 5 s. Recovery runs ICE restarts with backoff, then
  rebuilds, and a pair with a relay switches to a warm standby relay at `slow` without
  renegotiation.
- **Production fixes of plain WebRTC.** Only one side offers, signaling is applied serially and
  deduplicated, candidates are batched, every connection has a session id, the data channel
  opening is watched, failures have a state, a reason and a hint, and a ring buffer log records
  everything from the start.

Reliable channels survive route switches, ICE restarts and rebuilds without losing or
duplicating messages. Media arrives in one stable `MediaStream` per publication that keeps
playing across route changes.

## Quick Start

```js
import { Group, WebSocketSignaling } from "realtic";

const selfId = crypto.randomUUID();
const group = new Group({
  selfId,
  signaling: new WebSocketSignaling("wss://example.com/signal", selfId, { room: "demo" }),
  iceServers: [{ urls: "stun:stun.example.com:3478" }],
  autoPeers: true,
});

group.on("peer", (peer) => {
  peer.on("statechange", (state) => console.log(peer.id, state, peer.route));
  peer.on("track", ({ stream }) => (videoFor(peer).srcObject = stream));
  peer.on("channel", (ch) => (ch.onmessage = (e) => console.log(e.data)));
});

const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
for (const track of media.getTracks()) group.publish(track);
```

Run the demos with the example signaling server:

```sh
npm install
node examples/server/server.js 8080
# http://localhost:8080/examples/call/?room=test   (open in several tabs or devices)
# http://localhost:8080/examples/chat/?room=test
```

## Documentation

- [API](docs/api.md)
- [Wire protocol](docs/protocol.md)
- [Deployment and TURN](docs/deployment.md)
- [Troubleshooting](docs/troubleshooting.md)
- [M0 feasibility report](docs/m0-report.md)

## Development

```sh
npm test                  # unit tests (node:test, fake clock)
npm run test:integration  # fast browser suite (Chromium and Firefox through Playwright)
npm run test:full         # DIR and REL scenarios in all browser pairings
npm run test:soak         # 8 peers with random faults, REALTIC_SOAK_MS / REALTIC_SEED
npm run lint
npm run types             # .d.ts from JSDoc into types/
npm run bundle            # optional single-file bundle in dist/
```

The integration tests run every peer in its own browser context and route all ICE traffic
through a user space UDP proxy (`test/integration/harness/netem.js`) that can block, delay,
drop by packet class, cap bandwidth and rebind each directed peer pair.

## Authorship

This project, including its purpose and overall architecture, was conceived and designed by its
human authors. The implementation was generated in full with AI assistance (Claude Code), under
the human authors' direction.
