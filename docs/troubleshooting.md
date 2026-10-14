# Troubleshooting

## Collect Both Logs

realtic records every state change, signaling message, liveness verdict, ICE restart, relay
decision and candidate pair dump in a ring buffer from the moment the `RalPeerGroup` is created. A
connection has two ends; read both logs before concluding anything.

```js
copyButton.onclick = () => navigator.clipboard.writeText(group.log.text());
const report = await group.diagnosticReport();          // JSON, send it wherever you want
const remote = await peer.requestLog();                 // the other end, if it set shareLogWithPeers
forwardLog(group, { url: logUrl, group: "demo" });     // all peers into one server file
```

Timestamps are UTC, `yyyy-MM-dd_HH-mm-ss.SSSSSS` (microseconds), the same format on every device,
so two logs can be read side by side. `config.logRedact` replaces IP addresses with placeholders.

## Connection States

| State | Meaning |
| ----- | ------- |
| `connecting` | no route yet |
| `connected` | traffic arrives in time on the current route |
| `slow` | no traffic for more than `SLOW_CONNECTION_MS` (1 s) |
| `reconnecting` | the route went stale (5 s); recovery runs |
| `unreachable` | ICE restarts and rebuilds failed and no relay route exists; `connection.lastError` and `connection.hint` say why; a background re-probe keeps trying |
| `closing` | the peer is leaving or being removed; emitted before anything is shut down |
| `closed` | the peer left or was removed |

## Hints

`peer.hint` names a known failure pattern:

- `local-network-permission`: both devices show the same public address, so they share a
  network, and no host to host check got an answer. On Android 17+ and iOS the browser may lack
  the local network permission. AP client isolation (guest networks) looks the same; to tell
  them apart, ping one device from the other once the permission question is settled.
- `mdns-unresolved`: the other device offered only `.local` names and none resolved.
- `symmetric-nat`: no reflexive pair worked and this side's NAT maps per destination. Add a TURN
  server, or let a third peer relay.
- `protocol-mismatch`: the other side runs an incompatible major version of realtic.

## Candidate Pairs

On success the log has the selected pair (`host`, `srflx`, `relay`). On failure it has every pair
with state, responses, bytes and nomination. Counters a browser does not report are logged as
`unknown`, not as zero: Firefox does not report `requestsSent`, so `responsesReceived 0` together
with `checking` is the evidence that checks went out and nothing came back.

## Timing

Do not lower `STALE_CONNECTION_MS` below about 1 s. A phone on idle WiFi parks its radio and
shows latency spikes of several hundred milliseconds; a stale threshold below that tears down
working connections. The default of 5 s survives a WiFi to LTE handover.

## Sleep and Resume

Browsers have no event for a resume from system sleep. A timer every `sleepCheckIntervalMs`
detects it: a tick that comes `sleepMinMs` (2 s) or more late is a sleep; less can be load on the
main thread. Its length is the larger of the monotonic and the wall-clock delta between two ticks
(the monotonic clock pauses during sleep on Linux and macOS, not on Windows). The log shows
`resumed after sleep` with `sleepMs`, and each connection logs its `sleep reaction`:

| Sleep | Reaction |
| ----- | -------- |
| below `STALE_CONNECTION_MS` | heartbeat now; ICE restart only if still slow `SLOW_CONNECTION_MS` later |
| up to `sleepRebuildMs` (30 s) | ICE restart now; signaling reconnects, the network probe runs |
| `sleepRebuildMs` or more | rebuild now: ICE consent has expired, the other side is deep in its recovery |
| any, connection `unreachable` | rebuild now instead of waiting for the next background re-probe |

A restart or rebuild needs evidence of a suspension: the monotonic clock missed at least half of
the sleep, or the connection received nothing for at least half of it. A hidden tab whose timers
the browser throttled shows neither, because data keeps arriving, and only gets the check.
