# Deploying realtic

## Secure Context

`getUserMedia` and WebRTC need a secure context: HTTPS, or `http://localhost` during development.
A phone on the local network needs a real certificate or a tunnel.

## Signaling

realtic talks to a signaling server through an adapter (`{ send, onmessage, onpresence, close }`).
`RalPeerGroup` takes either an adapter or the settings of a reference server:

```js
new RalPeerGroup({ signaling: { url: "https://example.com/realtic/signal.php", group: "demo" } }); // PHP server
new RalPeerGroup({ signaling: { url: "wss://example.com/signal", group: "demo" } });               // Node server
```

A signaling outage does not end live connections: they keep running and renegotiate over the
mesh. Only new pairs and pairs that need a new direct connection wait for the server.

### Reference Servers

The reference servers live in their own repositories. Both also serve the realtic client files
(library and demos) when started, from the installed `realtic` package or a realtic checkout next
to them.

- [realtic-server-php](https://github.com/daniel-x/realtic-server-php): `signal.php` with SQLite
  and repeated polling, for plain PHP hosting (PHP 8.0 with `pdo_sqlite`). Its README lists the
  deployment steps and settings.
- [realtic-server-node](https://github.com/daniel-x/realtic-server-node): a WebSocket server
  (`npx realtic-server-node 8080`), for hosts that run a Node process.

### Forwarded Logs

`forwardLog` (`realtic/log-forward`) sends a page's log entries to `log.php` of the PHP server or
to `/log` of the Node server (started with `--log-dir`). The server appends the entries of all peers of a group to one file,
`<dir>/<group>.log`, in arrival order, so both ends of a problem are in one place:

```
2026-10-13_14-02-07.481233 2026-10-13_14-02-07.480912 Ab12x #57 INFO  [direct] peer=Cd34y s=9f1c state connected -> slow {"reason":"no data for 1500 ms"}
```

The first time is when the server received the entry, the second the client's time of the entry
(both UTC, microseconds), then the client id and the entry's `seq`. Client clocks differ, so the
receive time gives the order across peers and the client time the order within one peer.
Browsers round their clock to 100 µs (Chromium) or 1 ms (Firefox) unless the page is
cross-origin isolated. The files contain the addresses and ids of every peer: keep the directory
out of reach of HTTP.

### A Server of Your Own

Any transport works (a message broker, Firebase). Rules:

- Deliver each message at most once and delete what was delivered. realtic drops duplicates by
  message id, so redelivery is safe, but stale offers cost time.
- Accept a `navigator.sendBeacon` POST if `bye` on `pagehide` should reach the others when the
  page closes.

## TURN over TLS on Port 443

Peer relays carry traffic for pairs that cannot connect directly, so TURN is needed only when no
peer of the group can reach both ends. When it is needed, port 443 with TLS passes most firewalls:

```js
const group = new RalPeerGroup({
  signaling,
  iceServers: [
    { urls: "stun:stun.example.com:3478" },
    { urls: "turns:turn.example.com:443?transport=tcp", username, credential },
  ],
  config: { turnMode: "fallback" },
});
```

`config.turnMode`:

- `"fallback"` (default): direct connections start without TURN. TURN servers are added with an
  ICE restart only when the direct attempt failed and no peer relay route exists.
- `"always"`: TURN from the start.
- `"relay-only"`: `iceTransportPolicy: "relay"`, for privacy (no host or reflexive addresses).

A coturn configuration for TLS on 443:

```
listening-port=3478
tls-listening-port=443
fingerprint
use-auth-secret
static-auth-secret=<shared secret>
realm=turn.example.com
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-multicast-peers
no-cli
```

Issue time-limited credentials from your backend (TURN REST API: username `<expiry>:<user>`,
credential `base64(hmac-sha1(secret, username))`).

## Relaying Peers

Every peer relays for other members by default. A peer on a metered connection opts out with
`config.relay = false`. `config.mediaRelay = "never"` keeps a peer's media from being re-encoded
by a relay (relayed media is readable by the relay; relayed data is end to end encrypted).
`config.allowRelay(origin, target)` narrows which pairs a peer relays for.

## Group Size

Tested up to 8 peers with media and data and 16 peers data only. A full video mesh costs every
peer one upload per receiver; at 8 peers the per-flow budgets lower each video's bitrate, and
subscriptions (`group.setSubscription`) cut what is not shown.
