# Deploying realtic

## Secure Context

`getUserMedia` and WebRTC need a secure context: HTTPS, or `http://localhost` during development.
A phone on the local network needs a real certificate or a tunnel.

## Signaling

realtic talks to a signaling server through an adapter (`{ send, onmessage, onpresence, close }`).
`RealticGroup` takes either an adapter or the settings of a reference server:

```js
new RealticGroup({ signaling: { url: "https://example.com/realtic/signal.php", group: "demo" } }); // PHP server
new RealticGroup({ signaling: { url: "wss://example.com/signal", group: "demo" } });               // Node server
```

A signaling outage does not end live connections: they keep running and renegotiate over the
mesh. Only new pairs and pairs that need a new direct link wait for the server.

### PHP Server (`server/php`)

Requirements: PHP 8.0 or newer with `pdo_sqlite` (SQLite 3.24 or newer), which most shared hosts have.

1. Copy `server/php/signal.php` and `server/php/data/` (with its `.htaccess`) to the web space.
2. Optional: copy `config.example.php` to `config.php` next to `signal.php` and adjust it.
3. Make `data/` writable for PHP. Keep the database out of reach of HTTP: the `.htaccess` covers
   Apache; on nginx deny the directory (`location ~ /data/ { deny all; }`), or set `db` to a path
   outside the document root.

Each client sends one POST per poll: every `poll_fast_ms` (250) for 5 s after a message, every
`poll_idle_ms` (3000) otherwise. The server sends both values to the clients. After the mesh is
up most signaling runs over the peers, so a connected group costs one request per client every
3 s. Every request is short, so the server needs no long-lived connections. Other settings:

| Key | Default | Meaning |
| --- | ------- | ------- |
| `db` | `data/realtic.sqlite` | SQLite file |
| `journal_mode` | `WAL` | use `DELETE` on network file systems, where WAL does not work |
| `member_timeout_s` | 30 | a client that stops polling leaves the group after this |
| `message_ttl_s` | 30 | undelivered messages expire |
| `max_group_members` | 64 | |
| `max_body_bytes`, `max_messages`, `max_message_bytes` | 262144, 64, 65536 | request limits |
| `allowed_origins` | `[]` | CORS origins for use from another site, or `['*']` |
| `log_file` | none | request log: one UTC line per request that carried messages or changed membership |
| `log_polls` | false | log idle polls too |
| `log_max_bytes`, `log_files` | 1048576, 5 | log rotation by size |

Messages are delivered at most once: a request returns its client's pending messages and deletes
exactly those rows in the same `BEGIN IMMEDIATE` transaction.

`server/php/router.php` runs everything on PHP's built-in server for development
(`php -S localhost:8080 server/php/router.php`); it is not meant for production.

### Node Server (`server/node`)

`node server/node/server.js [port]` runs a WebSocket server with groups, presence and a
`sendBeacon` endpoint (`<url>/beacon?id=&group=`, body `{ to, msg }`). It also serves the demos.
Put it behind a TLS reverse proxy for `wss://`.

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
const group = new RealticGroup({
  signaling,
  iceServers: [
    { urls: "stun:stun.example.com:3478" },
    { urls: "turns:turn.example.com:443?transport=tcp", username, credential },
  ],
  config: { turnMode: "fallback" },
});
```

`config.turnMode`:

- `"fallback"` (default): links start without TURN. TURN servers are added with an ICE restart
  only when the direct attempt failed and no peer relay route exists.
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
