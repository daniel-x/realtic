import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../../src/channel/session.js";
import { makeConfig } from "../../src/config.js";
import { RalFakeClock } from "../../src/util/clock.js";
import { RalLog } from "../../src/diag/log.js";

function wire({ drop = () => false } = {}) {
  const clock = new RalFakeClock();
  const config = makeConfig();
  const log = new RalLog({ clock }).scope("channel");
  const queue = [];
  let up = true;
  const mk = (impolite, name) =>
    new Session({ impolite, config, clock, log, transmit: (e, key) => (up && !drop(e, key) && queue.push([name, e]), true) });
  const a = mk(true, "a");
  const b = mk(false, "b");
  const flush = async () => {
    for (let i = 0; i < 100 && queue.length; i++) {
      while (queue.length) {
        const [from, e] = queue.shift();
        (from === "a" ? b : a).receive(e, e.payload);
      }
      await new Promise((r) => setImmediate(r));
    }
  };
  return { a, b, clock, flush, setUp: (v) => (up = v) };
}

test("channel open handshake and messages both ways", async () => {
  const w = wire();
  const remote = [];
  w.b.on("channel", (ch) => remote.push(ch));
  const ch = w.a.createChannel("chat");
  assert.equal(ch.readyState, "connecting");
  assert.throws(() => ch.send("x"), (e) => e.name === "InvalidStateError");
  await w.flush();
  assert.equal(ch.readyState, "open");
  assert.equal(remote[0].label, "chat");
  assert.equal(remote[0].readyState, "open");
  const got = [];
  remote[0].onmessage = (e) => got.push(e.data);
  ch.send("hello");
  ch.send(new Uint8Array([1, 2, 3]));
  await w.flush();
  assert.equal(got[0], "hello");
  assert.deepEqual([...new Uint8Array(got[1])], [1, 2, 3]);
});

test("simultaneous creation does not collide", async () => {
  const w = wire();
  const ca = w.a.createChannel("x");
  const cb = w.b.createChannel("y", { ordered: false, maxRetransmits: 2 });
  assert.notEqual(ca.id, cb.id);
  assert.equal(ca.id % 2, 0);
  assert.equal(cb.id % 2, 1);
  await w.flush();
  assert.equal(ca.readyState, "open");
  assert.equal(cb.readyState, "open");
});

test("outage: messages are delivered after routeChanged, once and in order", async () => {
  const w = wire();
  let remote;
  w.b.on("channel", (ch) => (remote = ch));
  const ch = w.a.createChannel("r");
  await w.flush();
  const got = [];
  remote.onmessage = (e) => got.push(e.data);
  w.setUp(false);
  for (let i = 0; i < 20; i++) ch.send(String(i));
  w.setUp(true);
  w.a.routeChanged();
  w.a.routeChanged();
  await w.flush();
  assert.deepEqual(got, Array.from({ length: 20 }, (_, i) => String(i)));
});

test("close fires on both sides after data is delivered", async () => {
  const w = wire();
  let remote;
  w.b.on("channel", (ch) => (remote = ch));
  const ch = w.a.createChannel("c");
  await w.flush();
  const got = [];
  remote.onmessage = (e) => got.push(e.data);
  let closedA = false;
  let closedB = false;
  ch.onclose = () => (closedA = true);
  remote.onclose = () => (closedB = true);
  ch.send("last");
  ch.close();
  await w.flush();
  w.clock.advance(200);
  await w.flush();
  w.clock.advance(100);
  await w.flush();
  assert.deepEqual(got, ["last"]);
  assert.ok(closedA && closedB);
});
