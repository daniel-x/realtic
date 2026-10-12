# realtic Wire Protocol

Protocol version 1.0. This document is the reference for everything realtic sends. Section
numbers in parentheses refer to the implementation plan.

## 1. Signaling

Signaling messages are JSON objects. The adapter carries them between peers; the library also
routes them over the mesh (section 3 below).

```json
{ "t": "offer", "from": "A1", "to": "B2", "s": "8c1f2a90", "rs": "77d01b3e", "id": "4f0c6d2e9a1b", "sdp": "..." }
```

| Field  | Meaning |
| ------ | ------- |
| `t`    | type: `hello`, `offer`, `answer`, `cand`, `renegotiate`, `bye` |
| `from`, `to` | peer ids |
| `s`    | sender's connection session id (8 hex characters), absent on `hello` and `bye` |
| `rs`   | the receiver's session id as the sender knows it, absent before the first answer |
| `id`   | unique message id; receivers drop duplicates |

Types:

- `hello { ack, proto: { major, minor, features }, key, caps, relay, mediaRelay, media }`: `key` is the
  ECDH P-256 public key as JWK, `caps` the codec lists, decode probes and feature flags. Sent when
  the app adds the peer and repeated every 3 s until the remote `hello` arrives; a `hello` without
  `ack` is answered with `ack: true`. Always sent through the server.
- `offer { sdp, reason, grants? }`: only the impolite side (greater peer id) sends offers.
  `grants: [{ req, mid }]` assigns transceivers to the polite side's `slot-request`s.
- `answer { sdp }`.
- `cand { c: [RTCIceCandidateInit] }`: a batch collected for 50 ms, deduplicated.
- `renegotiate { reason, iceRestart?, rebuild? }`: the polite side asks for an offer, an ICE
  restart, or a new connection.
- `bye { reason }`: the peer leaves.

Session ids: a message whose `s` is unknown and not retired means the other side built a new
connection; a side whose connection already has a remote description rebuilds too. Messages from
retired sessions, and messages whose `rs` names a retired local session, are dropped.

## 1a. Reference Server Transports

PHP server (`signal.php`), one POST per poll, body sent as `text/plain`:

```
POST signal.php?group=<group>&id=<id>
{ "send": [{ "to": "B2", "msg": { ... } }], "leave": false }
-> { "messages": [{ "from": "B2", "msg": { ... } }], "members": ["A1", "B2"], "fastMs": 250, "idleMs": 3000 }
```

Presence is the difference between consecutive `members` lists. `leave: true` removes the client;
`navigator.sendBeacon` uses the same request. After a leave the server answers polls of the same
id with 410 for `member_timeout_s`, so a poll still in flight cannot add the client back.

Node server: WebSocket `ws(s)://host/signal?id=&group=`. Client frames `{ to, msg }`, server frames
`{ from, msg }` and `{ presence: "join" | "leave", peer }`; beacons POST `{ to, msg }` to
`/beacon?id=&group=`.

Group names and client ids match `[A-Za-z0-9_.-]{1,64}`.

## 2. Per-hop Control Channel `ctl`

Each connection has negotiated data channels created by the impolite side: `ctl` (id 0, reliable
ordered), `rel` (id 1, reliable ordered), `unrel` (id 2, unordered, `maxRetransmits: 0`), and
partial reliability channels from id 3 on demand.

On `ctl`, the heartbeat beat is the 1 byte binary message `0x00`. Every other message is UTF-8
JSON `{ t, ...fields }`:

| `t` | Fields | Meaning |
| --- | ------ | ------- |
| `index-map` | `map: { [idx]: peerId }, full?` | indices the sender uses in envelope headers; 0 is the sender, 1 the receiver |
| `link-state` | `links: [{ peer, state, rtt, bitrate, loss, candidateType, mms }], load, relay, mediaRelay, ts, echo?: { ts, held }` | the sender's link table, every 2 s and on change; `echo` returns the last received `ts` and how long it was held, for a round trip time |
| `liveness` | `state` | the sender's verdict about this link (`ok`, `slow`, `stale`) |
| `relay-request` | `flow, origin, target, role, kinds` | route owner asks a neighbor to relay |
| `relay-accept` | `flow` | |
| `relay-reject` | `flow, reason` | |
| `relay-open` | `flow, origin, role, kinds` | relay tells the target end about a flow |
| `relay-close` | `flow, origin` | either end or the relay ends a flow |
| `standby-activate` | `flow, origin` | the standby becomes the active relay |
| `route-down` | `origin, target` | relay: the hop to `origin` is dead |
| `route-slow` | `origin, target` | relay: the hop to `origin` is slow |
| `route-use` | `kind: "direct"` | the route owner switched the pair to the direct link |
| `bg`, `fg` | none | the sender's page went to the background or came back |
| `transport-open` | `id, mode` | impolite side created a partial reliability transport |
| `transport-ready` | `id, mode` | polite side created its end; the impolite side starts sending on it |
| `open-transport` | `mode` | polite side asks for one |
| `slot-request` | `req, kind` | polite side asks for a send transceiver |
| `mid-map` | `mids: { [mid]: { origin, pub, tag, kind } }` | what the sender's transceivers carry |
| `subscription` | `origin, audio, video, tags` | which media of `origin` the sender wants |
| `bwe` | `flows: [{ origin, pub, bps }], decode` | relay reports per-flow budgets to the origin |
| `sig` | `msg` | a signaling message of section 1 sent over the mesh |

## 3. Mesh Signaling Rules

- `hello` always goes through the server: it carries the end to end key.
- `offer` and `answer` go over the direct link they renegotiate when its `ctl` is open, else
  through the server. They never pass a relay, because they carry DTLS fingerprints.
- `cand`, `renegotiate`, `bye` go over the direct link, else through a relay neighbor that has a
  live link to the target, else through the server.
- While a direct link is open but not healthy, messages also go through the server.
- A relay forwards a `sig` only when `msg.from` is the neighbor it came from, the type is
  relayable, and both ends completed `hello` with the relay.

## 4. Envelopes

Envelopes travel on `rel`, `unrel` and the partial reliability channels. Binary, big-endian:

| Field | Size | Meaning |
| ----- | ---- | ------- |
| `version` | u8 | protocol major version |
| `type` | u8 | 0 data, 1 ack, 2 credit, 3 beat, 4 control |
| `flags` | u8 | bit 0 encrypted, bit 1 fragmented, bit 2 lifetime present |
| `srcIdx` | u8 | origin, in the sending link's index table |
| `dstIdx` | u8 | destination, same table |
| `channelId` | u16 | end to end channel; 0 is the end to end control channel |
| `seq` | u32 | per channel sequence number, serial arithmetic (RFC 1982) |
| `fragIndex` | u16 | with bit 1 |
| `fragCount` | u16 | with bit 1 |
| `lifetime` | u16 | remaining milliseconds, with bit 2 |

Base header 11 bytes. Payloads:

- data: user message = 1 kind byte (0 binary, 1 UTF-8 text) + bytes; on channel 0 a UTF-8 JSON
  control message.
- ack: u32 cumulative sequence number received in full.
- credit: u32 cumulative byte limit (mod 2^32) the receiver allows; the sender may start with
  262144 bytes before the first grant.
- beat: empty, channel 0, seq 0.

Relayed envelopes are encrypted end to end: AES-GCM-256 with a key derived by ECDH P-256 and
HKDF-SHA-256 (salt `realtic-e2e-v1 NUL <sorted ids joined by NUL>`), payload
`iv (12) | ciphertext | tag (16)`, additional data `version u8, type u8, channelId u16, seq u32,
fragIndex u16, fragCount u16` (zeros when not fragmented). Each fragment is encrypted on its own.
Direct envelopes are not encrypted again (DTLS covers them); a receiver drops relayed envelopes
without the encrypted flag and direct envelopes with it.

End to end control messages on channel 0:

| `t` | Fields |
| --- | ------ |
| `ch-open` | `id, label, protocol, ordered, maxRetransmits, maxPacketLifeTime` |
| `ch-ack` | `id` |
| `ch-close` | `id` |
| `bg`, `fg` | none (relayed routes) |
| `media` | `kinds`: media kinds the sender publishes to the receiver |
| `log-request` | `id` |
| `log-response` | `id, part, parts, data` or `id, refused: true` |

Channel ids: the impolite side allocates even ids from 2, the polite side odd ids from 1.

## 5. Relaying

A relay C forwards an envelope from neighbor A to B only when A is the envelope's origin and C
accepted a flow between A and B. It rewrites `srcIdx` to its own index for A on the link to B and
`dstIdx` to 1, and lowers `lifetime` by half the incoming hop's round trip time, dropping the
envelope when nothing is left.

Partial reliability: `maxRetransmits` applies per hop (each hop uses a transport with the same
mode); `maxPacketLifeTime` applies end to end through the `lifetime` field.
