# realtic API

```js
import { RalPeerGroup } from "realtic";
```

## RalPeerGroup

```js
const group = new RalPeerGroup({
  selfId,          // optional, generated when absent; use a fresh id per page load
  signaling,       // { url, group, type? } of a reference server, or an adapter (see below)
  iceServers,      // passed to RTCPeerConnection (TURN handling: config.turnMode)
  config,          // overrides of DEFAULTS (src/config.js)
  autoPeers,       // add peers from the adapter's presence events and incoming hello
});
```

| Member | Description |
| ------ | ----------- |
| `addPeer(id)` | adds a peer and starts connecting; returns the stable `RalPeerConnection` |
| `removePeer(id)` | sends `bye`, closes the connection |
| `connections` | `Map<id, RalPeerConnection>`, one per known peer, also when it could not be opened |
| `publish(track, { tag, to })` | publishes a local track to `"all"` or a list of peer ids; returns a `Publication` |
| `setSubscription(origin, { audio, video, tags })` | which media of `origin` this side wants; unwanted flows stop at their source |
| `leave()` | sends `bye` over the mesh and the signaling server (beacon when supported) and closes; called on `pagehide` automatically |
| `close()` | closes everything without `bye` |
| `capabilities()` | `{ setSinkId, getDisplayMedia, encodedTransform, encodedStreams, trackGenerator, networkInformation }` |
| `getStats()` | links, routes, relay flows, relay load, bitrate budgets |
| `diagnosticReport()` | promise of a JSON-serializable report: log, versions, config, states, pair dumps, getStats snapshot |
| `log` | the ring buffer logger, see below |
| `ready` | promise, resolves when keys and capabilities are collected |

Events: `connection` (RalPeerConnection), `peerleft` (RalPeerConnection, reason), `presence`
({ type, peer }).

## RalPeerConnection

The connection to one other peer of the group. It is direct, wrapping an `RTCPeerConnection`, or
routes through a relay peer. Finding routes, keeping standby routes warm and switching routes
happen inside it.

| Member | Description |
| ------ | ----------- |
| `id` | remote peer id |
| `state` | `connecting`, `connected`, `slow`, `reconnecting`, `unreachable`, `closing`, `closed` |
| `reason` | reason of the last state change |
| `route` | `{ kind: "direct" \| "relay", via, candidateType: "host" \| "srflx" \| "prflx" \| "relay" }` or null |
| `lastError`, `hint` | failure details; hints in `HINT_TEXT` |
| `createChannel(label, init)` | end to end data channel, `init`: `ordered`, `maxRetransmits`, `maxPacketLifeTime`, `protocol` |
| `requestLog()` | promise of the remote side's diagnostic report (needs its `shareLogWithPeers`) |
| `directConn` | the current `RalDirectPeerConnection` to this peer (an `RTCPeerConnection` subclass), null without a direct one; a rebuild replaces it; for advanced use |

Events: `statechange` (state, reason), `routechange` (route), `channel` (RalChannel),
`track` ({ track, stream, tag, kind, origin, pub }), `trackreplaced` ({ track, oldTrack, stream,
tag }), `trackended` ({ track, stream, tag }).

The `stream` of a `track` event is one `MediaStream` per publication. It stays the same across
route changes, ICE restarts and rebuilds; the library swaps the track inside it.

The `RalPeerConnection` object stays the same for the life of the remote page, so UI bound to it
never has to be rebuilt.

## RalChannel

`RTCDataChannel`-like: `send(data)` (string, ArrayBuffer, ArrayBufferView), `close()`,
`readyState`, `bufferedAmount`, `bufferedAmountLowThreshold`, `label`, `protocol`, `id`,
`ordered`, `maxRetransmits`, `maxPacketLifeTime`, `binaryType` (`"arraybuffer"`), events `open`,
`message`, `close`, `error`, `bufferedamountlow` (also as `on*` properties).

Differences to `RTCDataChannel`:

- The channel is end to end and survives route switches and link rebuilds.
- Reliable channels buffer messages during an outage and deliver them after recovery, in order
  and without duplicates. `send` throws `OperationError` when the outage buffer
  (`reliableBufferBytes`, 16 MiB) is full, and `InvalidStateError` when the channel is not open.
- `maxRetransmits` applies per hop on a relayed route, `maxPacketLifeTime` end to end.
- `Blob` is not accepted.

## attachMedia

`attachMedia(element, stream)` plays a stable stream in a media element and keeps it playing
when the library swaps the stream's track (route change, rebuild). Firefox needs it: it does not
render a track added to a playing `srcObject`. Returns a function that detaches it.

With `config.stableTracks` (Chromium, `MediaStreamTrackGenerator`), the `track` of the `track`
event is a generated track that never changes; frames of the current source are copied into it.

## Publication

`id`, `track`, `kind`, `tag`, `replaceTrack(track)` (no renegotiation), `close()`.

## Log

| Member | Description |
| ------ | ----------- |
| `entries({ since, level })` | copies of the buffered entries, oldest first |
| `text()` | readable lines, UTC timestamps `yyyy-MM-dd_HH-mm-ss.SSS` |
| `on("entry", fn)` | live entries at or above `config.logLevel` |
| `clear()` | empties the buffer |

Entry: `{ seq, time, level, area, peer, session, msg, data }`. Gaps in `seq` show overwritten
entries.

## Signaling Adapters

`RalPeerGroup({ signaling })` accepts settings `{ url, group, type, fastMs, idleMs }` and creates the
adapter with `createSignaling(settings, selfId)`. `type` defaults to `"websocket"` for `ws:` and
`wss:` URLs and to `"polling"` otherwise.

- `PollingSignaling(url, selfId, { group, fastMs, idleMs, activeMs, timeoutMs })` for
  `server/php/signal.php`. Polls every `fastMs` while signaling is active (for `activeMs`, 5000,
  after a message) and every `idleMs` otherwise; without options it uses the server's values.
- `WebSocketSignaling(url, selfId, { group })` for `server/node/server.js`.
- `MemoryHub` for tests: `hub.join(id)` returns an adapter.

An adapter of your own implements `send(to, msg)`, `onmessage(from, msg)`, optionally
`onpresence({ type: "join" | "leave", peer })`, `connected`, `sendBeacon(to, msg)`, and `close()`.

## Configuration

All values in `DEFAULTS` (`src/config.js`) can be overridden per group. The most relevant:

| Key | Default | Meaning |
| --- | ------- | ------- |
| `HEARTBEAT_IDLE_MS` | 500 | beat after this long without sending |
| `SLOW_CONNECTION_MS` | 1000 | silence until `slow` |
| `STALE_CONNECTION_MS` | 5000 | silence until recovery starts |
| `CHANNEL_OPEN_TIMEOUT_MS` | 8000 | ICE connected without `ctl` open until rebuild |
| `BACKGROUND_SLOW_MS`, `BACKGROUND_STALE_MS` | 12000, 20000 | thresholds while the remote page is hidden |
| `iceRestartBackoffMs` | [1000, 3000, 6000] | ICE restarts before a rebuild |
| `reprobeIntervalsMs` | [30000, 60000, 120000, 300000] | background re-probe after `unreachable` |
| `switchThreshold`, `switchHoldMs` | 0.25, 3000 | route hysteresis |
| `earlySwitchIntervalMs` | 10000 | at most one early switch to the standby per pair in this time |
| `relay` | true | relay for other members |
| `mediaRelay` | "allow" | "never" keeps this peer's media from being re-encoded by a relay |
| `allowRelay` | null | `(origin, target) => boolean` |
| `turnMode` | "fallback" | "always", "relay-only" |
| `logCapacity`, `logLevel`, `logConsole`, `logRedact` | 1024, "info", false, false | logging |
| `shareLogWithPeers` | false | answer `requestLog()` |
| `stableTracks` | false | one generated track per publication (Chromium) |
| `relayPeerDownMs` | 3000 | a relay reports a directly connected peer as down after this silence |
