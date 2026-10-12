# Deploying realtic

## Secure Context

`getUserMedia` and WebRTC need a secure context: HTTPS, or `http://localhost` during development.
A phone on the local network needs a real certificate or a tunnel.

## Signaling

realtic talks to a signaling server through an adapter (`{ send, onmessage, onpresence, close }`).
`examples/server/server.js` is a minimal WebSocket server for the reference adapter
`WebSocketSignaling`; any transport works (HTTP polling, Firebase, a message broker). Rules for a
server of your own:

- Deliver each message at most once and delete what was delivered. realtic drops duplicates by
  message id, so redelivery is safe, but stale offers cost time.
- Expose a POST endpoint for `navigator.sendBeacon` if you want `bye` on `pagehide` to reach the
  others when the page closes (`<url>/beacon?id=&room=`, body `{ to, msg }`).
- A signaling outage does not end live connections: they keep running and renegotiate over the
  mesh. Only new pairs and pairs that need a new direct link wait for the server.

## TURN over TLS on Port 443

Peer relays carry traffic for pairs that cannot connect directly, so TURN is needed only when no
peer of the group can reach both ends. When it is needed, port 443 with TLS passes most firewalls:

```js
const group = new Group({
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
