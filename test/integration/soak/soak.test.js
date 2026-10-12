// Soak and chaos run (plan section 14.6): 8 peers with media and data channels, random faults
// from a seeded generator. REALTIC_SOAK_MS sets the duration (default 10 min), REALTIC_SEED the
// seed (printed, so a failure can be replayed), REALTIC_PAIRINGS the browser mix.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { withScenario, sleep, waitFor, PAIRINGS, pairings, closeBrowsers, openChannel, messages, sendMany, assertSequence, FAST_RECOVERY } from "../common.js";

after(() => closeBrowsers());

/** Mulberry32 PRNG. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DURATION = Number(process.env.REALTIC_SOAK_MS ?? 600000);
const SEED = Number(process.env.REALTIC_SEED ?? Date.now() % 1000000);
const N = Number(process.env.REALTIC_SOAK_PEERS ?? 8);

for (const pairing of pairings()) {
  test(`soak ${pairing}: ${N} peers, ${Math.round(DURATION / 1000)} s, seed ${SEED}`, { timeout: DURATION + 300000 }, async () => {
    console.log(`    soak ${pairing}: seed ${SEED}`);
    const rand = prng(SEED);
    const pick = (n) => Math.floor(rand() * n);
    await withScenario(`soak-${pairing}-${SEED}`, { browsers: PAIRINGS[pairing].slice(0, N), config: { ...FAST_RECOVERY, linkStateIntervalMs: 1000 } }, async (s) => {
      for (let i = 0; i < N; i++) await s.eval(i, () => window.t.publishCounter("camera"));
      await s.meshAll();
      await s.waitAllConnected(90000);
      const pairs = [];
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        await openChannel(s, i, j, "soak");
        pairs.push([i, j]);
      }
      const sent = pairs.map(() => 0);
      const end = Date.now() + DURATION;
      const faults = [];
      while (Date.now() < end) {
        const kind = ["block", "block", "loss", "freeze", "rebind", "oneway"][pick(6)];
        const a = pick(N);
        let b = pick(N - 1);
        if (b >= a) b++;
        const ms = 1000 + pick(8000);
        faults.push(`${kind} ${a}-${b} ${ms} ms`);
        if (kind === "block") s.block(a, b);
        if (kind === "oneway") s.rule(s.id(a), s.id(b), { down: true });
        if (kind === "loss") {
          s.rule(s.id(a), s.id(b), { loss: 0.2 });
          s.rule(s.id(b), s.id(a), { loss: 0.2 });
        }
        if (kind === "rebind") await s.proxy.rebind(s.id(a));
        const freeze = kind === "freeze" ? s.eval(a, (t) => window.t.hook.busy(t), Math.min(ms, 6000)).catch(() => {}) : null;
        for (let k = 0; k < pairs.length; k++) {
          const [p, q] = pairs[k];
          const r = await sendMany(s, p, q, "soak", "s", 10, sent[k]).catch(() => ({ sent: 0 }));
          sent[k] += r.sent;
        }
        await sleep(ms);
        if (kind === "block") s.block(a, b, false);
        if (kind === "oneway") s.rule(s.id(a), s.id(b), { down: false });
        if (kind === "loss") {
          s.rule(s.id(a), s.id(b), { loss: 0 });
          s.rule(s.id(b), s.id(a), { loss: 0 });
        }
        await freeze;
        await sleep(500 + pick(2000));
      }
      console.log(`    soak ${pairing}: ${faults.length} faults`);
      await s.waitAllConnected(90000);
      for (let k = 0; k < pairs.length; k++) {
        const [p, q] = pairs[k];
        await waitFor(async () => (await messages(s, q, p, "soak")).length >= sent[k], 60000, `soak messages ${p}->${q}`);
        assertSequence(assert, await messages(s, q, p, "soak"), "s", sent[k]);
      }
      for (let i = 0; i < N; i++) {
        assert.deepEqual(await s.eval(i, () => window.t.errors), [], `no unhandled errors at ${s.id(i)}`);
        const logSize = await s.eval(i, () => window.t.log().length);
        assert.ok(logSize <= 1024, "log bounded");
        const queued = await s.eval(i, () => Object.values(window.t.stats().links).reduce((n, l) => n + l.bufferedAmount, 0));
        assert.ok(queued < 8 * 1024 * 1024, `transport buffers bounded: ${queued}`);
      }
    });
  });
}
