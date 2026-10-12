import { test } from "node:test";
import assert from "node:assert/strict";
import { HopChannels, modeKey } from "../../src/transport/hop-channels.js";

/** Peer connection stub whose data channels open at once and record what is sent. */
function fakePc() {
  const channels = [];
  return {
    channels,
    createDataChannel(label, init) {
      const dc = { label, ...init, readyState: "open", bufferedAmount: 0, sent: [], send(d) { this.sent.push(d); }, close() {} };
      channels.push(dc);
      return dc;
    },
  };
}

const options = { highWater: 1 << 20, lowWater: 1 << 18, flowLimit: 1 << 20 };
const ctlMessages = (pc) => pc.channels.find((c) => c.label === "ctl").sent.map((d) => JSON.parse(d));

test("a new partial transport holds envelopes until the polite side confirms it", () => {
  const pc = fakePc();
  const hop = new HopChannels(pc, { impolite: true, ...options });
  const key = modeKey({ ordered: false, maxPacketLifeTime: 150 });
  hop.sendEnvelope(key, "f", new Uint8Array([1, 2, 3]));
  const dc = pc.channels.find((c) => c.label === key);
  const open = ctlMessages(pc).find((m) => m.t === "transport-open");
  assert.equal(open.id, dc.id);
  assert.equal(dc.sent.length, 0, "nothing sent before transport-ready");
  assert.equal(hop.handleCtl({ t: "transport-ready", id: open.id, mode: open.mode }), true);
  assert.equal(dc.sent.length, 1);
});

test("the polite side creates its end on transport-open and confirms it", () => {
  const pc = fakePc();
  const hop = new HopChannels(pc, { impolite: false, ...options });
  const mode = { ordered: false, maxRetransmits: 8 };
  assert.equal(hop.handleCtl({ t: "transport-open", id: 3, mode }), true);
  const dc = pc.channels.find((c) => c.label === modeKey(mode));
  assert.equal(dc.id, 3);
  assert.deepEqual(ctlMessages(pc).find((m) => m.t === "transport-ready"), { t: "transport-ready", id: 3, mode });
  hop.sendEnvelope(modeKey(mode), "f", new Uint8Array([9]));
  assert.equal(dc.sent.length, 1, "the polite side sends at once, the impolite end exists");
});
