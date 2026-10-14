// Negotiator: offer numbering, so a late answer to a rolled back offer is not applied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Negotiator } from "../../src/direct/negotiation.js";

/** The signaling state machine of RTCPeerConnection, enough for the Negotiator. */
class FakePeerConnection {
  signalingState = "stable";
  localDescription = null;
  remoteDescription = null;
  applied = [];

  async setLocalDescription(desc) {
    if (desc?.type === "rollback") {
      this.signalingState = "stable";
      this.localDescription = null;
      return;
    }
    const type = this.signalingState === "have-remote-offer" ? "answer" : "offer";
    this.localDescription = { type, sdp: `${type}-sdp` };
    this.signalingState = type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.applied.push(desc.sdp);
    this.signalingState = desc.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate() {}
}

function negotiator(impolite) {
  const pc = new FakePeerConnection();
  const sent = [];
  const logs = [];
  const neg = new Negotiator(pc, { impolite, signal: (m) => sent.push(m), log: (m) => logs.push(m) });
  return { pc, neg, sent, logs };
}

test("offers are numbered and the answer echoes the number", async () => {
  const a = negotiator(true);
  const b = negotiator(false);
  await a.neg.negotiate("start");
  await a.neg.negotiate("again");
  assert.equal(a.sent.length, 1);
  assert.equal(a.sent[0].o, 1);
  await b.neg.handleOffer(a.sent[0]);
  assert.equal(b.sent[0].t, "answer");
  assert.equal(b.sent[0].o, 1);
  await a.neg.handleAnswer(b.sent[0]);
  assert.deepEqual(a.pc.applied, ["answer-sdp"]);
  assert.equal(a.sent.length, 2, "the pending negotiation runs after the answer");
  assert.equal(a.sent[1].o, 2);
});

test("an answer to a rolled back offer is dropped, the answer to the current offer applies", async () => {
  const a = negotiator(true);
  await a.neg.negotiate("ice restart");
  await a.pc.setLocalDescription({ type: "rollback" });
  await a.neg.negotiate("ice restart");
  assert.deepEqual(a.sent.map((m) => m.o), [1, 2]);
  await a.neg.handleAnswer({ t: "answer", sdp: "late", o: 1 });
  assert.equal(a.pc.signalingState, "have-local-offer");
  assert.ok(a.logs.includes("dropped answer to an older offer"));
  await a.neg.handleAnswer({ t: "answer", sdp: "current", o: 2 });
  assert.equal(a.pc.signalingState, "stable");
  assert.deepEqual(a.pc.applied, ["current"]);
});

test("an answer without a number (older peer) still applies", async () => {
  const a = negotiator(true);
  await a.neg.negotiate("start");
  await a.neg.handleAnswer({ t: "answer", sdp: "unnumbered" });
  assert.equal(a.pc.signalingState, "stable");
});
