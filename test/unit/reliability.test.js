import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelSender, ChannelReceiver, INITIAL_CREDIT } from "../../src/channel/reliability.js";
import { FakeClock } from "../../src/util/clock.js";

function pair(mode, { lossy = () => false, window = 1 << 20, bufferLimit } = {}) {
  const clock = new FakeClock();
  const delivered = [];
  let up = true;
  const wire = [];
  const receiver = new ChannelReceiver({
    mode, clock, window,
    deliver: (p) => delivered.push(p[0] | (p[1] << 8)),
    sendAck: (seq) => sender.onAck(seq),
    sendCredit: (limit) => sender.onCredit(limit),
  });
  const sender = new ChannelSender({
    mode, clock, bufferLimit,
    transmit: (m) => {
      if (!up) return true;
      if (!lossy(m.seq)) wire.push(m);
      return true;
    },
  });
  const flush = () => { while (wire.length) { const m = wire.shift(); receiver.receive(m.seq, m.payload); } };
  const msg = (i, size = 2) => { const p = new Uint8Array(size); p[0] = i & 255; p[1] = i >> 8; return p; };
  return { clock, sender, receiver, delivered, flush, msg, wire, setUp: (v) => (up = v) };
}

test("reliable ordered: loss is repaired by retransmit timeout, order kept", () => {
  const dropped = new Set([3, 5]);
  const p = pair({ ordered: true }, { lossy: (seq) => dropped.delete(seq) });
  for (let i = 1; i <= 10; i++) p.sender.send(p.msg(i));
  p.flush();
  assert.deepEqual(p.delivered, [1, 2]);
  p.clock.advance(200);
  p.clock.advance(3000);
  p.flush();
  assert.deepEqual(p.delivered, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  p.clock.advance(200);
  assert.equal(p.sender.unackedCount, 0);
});

test("reliable: retransmitAll after outage delivers each message once", () => {
  const p = pair({ ordered: true });
  p.setUp(false);
  for (let i = 1; i <= 5; i++) p.sender.send(p.msg(i));
  p.setUp(true);
  p.sender.retransmitAll();
  p.sender.retransmitAll();
  p.flush();
  assert.deepEqual(p.delivered, [1, 2, 3, 4, 5]);
});

test("reliable unordered delivers at once and dedupes", () => {
  const p = pair({ ordered: false });
  p.receiver.receive(2, p.msg(2));
  p.receiver.receive(1, p.msg(1));
  p.receiver.receive(2, p.msg(2));
  assert.deepEqual(p.delivered, [2, 1]);
  assert.equal(p.receiver.cumulative, 2);
});

test("unreliable ordered skips gaps and drops late messages", () => {
  const p = pair({ ordered: true, maxRetransmits: 0 });
  for (const s of [1, 3, 2, 4, 4]) p.receiver.receive(s, p.msg(s));
  assert.deepEqual(p.delivered, [1, 3, 4]);
});

test("unreliable unordered dedupes", () => {
  const p = pair({ ordered: false, maxRetransmits: 0 });
  for (const s of [1, 3, 2, 3, 1]) p.receiver.receive(s, p.msg(s));
  assert.deepEqual(p.delivered, [1, 3, 2]);
});

test("outage buffer overflow throws OperationError", () => {
  const p = pair({ ordered: true }, { bufferLimit: 10 });
  p.setUp(false);
  p.sender.send(p.msg(1, 6));
  assert.throws(() => p.sender.send(p.msg(2, 6)), (e) => e.name === "OperationError");
});

test("credit limits bytes in flight", () => {
  const clock = new FakeClock();
  const sent = [];
  const s = new ChannelSender({ mode: { ordered: true }, clock, transmit: (m) => (sent.push(m.seq), true) });
  const size = INITIAL_CREDIT / 4;
  for (let i = 0; i < 8; i++) s.send(new Uint8Array(size));
  assert.equal(sent.length, 4);
  s.onCredit(INITIAL_CREDIT + 2 * size);
  assert.equal(sent.length, 6);
});

test("receiver grants credit as it delivers", () => {
  const p = pair({ ordered: true }, { window: 1000 });
  for (let i = 0; i < 2000; i++) p.sender.send(p.msg(i, 100));
  for (let round = 0; round < 50 && p.wire.length; round++) {
    p.flush();
    p.clock.advance(150);
  }
  assert.equal(p.delivered.length, 2000);
});

test("maxPacketLifeTime: expired queued messages are dropped", () => {
  const clock = new FakeClock();
  let open = false;
  const sent = [];
  const s = new ChannelSender({ mode: { ordered: false, maxPacketLifeTime: 100 }, clock, transmit: (m) => (open ? (sent.push(m), true) : false) });
  s.send(new Uint8Array(1));
  clock.advance(50);
  s.send(new Uint8Array(1));
  clock.advance(60);
  open = true;
  s.pump();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].seq, 2);
  assert.equal(sent[0].lifetime, 40);
});
