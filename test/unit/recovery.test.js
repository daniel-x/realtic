import { test } from "node:test";
import assert from "node:assert/strict";
import { RecoverySchedule } from "../../src/link/ice-restart.js";
import { RalFakeClock } from "../../src/util/clock.js";

const flush = () => new Promise((r) => setImmediate(r));

async function drive(clock, ms, step = 100) {
  for (let t = 0; t < ms; t += step) {
    clock.advance(step);
    await flush();
  }
}

test("restarts with backoff, rebuild, then unreachable and re-probe", async () => {
  const clock = new RalFakeClock();
  const acts = [];
  const s = new RecoverySchedule({
    clock, backoffMs: [1000, 3000, 6000], rebuildAttempts: 1, stepTimeoutMs: 2000, reprobeMs: [30000, 60000],
    healthy: () => false, act: (a) => acts.push([a.kind, clock.now()]),
  });
  const p = s.run();
  await drive(clock, 20000);
  assert.equal(await p, "unreachable");
  assert.deepEqual(acts, [["restart", 1000], ["restart", 6000], ["restart", 14000], ["rebuild", 16000]]);
  await drive(clock, 30000);
  assert.deepEqual(acts.at(-1), ["rebuild", 48000]);
});

test("recovers when health is reported", async () => {
  const clock = new RalFakeClock();
  const acts = [];
  const s = new RecoverySchedule({
    clock, backoffMs: [1000, 3000], rebuildAttempts: 1, stepTimeoutMs: 2000, reprobeMs: [30000],
    healthy: () => false, act: (a) => acts.push(a.kind),
  });
  const p = s.run();
  await drive(clock, 1500);
  s.noteHealthy();
  assert.equal(await p, "recovered");
  assert.deepEqual(acts, ["restart"]);
});
