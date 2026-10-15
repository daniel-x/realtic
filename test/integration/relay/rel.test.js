// REL scenarios (plan section 14.5). Filter with REALTIC_PAIRINGS and --test-name-pattern.
// REALTIC_MEDIA=0 skips the media assertions (milestone M2 runs data only).
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import {
  withScenario, sleep, waitFor, PAIRINGS, pairings, closeBrowsers, states, openChannel, messages,
  sendMany, assertSequence, logMatches, FAST_RECOVERY, events, testConfig, effective, FAST_TIMINGS,
} from "../common.js";
import { createServer as createTurnServer } from "turn-server";

after(() => closeBrowsers());

const MEDIA = process.env.REALTIC_MEDIA !== "0";

/** Browser lists of a pairing; `relayOther` swaps the relay (index 2) to the other engine. */
function browsersFor(pairing, n, relayOther = false) {
  const list = PAIRINGS[pairing].slice(0, n);
  if (n > 2 && relayOther && pairing !== "mixed") list[2] = pairing === "chromium" ? "firefox" : "chromium";
  if (n > 2 && pairing === "mixed") list[2] = "firefox";
  return list;
}

/** Adds every peer to every other, with the pairs in `blocked` cut at the proxy first. */
async function meshWithBlocks(s, blocked) {
  for (const [a, b] of blocked) s.block(a, b);
  await s.meshAll();
}

async function route(s, p, q) {
  return s.eval(p, (id) => window.t.route(id), typeof q === "number" ? s.id(q) : q);
}

async function waitRoute(s, p, q, kind, via, timeoutMs = 30000) {
  const viaId = typeof via === "number" ? s.id(via) : via;
  return waitFor(async () => {
    const r = await route(s, p, q);
    return r && r.kind === kind && (!viaId || r.via === viaId) && (await s.eval(p, (id) => window.t.state(id), s.id(q))) === "connected" ? r : false;
  }, timeoutMs, `${s.id(p)} routes to ${s.id(q)} via ${kind} ${viaId ?? ""}`);
}

/** A TURN server on a random port shared by UDP and TCP; retries when the port is taken. */
async function startTurnServer() {
  for (let attempt = 0; ; attempt++) {
    const turn = createTurnServer({ allowLoopback: true, auth: { mechanism: "long-term", realm: "realtic.test", credentials: { test: "secret" } }, relay: { ip: "127.0.0.1", externalIp: "127.0.0.1" } });
    const turnPort = 30000 + Math.floor(Math.random() * 20000);
    try {
      await new Promise((resolve, reject) => {
        const up = new Set();
        turn.on("listening", (info) => up.add(info.transport).size === 2 && resolve());
        turn.on("error", reject);
        try {
          turn.listen({ port: turnPort, address: "127.0.0.1" });
        } catch (error) {
          reject(error);
        }
      });
      return { turn, turnPort };
    } catch (error) {
      await Promise.race([new Promise((resolve) => turn.stop(resolve)), sleep(2000)]);
      if (error?.code !== "EADDRINUSE" || attempt >= 4) throw error;
    }
  }
}

/** Polls `count()` until it reaches `target` or, once above 0, stops growing for `quietMs`; at most `timeoutMs`. */
async function untilSettled(count, target, quietMs, timeoutMs) {
  const end = performance.now() + timeoutMs;
  let last = -1;
  let since = performance.now();
  while (performance.now() < end) {
    const n = await count();
    if (n >= target) return;
    if (n !== last) {
      last = n;
      since = performance.now();
    } else if (n > 0 && performance.now() - since >= quietMs) return;
    await sleep(200);
  }
}

/** Starts a steady numbered message stream p -> q, returns a stop function. */
function stream(s, p, q, label, prefix, everyMs = 50) {
  let n = 0;
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      const r = await sendMany(s, p, q, label, prefix, 5, n);
      if (r.error) throw new Error(`send failed: ${r.error}`);
      n += 5;
      await sleep(everyMs);
    }
  })();
  return async () => {
    stopped = true;
    await done;
    return n;
  };
}

const FAST = FAST_TIMINGS ? FAST_RECOVERY : { ...FAST_RECOVERY, directTableIntervalMs: 1000 };
const F = effective(FAST);

for (const pairing of pairings()) {
  for (const relayOther of pairing === "mixed" ? [false] : [false, true]) {
    const tag = relayOther ? `${pairing}-otherrelay` : pairing;
    describe(`relay ${tag}`, { concurrency: false }, () => {
      test("REL-1 A-B blocked: data and media via C; C is relay-only for A's video", async () => {
        await withScenario(`REL-1-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
          if (MEDIA) {
            await s.eval(0, () => window.t.publishCounter("camera"));
            await s.eval(2, (id) => window.t.setSubscription(id, { video: false }), s.id(0));
          }
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay", 2);
          await waitRoute(s, 1, 0, "relay", 2);
          await openChannel(s, 0, 1, "chat");
          await sendMany(s, 0, 1, "chat", "a", 100);
          await sendMany(s, 1, 0, "chat", "b", 100);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 100, 10000, "A -> B");
          await waitFor(async () => (await messages(s, 0, 1, "chat")).length >= 100, 10000, "B -> A");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "a", 100);
          assertSequence(assert, await messages(s, 0, 1, "chat"), "b", 100);
          if (MEDIA) {
            await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, `${s.id(0)}:camera`)) > 20, 20000, "B gets A's video via C");
            const cTracks = await s.eval(2, () => window.t.tracks.map((x) => x.origin));
            assert.ok(!cTracks.includes(s.id(0)), "C's app gets no track event for A's video");
          }
        });
      });

      test("REL-2 hop C-B dies: route-down before the end to end timeout, reconnecting, recovery", async () => {
        await withScenario(`REL-2-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay", 2);
          await openChannel(s, 0, 1, "chat");
          const t0 = Date.now();
          s.block(2, 1);
          await waitFor(async () => (await logMatches(s, 0, /^route-down$/, t0)).length > 0, 10000, "route-down at A");
          const down = (await logMatches(s, 0, /^route-down$/, t0))[0];
          await s.waitState(0, 1, "reconnecting", 10000);
          const e2eStale = (await logMatches(s, 0, /end to end liveness stale/, t0))[0];
          console.log(`    REL-2 ${tag}: route-down after ${down.time - t0} ms, end to end stale ${e2eStale ? e2eStale.time - t0 : "never"}`);
          assert.ok(!e2eStale || down.time <= e2eStale.time, "route-down before the end to end verdict");
          await sendMany(s, 0, 1, "chat", "x", 20);
          s.block(2, 1, false);
          await waitRoute(s, 0, 1, "relay", 2, 40000);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 20, 15000, "buffered messages delivered");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "x", 20);
        });
      });

      test("REL-3 active relay dies: early switch to the warm standby, then a new standby", async () => {
        await withScenario(`REL-3-${tag}`, { browsers: browsersFor(pairing, 5, relayOther), config: FAST }, async (s) => {
          if (MEDIA) await s.eval(0, () => window.t.publishCounter("camera"));
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay");
          await openChannel(s, 0, 1, "chat");
          await waitFor(async () => (await s.eval(0, (id) => window.t.stats().peers[id].flows.filter((f) => f.state === "open").length, s.id(1))) >= 2, 20000, "standby flow");
          if (MEDIA) await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, `${s.id(0)}:camera`)) > 20, 20000, "video");
          const stop = stream(s, 0, 1, "chat", "m");
          await sleep(1000);
          const active = s.index((await route(s, 0, 1)).via);
          const flows = await s.eval(0, (id) => window.t.stats().peers[id].flows, s.id(1));
          const standby = s.index(flows.find((f) => f.state === "open" && f.via !== s.id(active)).via);
          const t0 = Date.now();
          for (let i = 0; i < 5; i++) if (i !== active) s.block(active, i);
          await waitRoute(s, 0, 1, "relay", standby, 10000);
          const switched = (await events(s, 0, t0, "route")).find((e) => e.peer === s.id(1));
          console.log(`    REL-3 ${tag}: switched to standby after ${switched ? switched.time - t0 : "?"} ms`);
          assert.ok(switched && switched.time - t0 < Math.max(2.5 * F.SLOW_CONNECTION_MS, 1000), "early switch at slow");
          await sleep(1500);
          const sent = await stop();
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= sent, 15000, "all messages");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "m", sent);
          assert.equal((await logMatches(s, 0, /new connection/, t0)).filter((e) => e.peer === s.id(1)).length, 0, "no renegotiation of A-B");
          if (MEDIA) {
            const gap = await s.eval(1, ([k, from]) => window.t.maxGap(k, from), [`${s.id(0)}:camera`, t0]);
            console.log(`    REL-3 ${tag}: media gap ${gap} ms`);
            assert.ok(gap < 1500, `media gap ${gap} ms`);
          }
          await waitFor(async () => {
            const f = await s.eval(0, (id) => window.t.stats().peers[id].flows, s.id(1));
            return f.some((x) => x.role === "standby" && x.state === "open" && x.via !== s.id(active) && x.via !== s.id(standby));
          }, 20000, "new standby");
        });
      });

      test("REL-4 standby dies while the active relay is fine: new standby, no impact", async () => {
        await withScenario(`REL-4-${tag}`, { browsers: browsersFor(pairing, 5, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay");
          await openChannel(s, 0, 1, "chat");
          await waitFor(async () => (await s.eval(0, (id) => window.t.stats().peers[id].flows.filter((f) => f.role === "standby" && f.state === "open").length, s.id(1))) >= 1, 20000, "standby flow");
          const r = await route(s, 0, 1);
          const flows = await s.eval(0, (id) => window.t.stats().peers[id].flows, s.id(1));
          const standby = s.index(flows.find((f) => f.state === "open" && f.via !== r.via).via);
          const stop = stream(s, 0, 1, "chat", "m");
          const t0 = Date.now();
          for (let i = 0; i < 5; i++) if (i !== standby) s.block(standby, i);
          await waitFor(async () => {
            const f = await s.eval(0, (id) => window.t.stats().peers[id].flows, s.id(1));
            return f.some((x) => x.role === "standby" && x.state === "open" && x.via !== s.id(standby) && x.via !== r.via);
          }, 20000, "new standby");
          const sent = await stop();
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= sent, 15000, "all messages");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "m", sent);
          assert.deepEqual((await states(s, 0, 1, t0)).map((e) => e.state), [], "no state change");
          assert.equal((await route(s, 0, 1)).via, r.via, "active relay kept");
        });
      });

      test("REL-5 handover relay to direct: make-before-break, no loss, no duplicates", async () => {
        await withScenario(`REL-5-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay", 2);
          await openChannel(s, 0, 1, "chat");
          const stop = stream(s, 0, 1, "chat", "m");
          const stop2 = stream(s, 1, 0, "chat", "n");
          s.block(0, 1, false);
          await waitRoute(s, 0, 1, "direct", null, 40000);
          await waitRoute(s, 1, 0, "direct", null, 10000);
          await sleep(1000);
          const sent = await stop();
          const sent2 = await stop2();
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= sent, 15000, "all messages");
          await waitFor(async () => (await messages(s, 0, 1, "chat")).length >= sent2, 15000, "all messages back");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "m", sent);
          assertSequence(assert, await messages(s, 0, 1, "chat"), "n", sent2);
        });
      });

      test("REL-6 handover direct to relay when the direct path dies", async () => {
        await withScenario(`REL-6-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
          await s.meshAll();
          await waitRoute(s, 0, 1, "direct");
          await openChannel(s, 0, 1, "chat");
          await sleep(FAST_TIMINGS ? 1000 : 2500);
          const stop = stream(s, 0, 1, "chat", "m");
          await sleep(500);
          const t0 = Date.now();
          s.block(0, 1);
          await waitRoute(s, 0, 1, "relay", 2, 20000);
          console.log(`    REL-6 ${tag}: on relay after ${Date.now() - t0} ms`);
          await sleep(1000);
          const sent = await stop();
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= sent, 15000, "all messages");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "m", sent);
        });
      });

      test("REL-7 flapping hop: route changes stay within hysteresis and early switch limits", async () => {
        await withScenario(`REL-7-${tag}`, { browsers: browsersFor(pairing, 4, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          const r = await waitRoute(s, 0, 1, "relay");
          const active = s.index(r.via);
          await openChannel(s, 0, 1, "chat");
          await sleep(F.switchHoldMs);
          const t0 = Date.now();
          const stop = stream(s, 0, 1, "chat", "m", 100);
          for (let i = 0; i < 10; i++) {
            s.block(active, 1, i % 2 === 0);
            await sleep((2 * F.switchHoldMs) / 3);
          }
          s.block(active, 1, false);
          const sent = await stop();
          const changes = (await events(s, 0, t0, "route")).filter((e) => e.peer === s.id(1));
          console.log(`    REL-7 ${tag}: ${changes.length} route changes in ${(20 * F.switchHoldMs) / 3} ms`);
          assert.ok(changes.length <= 6, `route changes ${changes.length}`);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= sent, 20000, "all messages");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "m", sent);
        });
      });

      test("REL-8 relay frozen: end to end heartbeat detects it, switch to the standby", async () => {
        await withScenario(`REL-8-${tag}`, { browsers: browsersFor(pairing, 4, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay");
          await openChannel(s, 0, 1, "chat");
          await waitFor(async () => (await s.eval(0, (id) => window.t.stats().peers[id].flows.filter((f) => f.role === "standby" && f.state === "open").length, s.id(1))) >= 1, 20000, "standby");
          const r = await route(s, 0, 1);
          const active = s.index(r.via);
          const t0 = Date.now();
          const busy = s.eval(active, (d) => window.t.hook.busy(d), 1.6 * F.STALE_CONNECTION_MS);
          await waitFor(async () => {
            const x = await route(s, 0, 1);
            return x?.kind === "relay" && x.via !== r.via;
          }, Math.max(1.2 * F.STALE_CONNECTION_MS, 3000), "switch away from the frozen relay");
          console.log(`    REL-8 ${tag}: switched after ${Date.now() - t0} ms`);
          await busy;
          await sendMany(s, 0, 1, "chat", "f", 20);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 20, 10000, "messages");
        });
      });

      test("REL-9 relay reloads with a new id: routes rebuilt through it", async () => {
        await withScenario(`REL-9-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay", 2);
          const page = s.page(2);
          const oldId = s.id(2);
          await page.reload();
          await page.waitForFunction(() => window.t?.ready);
          const newId = `R${Math.random().toString(36).slice(2, 6)}`;
          await page.exposeFunction("__noop", () => {}).catch(() => {});
          await page.evaluate((o) => window.t.start(o), { id: newId, signaling: s.server.signaling, config: testConfig(FAST), hooks: true });
          s.pages.delete(oldId);
          s.pages.set(newId, page);
          s.ids[2] = newId;
          for (const i of [0, 1]) {
            await s.eval(i, (id) => window.t.addPeer(id), newId);
            await s.eval(2, (id) => window.t.addPeer(id), s.id(i));
          }
          await waitRoute(s, 0, 1, "relay", 2, 40000);
          await openChannel(s, 0, 1, "chat");
          await sendMany(s, 0, 1, "chat", "r", 10);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 10, 10000, "messages via the reloaded relay");
        });
      });

      if (MEDIA) {
        test("REL-10 BWE through a multicasting relay: A follows the minimum budget", async () => {
          await withScenario(`REL-10-${tag}`, { browsers: browsersFor(pairing, 4, relayOther), config: FAST }, async (s) => {
            await s.eval(0, () => window.t.publishNoise("noise"));
            await meshWithBlocks(s, [[0, 1], [0, 3]]);
            await waitRoute(s, 0, 1, "relay", 2);
            await waitRoute(s, 0, 3, "relay", 2);
            await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, `${s.id(0)}:noise`)) >= 0, 1000, "");
            s.rule(s.id(2), s.id(1), { bandwidth: 600000 });
            s.rule(s.id(2), s.id(3), { bandwidth: 300000 });
            let toC = Infinity;
            let params = [];
            const budgeted = () => params.flat().some((e) => e?.maxBitrate && e.maxBitrate <= 300000 * 1.1);
            await waitFor(async () => {
              params = await s.eval(0, (id) => window.t.senderParams(id), s.id(2));
              if (!budgeted()) return false;
              toC = await s.eval(0, (id) => window.t.outboundBitrate(id, 2000), s.id(2));
              return toC < 300000 * 1.4;
            }, 25000, "A follows the minimum budget").catch(() => {});
            const cBudgets = await s.eval(2, () => window.t.stats().budgets);
            console.log(`    REL-10 ${tag}: A->C ${Math.round(toC / 1000)} kbps, A params ${JSON.stringify(params)}, C budgets ${JSON.stringify(cBudgets)}`);
            assert.ok(budgeted(), `A's sender uses the minimum budget: ${JSON.stringify(params)}`);
            assert.ok(toC < 300000 * 1.4, `A sends at about the minimum budget: ${toC}`);
          });
        });

        test("REL-11 subscriptions through a relay: unsubscribed flows stop at the source", async () => {
          await withScenario(`REL-11-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
            await s.eval(0, () => window.t.publishCounter("camera"));
            await s.eval(2, (id) => window.t.setSubscription(id, { video: false }), s.id(0));
            await meshWithBlocks(s, [[0, 1]]);
            await waitRoute(s, 0, 1, "relay", 2);
            await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, `${s.id(0)}:camera`)) > 10, 20000, "video at B");
            await s.eval(1, (id) => window.t.setSubscription(id, { video: false }), s.id(0));
            let toB = Infinity;
            let toC = Infinity;
            await waitFor(async () => {
              [toB, toC] = await Promise.all([s.eval(2, (id) => window.t.outboundBitrate(id, 1000), s.id(1)), s.eval(0, (id) => window.t.outboundBitrate(id, 1000), s.id(2))]);
              return toB < 20000 && toC < 20000;
            }, 15000, "flows stopped").catch(() => {});
            console.log(`    REL-11 ${tag}: C->B ${Math.round(toB / 1000)} kbps, A->C ${Math.round(toC / 1000)} kbps`);
            assert.ok(toB < 20000, "C stopped forwarding");
            assert.ok(toC < 20000, "A stopped sending");
          });
        });
      }

      test("REL-12 security: relayed data is ciphertext; hello, offer, answer never pass the relay", async () => {
        await withScenario(`REL-12-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: { ...FAST, logLevel: "debug" } }, async (s) => {
          await s.eval(2, () => window.t.hook.captureForwarded());
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay", 2);
          await openChannel(s, 0, 1, "chat");
          await sendMany(s, 0, 1, "chat", "SECRET-PLAINTEXT-", 20);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 20, 10000, "messages");
          const seen = await s.eval(2, () => window.t.forwarded.join("|"));
          assert.ok(seen.length > 0, "relay forwarded envelopes");
          assert.ok(!seen.includes("SECRET-PLAINTEXT"), "forwarded payloads are ciphertext");
          const forwarded = (await s.eval(2, () => window.t.log())).filter((e) => e.msg === "forward signal").map((e) => e.data.t);
          assert.ok(!forwarded.some((t) => ["hello", "offer", "answer"].includes(t)), `forwarded types: ${[...new Set(forwarded)]}`);
        });
      });

      test("REL-13 TURN: used when no peer route exists, replaced by a peer relay", async () => {
        const { turn, turnPort } = await startTurnServer();
        try {
          const iceServers = [{ urls: `turn:127.0.0.1:${turnPort}?transport=udp`, username: "test", credential: "secret" }];
          const turnSooner = FAST_TIMINGS ? { iceRestartBackoffMs: [100], rebuildAttempts: 0 } : {};
          await withScenario(`REL-13-${tag}`, { browsers: browsersFor(pairing, 2, relayOther), config: { ...FAST, ...turnSooner }, iceServers }, async (s) => {
            await meshWithBlocks(s, [[0, 1]]);
            await waitFor(async () => (await route(s, 0, 1))?.candidateType === "relay" && (await s.eval(0, (id) => window.t.state(id), s.id(1))) === "connected", 60000, "TURN route");
            console.log(`    REL-13 ${tag}: TURN route in use`);
            await openChannel(s, 0, 1, "chat");
            const relayId = `C${Math.random().toString(36).slice(2, 6)}`;
            await s.openPeer(relayId, browsersFor(pairing, 3, relayOther)[2], FAST);
            await s.meshAll();
            await waitRoute(s, 0, 1, "relay", relayId, 40000);
            await sendMany(s, 0, 1, "chat", "t", 20);
            await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 20, 10000, "messages via the peer relay");
          });
        } finally {
          await Promise.race([new Promise((resolve) => turn.stop(resolve)), sleep(2000)]);
        }
      });

      if (MEDIA) {
        test("REL-14 codec mismatch: the relay choice respects capabilities", async () => {
          const noVp8 = { send: { video: ["video/H264"], audio: ["audio/opus"] }, recv: { video: ["video/H264"], audio: ["audio/opus"] } };
          await withScenario(`REL-14-${tag}`, { browsers: browsersFor(pairing, 4, relayOther), config: FAST, peerConfig: { 0: { caps: { send: { video: ["video/VP8"], audio: ["audio/opus"] }, recv: { video: ["video/VP8"], audio: ["audio/opus"] } } }, 1: { caps: { send: { video: ["video/VP8"], audio: ["audio/opus"] }, recv: { video: ["video/VP8"], audio: ["audio/opus"] } } }, 2: { caps: noVp8 } } }, async (s) => {
            await s.eval(0, () => window.t.publishCounter("camera"));
            await meshWithBlocks(s, [[0, 1]]);
            await waitRoute(s, 0, 1, "relay", 3, 30000);
            await sleep(F.switchHoldMs);
            assert.equal((await route(s, 0, 1)).via, s.id(3), "relay that cannot decode VP8 is not used");
            const flows = await s.eval(0, (id) => window.t.stats().peers[id].flows, s.id(1));
            assert.ok(!flows.some((f) => f.via === s.id(2)), "no flow through the incompatible relay");
            await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, `${s.id(0)}:camera`)) > 10, 20000, "video via the compatible relay");
          });
        });
      }

      test("REL-15 partial reliability through a relay", async () => {
        await withScenario(`REL-15-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay", 2);
          await openChannel(s, 0, 1, "life", { ordered: false, maxPacketLifeTime: 150 });
          await openChannel(s, 0, 1, "rt0", { ordered: false, maxRetransmits: 0 });
          await openChannel(s, 0, 1, "rt8", { ordered: false, maxRetransmits: 8 });
          const relayRtt = async () => (await s.eval(2, (id) => window.t.directInfo(id), s.id(0)))?.metrics?.rtt ?? 0;
          s.rule(s.id(0), s.id(2), { delay: 200 });
          s.rule(s.id(2), s.id(0), { delay: 200 });
          await waitFor(async () => (await relayRtt()) >= 300, 10000, "the relay measures the delayed hop");
          await sendMany(s, 0, 1, "life", "old", 20);
          await sleep(1000);
          assert.equal((await messages(s, 1, 0, "life")).length, 0, "expired messages dropped at the relay");
          s.rule(s.id(0), s.id(2), { delay: 0 });
          s.rule(s.id(2), s.id(0), { delay: 0 });
          await waitFor(async () => (await relayRtt()) < 100, 10000, "the relay measures the fast hop");
          await sendMany(s, 0, 1, "life", "new", 20);
          await waitFor(async () => (await messages(s, 1, 0, "life")).length >= 10, 8000, "fresh messages arrive");
          s.rule(s.id(2), s.id(1), { loss: 0.25 });
          s.rule(s.id(1), s.id(2), { loss: 0.25 });
          await sendMany(s, 0, 1, "rt0", "z", 200);
          await sendMany(s, 0, 1, "rt8", "e", 200);
          await untilSettled(async () => (await messages(s, 1, 0, "rt8")).length, 195, 2000, 40000);
          const z = (await messages(s, 1, 0, "rt0")).length;
          const e = (await messages(s, 1, 0, "rt8")).length;
          console.log(`    REL-15 ${tag}: maxRetransmits 0 delivered ${z}/200, maxRetransmits 8 delivered ${e}/200`);
          assert.ok(z < 180, "maxRetransmits 0 loses messages on a lossy hop");
          for (const [p, q] of [[0, 2], [2, 1], [2, 0], [1, 2]]) {
            const tr = await s.eval(p, (id) => window.t.hook.transports(id), s.id(q));
            const rt8 = tr.find((x) => x.key === "o0:r8:l-");
            if (rt8 || (p === 0 && q === 2) || (p === 2 && q === 1)) assert.equal(rt8?.maxRetransmits, 8, `hop ${p}->${q} uses maxRetransmits 8: ${JSON.stringify(tr)}`);
          }
          if (pairing === "firefox") assert.ok(e > z + 15, "maxRetransmits 8 recovers losses per hop");
        });
      });

      test("REL-16 relay authorization", async () => {
        await withScenario(`REL-16-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST, peerConfig: { 2: { relayDenyAll: true } } }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitFor(async () => (await logMatches(s, 2, /relay request rejected/)).length > 0, 15000, "relay request rejected");
          await sleep(1000);
          assert.notEqual(await s.eval(0, (id) => window.t.state(id), s.id(1)), "connected", "allowRelay refuses");
          assert.ok((await logMatches(s, 2, /relay request rejected/)).length > 0, "rejection logged");
          await s.eval(0, ([via, target]) => window.t.hook.sendCtl(via, { t: "relay-request", flow: "x1", origin: window.t.group.selfId, target, role: "active" }), [s.id(2), "nonmember"]);
          await s.eval(0, ([via, target]) => window.t.hook.rawEnvelope(via, target), [s.id(2), s.id(1)]);
          await sleep(1000);
          const rejected = (await s.eval(2, () => window.t.log())).filter((e) => e.msg === "relay request rejected").map((e) => e.data.reason);
          assert.ok(rejected.includes("not a member"), JSON.stringify(rejected));
          assert.ok((await logMatches(s, 2, /dropped envelope of unaccepted flow/)).length > 0, "unaccepted envelope dropped");
        });
      });

      test("REL-17 protocol versions: minor negotiates down, major mismatch is unreachable", async () => {
        await withScenario(`REL-17-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST, peerConfig: { 1: { protocol: { major: 1, minor: 7, features: ["e2e-rel", "relay", "future"] } }, 2: { protocol: { major: 2, minor: 0, features: [] } } } }, async (s) => {
          await s.meshAll();
          await s.waitState(0, 1, "connected", 20000);
          const remote = await s.eval(0, (id) => window.t.group.connections.get(id).remote.proto, s.id(1));
          assert.equal(remote.minor, 0);
          assert.deepEqual(remote.features, ["e2e-rel", "relay"]);
          await s.waitState(0, 2, "unreachable", 20000);
          const info = await s.eval(0, (id) => window.t.peerInfo(id), s.id(2));
          assert.equal(info.reason, "protocol-mismatch");
          assert.ok((await logMatches(s, 0, /protocol mismatch/)).length > 0);
        });
      });

      test("REL-18 hidden peer behind a relay: kept via consent, route-down when it closes", async () => {
        await withScenario(`REL-18-${tag}`, { browsers: browsersFor(pairing, 3, relayOther), config: FAST }, async (s) => {
          await meshWithBlocks(s, [[0, 1]]);
          await waitRoute(s, 0, 1, "relay", 2);
          await waitRoute(s, 1, 0, "relay", 2);
          await s.eval(1, () => window.t.hook.visibility(true));
          await sleep(500);
          let t0 = Date.now();
          if (s.page(1).browserName === "chromium") {
            const cdp = await s.page(1).context().newCDPSession(s.page(1));
            await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
            await sleep(Math.max(2.4 * F.STALE_CONNECTION_MS, 6000));
            const mid = await states(s, 0, 1, t0);
            await cdp.send("Page.setWebLifecycleState", { state: "active" });
            assert.ok(!mid.some((e) => e.state === "reconnecting"), `A keeps the route to the hidden peer: ${JSON.stringify(mid)}`);
          } else {
            await sleep(Math.max(1.6 * F.STALE_CONNECTION_MS, 4000));
            assert.ok(!(await states(s, 0, 1, t0)).some((e) => e.state === "reconnecting"), "A keeps the route to the hidden peer");
          }
          t0 = Date.now();
          s.block(2, 1);
          s.server.controls.down = true;
          await waitFor(async () => (await s.eval(0, (id) => window.t.state(id), s.id(1))) !== "connected", F.BACKGROUND_STALE_MS + 5000, "A reacts");
          const reacted = Date.now() - t0;
          console.log(`    REL-18 ${tag}: A reacted after ${reacted} ms`);
          assert.ok(reacted <= F.BACKGROUND_STALE_MS + 1500, "within BACKGROUND_STALE_MS");
        });
      });
    });
  }
}
