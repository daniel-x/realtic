# M0 Feasibility Report

Environment: Playwright 1.64 on Linux, HeadlessChrome 156 and Firefox 157, fake media devices.
Spikes: `test/spikes/m0.js` (in-page) and the integration harness (`test/integration`).
Safari, iOS and real phones are not available in this environment; their items stay on the
manual test matrix (plan section 14.7).

| Item | Chromium | Firefox | Consequence for the plan |
| ---- | -------- | ------- | ------------------------ |
| Re-sending a remote track via `addTrack`/`addTransceiver` on another connection | works, frames decoded at the far end | works | re-encode relay path (section 10.2) as planned |
| `encodings[].active = false` on a sender whose track is remote | no bytes sent while inactive, frames again 51 ms after `active = true` | no bytes, 21 ms | standby media slots (section 7.2a) as planned |
| `availableOutgoingBitrate` on the selected pair | present | absent | Firefox uses the fallback of section 17: budgets only when `remote-inbound-rtp` shows loss, derived from the measured send rate |
| `sctp.maxMessageSize` | 262144 | 1073741823 | fragments are limited to `min(maxMessageSize, maxFragmentBytes = 64 KiB)` |
| Negotiated data channels | open | open | as planned |
| `lastPacketReceivedTimestamp` on `inbound-rtp` and on the candidate pair | present | present | liveness reads the timestamp; the byte counter fallback stays for other browsers |
| `RTCRtpScriptTransform` | present | present | encoded forwarding (M5) is possible in principle |
| `createEncodedStreams` | present | absent | |
| `MediaStreamTrackGenerator` / `VideoTrackGenerator` | first only | neither | `stableTracks` is Chromium-only; the stable stream works everywhere |
| Adding and removing tracks of a playing `<video>`'s `srcObject` | keeps playing | keeps playing | stable streams as planned; Safari manual |
| Netem proxy with candidate rewriting | works | works after binding the proxy socket on the candidate's own interface address (Firefox does not pair a non-loopback local candidate with a loopback remote one) | harness binds per real address |
| Packet class filter (STUN passes, DTLS dropped) | ICE connects, data channel never opens | same | DIR-6 as planned |
| Consent statistics of a frozen hidden tab (`Page.setWebLifecycleState frozen`) | candidate pair timestamp keeps advancing, link judged alive for 15 s | not testable (no CDP) | background mode as planned |
| Network Information API | present | absent | srflx probe everywhere, `change` event where present |
| TURN allocations through `turn-server` | see REL-13 | see REL-13 | |

Not verified here (manual matrix): Safari `srcObject` track swap, iOS background suspension,
Android local network permission, real WiFi/cellular handover with the srflx probe.
