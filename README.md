# realtic

A WebRTC mesh library in plain JavaScript (ES modules, no runtime dependencies) that adds what
the browser API leaves out:

- **Peer relays.** When two peers cannot connect directly, a third peer of the group relays
  their data (end to end encrypted) and media (re-encoded once, sent to every target). TURN is
  used only when no peer can relay.
- **Fast liveness and recovery.** One way idle heartbeats with receiver side judgment: a direct
  connection is `slow` after 1 s of silence and stale after 5 s. Recovery runs ICE restarts with
  backoff, then rebuilds, and a pair with a relay switches to a warm standby relay at `slow`
  without renegotiation.
- **Production fixes of plain WebRTC.** Only one side offers, signaling is applied serially and
  deduplicated, candidates are batched, every connection has a session id, the data channel
  opening is watched, failures have a state, a reason and a hint, and a ring buffer log records
  everything from the start.

Reliable channels survive route switches, ICE restarts and rebuilds without losing or
duplicating messages. Media arrives in one stable `MediaStream` per publication that keeps
playing across route changes.

## Install

```sh
npm install realtic
```

The package has no runtime dependencies.

## Quick Start

```js
import { RalPeerGroup } from "realtic";

const group = new RalPeerGroup({
  signaling: { url: "https://example.com/realtic/signal.php", group: "demo" },
  iceServers: [{ urls: "stun:stun.example.com:3478" }],
  autoPeers: true,
});

group.on("connection", (conn) => {
  conn.on("statechange", (state) => console.log(conn.id, state, conn.route));
  conn.on("track", ({ stream }) => (videoFor(conn).srcObject = stream));
  conn.on("channel", (ch) => (ch.onmessage = (e) => console.log(e.data)));
});

const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
for (const track of media.getTracks()) group.publish(track);
```

## Signaling Servers

realtic has two reference signaling servers, each in its own repository. The client picks the
adapter from the URL: a `ws://` or `wss://` URL uses the WebSocket adapter, any other URL the
polling adapter, or set `type: "polling" | "websocket"` explicitly.

- [realtic-server-php](https://github.com/daniel-x/realtic-server-php): `signal.php` with SQLite
  and repeated polling (no long-lived requests), for plain PHP hosting. This is the default of
  the demos.
- [realtic-server-node](https://github.com/daniel-x/realtic-server-node): a WebSocket server, for
  hosts that run a Node process.

Both serve the realtic client files too, so they run the demos. With the server repository
checked out next to this one:

```sh
cd ../realtic-server-php && php -S localhost:8080 router.php
# http://localhost:8080/examples/call/?group=test   (open in several tabs or devices)
# http://localhost:8080/examples/chat/?group=test

cd ../realtic-server-node && npm install && node server.js 8080
# http://localhost:8080/examples/call/?group=test&server=node
```

## Limitations

- **Browsers.** The automated tests run in Chromium and Firefox only. Safari and iOS are untested.
- **Access control.** The reference signaling servers have none: any client that knows a group
  name can join that group. Applications that need access control have to add it themselves.
- **Relays and data.** A relay peer cannot read or change relayed data, but it sees which peers
  communicate, envelope headers (channel id, sequence number), message sizes and timing.
- **Relays and media.** Relayed media is not end to end encrypted, because the relay decodes and
  re-encodes it, so the relay peer can read it. Set `mediaRelay: "never"` to rule this out; such a
  pair then uses TURN or gets no media.
- **Signaling server and keys.** The end to end keys are exchanged through the signaling server,
  so a malicious server could replace them and read relayed data. Plain WebRTC has the same trust
  model, because its DTLS fingerprints also pass through the signaling server.

## Documentation

- [API](docs/api.md)
- [Wire protocol](docs/protocol.md)
- [Deployment and TURN](docs/deployment.md)
- [Troubleshooting](docs/troubleshooting.md)
- [M0 feasibility report](docs/m0-report.md)

## Development

Development needs Node 20.19 or newer (within Node 22, 22.13 or newer), because of Playwright and
ESLint. The library itself runs in the browser and does not use Node.

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
through a user space UDP proxy (`test/integration/support/netem.js`) that can block, delay,
drop by packet class, cap bandwidth and rebind each directed peer pair.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or
  <http://www.apache.org/licenses/LICENSE-2.0>)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or <http://opensource.org/licenses/MIT>)

at your option.

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in
the work by you, as defined in the Apache-2.0 license, shall be dual licensed as above, without any
additional terms or conditions.

## Authorship

This project, including its purpose and overall architecture, was conceived and designed by its
human authors. The implementation was generated in full with AI assistance (Claude Code), under
the human authors' direction.
