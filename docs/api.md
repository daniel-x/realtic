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
  RTCPeerConnection, // optional, the class to use instead of globalThis.RTCPeerConnection
  clock,           // optional, timers and time source; default real time, RalFakeClock for tests
});
```

`RTCPeerConnection` must be a class: each direct connection is an instance of a subclass of it
(`RalDirectPeerConnection`), and the network change probe creates throwaway instances of it. Use
it for a wrapper that instruments calls, or for an implementation outside the browser. Without
it and without `globalThis.RTCPeerConnection`, peers cannot connect.

| Member | Description |
| ------ | ----------- |
| `addPeer(id)` | adds a peer and starts connecting; returns the stable `RalPeerConnection` |
| `removePeer(id)` | sends `bye`, closes the connection |
| `connections` | `Map<id, RalPeerConnection>`, one per known peer, also when it could not be opened |
| `publish(track, { tag, to })` | publishes a local track to `"all"` or a list of peer ids; returns a `RalPublication` |
| `setSubscription(origin, { audio, video, tags })` | which media of `origin` this side wants; unwanted flows stop at their source |
| `leave()` | sends `bye` over the mesh and the signaling server (beacon when supported) and closes; called on `pagehide` automatically |
| `close()` | closes everything without `bye` |
| `profile()` | `{ connectionType, effectiveType, saveData, metered, encode, decode, cpuLimited, encodeMsPerFrame, encodeShare, computeLimited }`; missing values are null; `encode` and `decode` map codecs to `{ supported, smooth, powerEfficient }`; `encodeMsPerFrame` is the encode time of one source frame, summed over the direct connections, and `encodeShare` is that time as a share of the frame time; `computeLimited` means `cpuLimited` or a share above `computeLimitShare` |
| `probeEncoding({ contentType, width, height, bitrate, framerate })` | promise of `{ supported, smooth, powerEfficient }` for a format, or null without an estimate |
| `setMetered(boolean)` | tells the group that the app treats this connection as metered; realtic has no rule of its own for it |
| `reportLoad(value)` | adds the app's load to the relay load figure; above `maxRelayLoad` this peer takes no new relay flows and routes move around it; 0 removes it |
| `relaysMedia` | true when this peer forwards media of others now, see `relayMedia` in the configuration |
| `capabilities()` | `{ setSinkId, getDisplayMedia, encodedTransform, encodedStreams, trackGenerator, networkInformation }` |
| `getStats()` | direct connections, routes, relay flows, relay load, bitrate budgets |
| `diagnosticReport()` | promise of a JSON-serializable report: log, versions, config, states, pair dumps, getStats snapshot |
| `log` | the ring buffer logger, see below |
| `ready` | promise, resolves when keys and capabilities are collected |

Events: `connection` (RalPeerConnection), `peerleft` (RalPeerConnection, reason), `presence`
({ type, peer }), `profilechange` (the result of `profile()`; encode time counts in whole
milliseconds).

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

Events: `statechange` (state, reason), `routechange` (route), `channel` (RalDataChannel),
`track` ({ track, stream, tag, kind, origin, pub }), `trackreplaced` ({ track, oldTrack, stream,
tag }), `trackended` ({ track, stream, tag }).

The `stream` of a `track` event is one `MediaStream` per publication. It stays the same across
route changes, ICE restarts and rebuilds; the library swaps the track inside it.

The `RalPeerConnection` object stays the same for the life of the remote page, so UI bound to it
never has to be rebuilt.

## RalDataChannel

`RTCDataChannel`-like: `send(data)` (string, ArrayBuffer, ArrayBufferView), `close()`,
`readyState`, `bufferedAmount`, `bufferedAmountLowThreshold`, `label`, `protocol`, `id`,
`ordered`, `maxRetransmits`, `maxPacketLifeTime`, `binaryType` (`"arraybuffer"`), events `open`,
`message`, `close`, `error`, `bufferedamountlow` (also as `on*` properties).

Differences to `RTCDataChannel`:

- The channel is end to end and survives route switches and direct connection rebuilds.
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

## RalPublication

`id`, `track`, `kind`, `tag`, `replaceTrack(track)` (no renegotiation), `close()`.

`setLimits({ maxBitrate, maxFramerate, scaleResolutionDownBy })` sets limits that last until the
next call. They combine with the bandwidth budgets: the lower bitrate and the larger downscale
apply. A relay applies `maxBitrate` of the origin too. `null` removes the limits.

`setTargets("all" | peerIds)` changes who receives the publication. Receivers that stay keep their
track and `MediaStream`. A receiver that goes gets `trackended`.

## RalLog

| Member | Description |
| ------ | ----------- |
| `entries({ since, level })` | copies of the buffered entries, oldest first |
| `text()` | readable lines, UTC timestamps `yyyy-MM-dd_HH-mm-ss.SSSSSS` (microseconds) |
| `on("entry", fn)` | live entries at or above `config.logLevel` |
| `clear()` | empties the buffer |

Entry: `{ seq, time, level, area, peer, session, msg, data }`. `time` is UTC milliseconds with a
microsecond fraction. Gaps in `seq` show overwritten entries.

## forwardLog

```js
import { forwardLog } from "realtic/log-forward";
const stop = forwardLog(group, { url: "https://example.com/realtic/log.php", group: "demo" });
```

Sends the log entries of `group` to a log endpoint of a reference server, which appends the
entries of all peers of a group to one file (see `docs/deployment.md`, Forwarded Logs). It starts
with the buffered entries, sends new ones every `intervalMs` (1000), and the rest with
`sendBeacon` on `pagehide`. Options: `url`, `group` (file name, default `"default"`), `level`
(`"debug"`), `intervalMs`. `stop()` returns a promise and sends what is left. The app decides
when to forward, e.g. behind a URL parameter; the demos use `?log_to_server=1`.

## Signaling Adapters

`RalPeerGroup({ signaling })` accepts settings `{ url, group, type, fastMs, idleMs }` and creates the
adapter with `createSignaling(settings, selfId)`. `type` defaults to `"websocket"` for `ws:` and
`wss:` URLs and to `"polling"` otherwise.

- `RalPollingSignaling(url, selfId, { group, fastMs, idleMs, activeMs, timeoutMs })` for
  `signal.php` of realtic-server-php. Polls every `fastMs` while signaling is active (for `activeMs`, 5000,
  after a message) and every `idleMs` otherwise; without options it uses the server's values.
- `RalWebSocketSignaling(url, selfId, { group })` for realtic-server-node.
- `RalMemoryHub` for tests: `hub.join(id)` returns an adapter.

An adapter of your own implements `send(to, msg)`, `onmessage(from, msg)`, optionally
`onpresence({ type: "join" | "leave", peer })`, `connected`, `sendBeacon(to, msg)`, `resume()`
(called after the device slept; reconnect or poll now), and `close()`.

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
| `relayMedia` | "auto" | whether this peer forwards media of others. `false` still relays data, and this peer's own media stays relayable by others. `"auto"` forwards unless metered or compute limited. The value travels in `hello` and `direct-table`, and routes prefer relays that forward media. A pair whose only relay does not forward media keeps its data on that relay, without media. |
| `computeLimitShare` | 0.5 | encode time as a share of the frame time above which a peer counts as compute limited |
| `allowRelay` | null | `(origin, target) => boolean` |
| `turnMode` | "fallback" | "always", "relay-only" |
| `logCapacity`, `logLevel`, `logConsole`, `logRedact` | 1024, "info", false, false | logging |
| `shareLogWithPeers` | false | answer `requestLog()` |
| `stableTracks` | false | one generated track per publication (Chromium) |
| `relayPeerDownMs` | 3000 | a relay reports a directly connected peer as down after this silence |
| `sleepCheckIntervalMs`, `sleepMinMs` | 1000, 2000 | sleep check timer; a tick `sleepMinMs` or more late is a sleep |
| `sleepRebuildMs` | 30000 | after a sleep this long, direct connections are rebuilt instead of ICE restarted |
