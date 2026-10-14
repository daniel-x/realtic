import { test } from "node:test";
import assert from "node:assert/strict";
import { SleepWatcher, sleepReaction } from "../../src/liveness/sleep.js";

function watcher() {
  const clock = { mono: 0, wall: 1_000_000, now: () => clock.mono, wallNow: () => clock.wall, setInterval: () => 1, clearInterval: () => {} };
  const reports = [];
  const w = new SleepWatcher({ clock, intervalMs: 1000, minSleepMs: 1000, onresume: (s) => reports.push(s) });
  w.start();
  const tick = (mono, wall) => {
    clock.mono += mono;
    clock.wall += wall;
    w.tick();
  };
  return { tick, reports };
}

test("an on-time or slightly late tick is no sleep", () => {
  const { tick, reports } = watcher();
  tick(1000, 1000);
  tick(1900, 1900);
  assert.deepEqual(reports, []);
});

test("a sleep that paused the monotonic clock: the wall clock gives its length", () => {
  const { tick, reports } = watcher();
  tick(1000, 61000);
  assert.deepEqual(reports, [{ sleepMs: 60000, unobservedMs: 60000 }]);
});

test("a sleep with the monotonic clock running", () => {
  const { tick, reports } = watcher();
  tick(11000, 11000);
  assert.deepEqual(reports, [{ sleepMs: 10000, unobservedMs: 0 }]);
});

test("a backward wall-clock step is no sleep", () => {
  const { tick, reports } = watcher();
  tick(1000, -3600000);
  assert.deepEqual(reports, []);
});

const config = { STALE_CONNECTION_MS: 5000, sleepRebuildMs: 30000 };

test("sleepReaction: check, restart or rebuild by the length of the sleep", () => {
  const suspended = (sleepMs) => ({ sleepMs, unobservedMs: sleepMs, silenceMs: 0, unreachable: false });
  assert.equal(sleepReaction(suspended(2000), config), "check");
  assert.equal(sleepReaction(suspended(10000), config), "restart");
  assert.equal(sleepReaction(suspended(40000), config), "rebuild");
  assert.equal(sleepReaction({ sleepMs: 40000, unobservedMs: 0, silenceMs: 40000, unreachable: false }, config), "rebuild");
});

test("sleepReaction: a late timer while data kept arriving only checks", () => {
  assert.equal(sleepReaction({ sleepMs: 59000, unobservedMs: 0, silenceMs: 200, unreachable: false }, config), "check");
});

test("sleepReaction: an unreachable connection is rebuilt after any sleep", () => {
  assert.equal(sleepReaction({ sleepMs: 1500, unobservedMs: 0, silenceMs: 200, unreachable: true }, config), "rebuild");
});
