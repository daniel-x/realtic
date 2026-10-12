import { test } from "node:test";
import assert from "node:assert/strict";
import { LivenessMonitor } from "../../src/liveness/monitor.js";
import { Heartbeat } from "../../src/liveness/heartbeat.js";
import { FakeClock } from "../../src/util/clock.js";

function monitor(clock) {
  const changes = [];
  const m = new LivenessMonitor({ now: () => clock.now(), slowMs: 1000, staleMs: 5000, backgroundSlowMs: 12000, backgroundStaleMs: 20000, onchange: (s) => changes.push([s, clock.now()]) });
  const id = clock.setInterval(() => m.check(), 250);
  return { m, changes, stop: () => clock.clearInterval(id) };
}

test("silence goes slow then stale; data restores ok", () => {
  const clock = new FakeClock();
  const { m, changes } = monitor(clock);
  clock.advance(5000);
  assert.deepEqual(changes, [["slow", 1000], ["stale", 5000]]);
  m.noteData();
  assert.equal(m.state, "ok");
});

test("media arrivals count as liveness", () => {
  const clock = new FakeClock();
  const { m, changes } = monitor(clock);
  for (let t = 0; t < 4000; t += 250) {
    clock.advance(250);
    m.noteMedia(clock.now() - 30);
  }
  assert.deepEqual(changes, []);
});

test("background mode uses consent and longer thresholds", () => {
  const clock = new FakeClock();
  const { m, changes } = monitor(clock);
  m.setBackground(true);
  for (let t = 0; t < 30000; t += 5000) {
    clock.advance(5000);
    m.noteConsent(clock.now());
  }
  assert.deepEqual(changes, []);
  clock.advance(20000);
  assert.deepEqual(changes.map((c) => c[0]), ["slow", "stale"]);
});

test("heartbeat beats only when idle", () => {
  const clock = new FakeClock();
  let beats = 0;
  const hb = new Heartbeat(clock, 500, () => beats++);
  hb.start();
  for (let i = 0; i < 10; i++) {
    clock.advance(100);
    hb.noteSent();
  }
  assert.equal(beats, 0);
  clock.advance(2000);
  assert.ok(beats >= 3 && beats <= 4, String(beats));
});
