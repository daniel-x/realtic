// DIR scenarios (plan section 14.4) in every browser pairing. Filter with REALTIC_PAIRINGS and
// node --test-name-pattern.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import {
  withScenario, connectAll, sleep, waitFor, PAIRINGS, pairings, closeBrowsers, states, openChannel, messages,
  sendMany, assertSequence, session, logMatches, FAST_RECOVERY, events, T, testConfig, effective, FAST_TIMINGS,
} from "../common.js";
import { TestStunServer } from "../harness/stun.js";

after(() => closeBrowsers());

const two = (pairing) => PAIRINGS[pairing].slice(0, 2);
// Video budget at the loss-based estimator's floor (50 kbps) with the default headroom.
const BWE_FLOOR_BUDGET = 50000 * 0.9;
// Loopback, private and shared (CGNAT, 100.64.0.0/10) IPv4 addresses, the ones a test host has.
const NON_PUBLIC_IPV4 = /\b(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)\b/;
const near = (actual, expected, tolerance, what) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} ms, expected ${expected} +- ${tolerance}`);

for (const pairing of pairings()) {
  describe(`direct ${pairing}`, { concurrency: false }, () => {
    test("DIR-1 setup with delayed and duplicated signaling, media, simultaneous channels", async () => {
      const delayMs = 1500;
      const config = FAST_TIMINGS ? { connectTimeoutMs: T.connectTimeoutMs + 4 * delayMs, CHANNEL_OPEN_TIMEOUT_MS: T.CHANNEL_OPEN_TIMEOUT_MS + 2 * delayMs, recoveryStepTimeoutMs: T.recoveryStepTimeoutMs + 4 * delayMs } : {};
      await withScenario(`DIR-1-${pairing}`, { browsers: two(pairing), config }, async (s) => {
        s.server.controls.delayMs = delayMs;
        s.server.controls.duplicate = true;
        s.server.controls.redeliver = true;
        await s.eval(0, () => window.t.publishCounter("camera"));
        await s.eval(1, () => window.t.publishCounter("camera"));
        await connectAll(s, 40000);
        const [a, b] = s.ids;
        const polite = a < b ? 0 : 1;
        const impolite = 1 - polite;
        await Promise.all([
          s.eval(polite, (id) => window.t.createChannel(id, "partial", { ordered: false, maxRetransmits: 2 }), s.id(impolite)),
          s.eval(impolite, (id) => window.t.createChannel(id, "reliable"), s.id(polite)),
          s.eval(polite, (id) => window.t.createChannel(id, "chat"), s.id(impolite)),
        ]);
        for (const [p, q, label] of [[polite, impolite, "partial"], [impolite, polite, "reliable"], [polite, impolite, "chat"]]) {
          await waitFor(() => s.eval(p, ([id, l]) => window.t.channelState(id, l) === "open", [s.id(q), label]), 15000, `${label} open`);
          await waitFor(() => s.eval(q, ([id, l]) => window.t.channelState(id, l) === "open", [s.id(p), label]), 15000, `${label} open remote`);
        }
        await sendMany(s, polite, impolite, "partial", "p", 50);
        await sendMany(s, impolite, polite, "reliable", "r", 200);
        await sendMany(s, polite, impolite, "chat", "c", 200);
        await waitFor(async () => (await messages(s, polite, impolite, "reliable")).length >= 200, 10000, "reliable messages");
        await waitFor(async () => (await messages(s, impolite, polite, "chat")).length >= 200, 10000, "chat messages");
        assertSequence(assert, await messages(s, polite, impolite, "reliable"), "r", 200);
        assertSequence(assert, await messages(s, impolite, polite, "chat"), "c", 200);
        const partial = await messages(s, impolite, polite, "partial");
        assert.ok(partial.length >= 45, `partial reliability delivered ${partial.length}/50`);
        assert.equal(new Set(partial).size, partial.length, "no duplicates");
        for (const [p, q] of [[0, 1], [1, 0]]) {
          await waitFor(async () => (await s.eval(p, (k) => window.t.frames(k).length, `${s.id(q)}:camera`)) > 10, 15000, "video frames");
        }
        const sess = [await session(s, 0, 1), await session(s, 1, 0)];
        s.server.setDown(true);
        await sleep(300);
        s.server.setDown(false);
        await sleep(2500);
        assert.deepEqual([await session(s, 0, 1), await session(s, 1, 0)], sess, "redelivered signaling did not rebuild the link");
        assert.equal(await s.eval(0, (id) => window.t.state(id), s.id(1)), "connected");
        assert.deepEqual(await s.eval(0, () => window.t.errors), []);
        assert.deepEqual(await s.eval(1, () => window.t.errors), []);
      });
    });

    test("DIR-2 silent link death: slow, stale, ICE restart, recovery", async () => {
      await withScenario(`DIR-2-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        const sess = await session(s, 0, 1);
        const t0 = Date.now();
        s.block(0, 1);
        await waitFor(async () => (await states(s, 1, 0, t0)).some((e) => e.state === "reconnecting"), 10000, "reconnecting");
        await sleep(T.iceRestartBackoffMs[0] + 500);
        const st = await states(s, 1, 0, t0);
        const slow = st.find((e) => e.state === "slow");
        const stale = st.find((e) => e.state === "reconnecting");
        assert.ok(slow, "slow state seen");
        near(slow.time - t0, T.SLOW_CONNECTION_MS, Math.max(250, 0.6 * T.SLOW_CONNECTION_MS), "slow after");
        near(stale.time - t0, T.STALE_CONNECTION_MS, Math.max(250, 0.18 * T.STALE_CONNECTION_MS), "stale after");
        const restarts = await logMatches(s, s.id(0) > s.id(1) ? 0 : 1, /ICE restart/, t0);
        assert.ok(restarts.length >= 1, "ICE restart logged");
        await sendMany(s, 0, 1, "chat", "x", 20);
        s.block(0, 1, false);
        await s.waitState(0, 1, "connected", 30000);
        await s.waitState(1, 0, "connected", 30000);
        await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 20, 15000, "messages after recovery");
        assertSequence(assert, await messages(s, 1, 0, "chat"), "x", 20);
        const after = await session(s, 0, 1);
        const rebuilt = after !== sess;
        console.log(`    DIR-2 ${pairing}: slow ${slow.time - t0} ms, stale ${stale.time - t0} ms, rebuilt ${rebuilt}`);
      });
    });

    test("DIR-3 short outage below the stale threshold: no rebuild, ordered delivery", async () => {
      await withScenario(`DIR-3-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        const sess = [await session(s, 0, 1), await session(s, 1, 0)];
        const t0 = Date.now();
        s.block(0, 1);
        await sendMany(s, 0, 1, "chat", "o", 100);
        await sleep(Math.max(2 * T.SLOW_CONNECTION_MS, 0.3 * T.STALE_CONNECTION_MS));
        s.block(0, 1, false);
        await s.waitState(1, 0, "connected", 5000);
        await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 100, 10000, "outage messages");
        assertSequence(assert, await messages(s, 1, 0, "chat"), "o", 100);
        const st = await states(s, 1, 0, t0);
        assert.ok(st.some((e) => e.state === "slow"), "went slow");
        assert.ok(!st.some((e) => e.state === "reconnecting"), "did not go stale");
        assert.deepEqual([await session(s, 0, 1), await session(s, 1, 0)], sess, "no rebuild");
        const restarts = await logMatches(s, 0, /ICE restart|new connection/, t0);
        assert.equal(restarts.length, 0, "no ICE restart");
      });
    });

    test("DIR-4 long outage past all restarts: unreachable, then background re-probe recovers", async () => {
      await withScenario(`DIR-4-${pairing}`, { browsers: two(pairing), config: FAST_RECOVERY }, async (s) => {
        await connectAll(s);
        const t0 = Date.now();
        s.block(0, 1);
        await s.waitState(0, 1, "unreachable", 40000);
        await s.waitState(1, 0, "unreachable", 40000);
        const info = await s.eval(0, (id) => window.t.peerInfo(id), s.id(1));
        assert.ok(info.reason, "unreachable has a reason");
        console.log(`    DIR-4 ${pairing}: unreachable after ${Date.now() - t0} ms, reason: ${info.reason}`);
        await sleep(2 * effective(FAST_RECOVERY).reprobeIntervalsMs[0]);
        assert.equal(await s.eval(0, (id) => window.t.state(id), s.id(1)), "unreachable", "stays unreachable while blocked");
        s.block(0, 1, false);
        await s.waitState(0, 1, "connected", 30000);
        await s.waitState(1, 0, "connected", 30000);
        assert.ok((await logMatches(s, 0, /background re-probe/, t0)).length + (await logMatches(s, 1, /background re-probe/, t0)).length >= 1, "re-probe ran");
      });
    });

    test("DIR-5 one-way loss in each direction", async () => {
      await withScenario(`DIR-5-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        let n = 0;
        for (const [from, to] of [[0, 1], [1, 0]]) {
          const t0 = Date.now();
          s.rule(s.id(from), s.id(to), { down: true });
          await waitFor(async () => (await states(s, to, from, t0)).some((e) => e.state === "reconnecting"), 12000, "receiver goes stale");
          await waitFor(async () => (await states(s, from, to, t0)).some((e) => e.state !== "connected"), 12000, "sender learns of the silence");
          await sendMany(s, 0, 1, "chat", `w${n}-`, 10);
          s.rule(s.id(from), s.id(to), { down: false });
          await s.waitState(0, 1, "connected", 30000);
          await s.waitState(1, 0, "connected", 30000);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).filter((m) => m.startsWith(`w${n}-`)).length >= 10, 15000, "messages");
          assertSequence(assert, await messages(s, 1, 0, "chat"), `w${n}-`, 10);
          n++;
        }
      });
    });

    test("DIR-6 STUN passes, DTLS dropped: watchdog fires and the link rebuilds", async () => {
      await withScenario(`DIR-6-${pairing}`, { browsers: two(pairing) }, async (s) => {
        s.rule(s.id(0), s.id(1), { drop: ["dtls"] });
        s.rule(s.id(1), s.id(0), { drop: ["dtls"] });
        const t0 = Date.now();
        await s.meshAll();
        await waitFor(async () => (await logMatches(s, 0, /did not open in time/, t0)).length + (await logMatches(s, 1, /did not open in time/, t0)).length > 0, 15000, "watchdog");
        const fired = [...(await logMatches(s, 0, /did not open in time/, t0)), ...(await logMatches(s, 1, /did not open in time/, t0))].sort((a, b) => a.time - b.time)[0];
        near(fired.time - t0, T.CHANNEL_OPEN_TIMEOUT_MS, 2000, "watchdog after");
        await waitFor(async () => (await logMatches(s, s.id(0) > s.id(1) ? 0 : 1, /new connection/, fired.time)).length > 0, 5000, "rebuild");
        s.rule(s.id(0), s.id(1), { drop: [] });
        s.rule(s.id(1), s.id(0), { drop: [] });
        await s.waitState(0, 1, "connected", 30000);
      });
    });

    test("DIR-7 mismatched session: the other side rebuilds", async () => {
      await withScenario(`DIR-7-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        for (const side of [0, 1]) {
          const other = 1 - side;
          const before = await session(s, other, side);
          const t0 = Date.now();
          await s.eval(side, (id) => window.t.hook.rebuild(id), s.id(other));
          await waitFor(async () => (await logMatches(s, other, /remote session changed/, t0)).length > 0, 20000, "session mismatch detected");
          await waitFor(async () => (await session(s, other, side)) !== before, 20000, "other side rebuilt");
          await waitFor(async () => (await s.eval(other, (id) => window.t.linkInfo(id).state, s.id(side))) === "connected", 20000, "link connected");
          await s.waitState(other, side, "connected", 20000);
          await s.waitState(side, other, "connected", 20000);
          await sendMany(s, 0, 1, "chat", `s${side}-`, 20);
          await waitFor(async () => (await messages(s, 1, 0, "chat")).filter((m) => m.startsWith(`s${side}-`)).length >= 20, 10000, "messages");
          assertSequence(assert, await messages(s, 1, 0, "chat"), `s${side}-`, 20);
        }
      });
    });

    test("DIR-8 SCTP abort on one side", async () => {
      await withScenario(`DIR-8-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        const before = await session(s, 1, 0);
        await s.eval(0, (id) => window.t.hook.abortTransport(id), s.id(1));
        await waitFor(async () => (await session(s, 1, 0)) !== before, 20000, "rebuild after abort");
        await s.waitState(0, 1, "connected", 30000);
        await s.waitState(1, 0, "connected", 30000);
        await sendMany(s, 0, 1, "chat", "a", 20);
        await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 20, 10000, "messages");
        assertSequence(assert, await messages(s, 1, 0, "chat"), "a", 20);
      });
    });

    test("DIR-9 frozen page: below and above the stale threshold, data-only and media; hidden tab judged by consent", async () => {
      await withScenario(`DIR-9-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        let t0 = Date.now();
        await s.eval(0, (d) => window.t.hook.busy(d), 0.6 * T.STALE_CONNECTION_MS);
        await sleep(500);
        assert.equal(await s.eval(1, (id) => window.t.state(id), s.id(0)), "connected");
        assert.ok(!(await states(s, 1, 0, t0)).some((e) => e.state === "reconnecting"), "a freeze below the stale threshold is not stale");
        t0 = Date.now();
        const before = await session(s, 1, 0);
        await s.eval(0, (d) => window.t.hook.busy(d), 2 * T.STALE_CONNECTION_MS);
        await s.waitState(1, 0, "connected", 30000);
        await s.waitState(0, 1, "connected", 30000);
        assert.ok((await states(s, 1, 0, t0)).some((e) => e.state === "reconnecting"), "a freeze twice the stale threshold is stale");
        await sendMany(s, 0, 1, "chat", "f", 10);
        await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 10, 10000, "messages after freeze");
        console.log(`    DIR-9 ${pairing}: ${2 * T.STALE_CONNECTION_MS} ms freeze rebuilt ${before !== (await session(s, 1, 0))}`);

        // Media keeps a frozen page alive where camera media is produced outside page JavaScript
        // (Chromium's fake device; Firefox produces its fake camera on the page's main thread).
        if (s.page(0).browserName === "chromium") {
        await s.eval(0, () => window.t.publishCamera("cam"));
        await waitFor(async () => (await s.eval(1, (id) => window.t.inboundBytes(id, "video"), s.id(0))) > 10000, 15000, "camera media");
        await sleep(500);
        t0 = Date.now();
        await s.eval(0, (d) => window.t.hook.busy(d), 1.4 * T.STALE_CONNECTION_MS);
        await sleep(500);
        assert.ok(!(await states(s, 1, 0, t0)).some((e) => e.state === "reconnecting"), "media counts as liveness during a freeze above the stale threshold");
        await s.eval(0, () => window.t.unpublish("cam"));
        }

        // A hidden data-only tab that announced bg is judged by ICE consent.
        if (s.page(0).browserName === "chromium") {
          await sleep(1000);
          const sess = await session(s, 1, 0);
          await s.eval(0, () => window.t.hook.visibility(true));
          await sleep(500);
          const cdp = await s.page(0).context().newCDPSession(s.page(0));
          t0 = Date.now();
          await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
          await sleep(Math.max(3 * T.STALE_CONNECTION_MS, 6000));
          const mid = await states(s, 1, 0, t0);
          await cdp.send("Page.setWebLifecycleState", { state: "active" });
          await s.eval(0, () => window.t.hook.visibility(false));
          assert.ok(!mid.some((e) => e.state === "reconnecting"), `hidden frozen tab not judged stale: ${JSON.stringify(mid)}`);
          assert.equal(await session(s, 1, 0), sess, "hidden tab link not rebuilt");
          await s.waitState(1, 0, "connected", 10000);
        }
      });
    });

    test("DIR-10 peer leaves with bye, disappears, browser killed, reloads", async () => {
      await withScenario(`DIR-10-${pairing}`, { browsers: [...two(pairing), PAIRINGS[pairing][2], PAIRINGS[pairing][3]], dedicated: [2], config: FAST_RECOVERY }, async (s) => {
        await connectAll(s);
        let t0 = Date.now();
        await s.eval(1, () => window.t.leave());
        await waitFor(async () => (await events(s, 0, t0, "peerleft")).some((e) => e.peer === s.id(1)), 5000, "peerleft after bye");
        const left = (await events(s, 0, t0, "peerleft")).find((e) => e.peer === s.id(1));
        assert.ok(left.time - t0 < 2000, `bye handled in ${left.time - t0} ms`);

        t0 = Date.now();
        s.killBrowser(2);
        await waitFor(async () => (await states(s, 0, 2, t0)).some((e) => e.state === "reconnecting"), 10000, "killed peer goes stale");
        await s.waitState(0, 2, "unreachable", 40000);

        const oldId = s.id(3);
        const page = s.page(3);
        await page.reload();
        await page.waitForFunction(() => window.t?.ready);
        const newId = `R${Math.random().toString(36).slice(2, 6)}`;
        await page.evaluate((o) => window.t.start(o), { id: newId, signaling: s.server.signaling, config: testConfig(FAST_RECOVERY), hooks: true });
        s.pages.delete(oldId);
        s.pages.set(newId, page);
        s.ids[3] = newId;
        await waitFor(async () => [null, "reconnecting", "unreachable"].includes(await s.eval(0, (id) => window.t.state(id), oldId)), 15000, "reloaded peer's old id gone");
        await s.eval(0, (id) => window.t.addPeer(id), newId);
        await page.evaluate((id) => window.t.addPeer(id), s.id(0));
        await waitFor(async () => (await s.eval(0, (id) => window.t.state(id), newId)) === "connected", 30000, "reloaded peer connects");
      });
    });

    test("DIR-11 rebinding under a live link", async () => {
      await withScenario(`DIR-11-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        await s.proxy.rebind(s.id(0));
        await sendMany(s, 0, 1, "chat", "b", 50);
        await sleep(1000);
        await s.waitState(0, 1, "connected", 30000);
        await s.waitState(1, 0, "connected", 30000);
        await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 50, 20000, "messages");
        assertSequence(assert, await messages(s, 1, 0, "chat"), "b", 50);
      });
    });

    test("DIR-12 network change: new public address, ICE restart on the live link without loss", async () => {
      const stun = await new TestStunServer().start();
      try {
        await withScenario(`DIR-12-${pairing}`, { browsers: two(pairing), config: { probeIceServers: [{ urls: stun.url }], networkProbeIntervalMs: Math.min(2000, T.networkProbeIntervalMs) } }, async (s) => {
          await s.eval(0, () => window.t.publishCounter("camera"));
          await connectAll(s);
          await openChannel(s, 0, 1, "chat");
          const key = `${s.id(0)}:camera`;
          await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, key)) > 20, 15000, "frames");
          const probeMs = Math.min(2000, T.networkProbeIntervalMs);
          await sleep(1.5 * probeMs);
          const sess = await session(s, 0, 1);
          const t0 = Date.now();
          stun.reportAddress = "198.51.100.7";
          for (let i = 0; i < 40; i++) {
            await sendMany(s, 0, 1, "chat", "n", 5, i * 5);
            await sleep((3 * probeMs) / 40);
          }
          await waitFor(async () => (await logMatches(s, 0, /public address changed/, t0)).length > 0, 10000, "change detected");
          await waitFor(async () => (await logMatches(s, s.id(0) > s.id(1) ? 0 : 1, /ICE restart/, t0)).length > 0, 10000, "ICE restart");
          await sleep(1000);
          assert.equal(await session(s, 0, 1), sess, "same connection");
          await waitFor(async () => (await messages(s, 1, 0, "chat")).length >= 200, 10000, "messages");
          assertSequence(assert, await messages(s, 1, 0, "chat"), "n", 200);
          const gap = await s.eval(1, ([k, from]) => window.t.maxGap(k, from), [key, t0]);
          assert.ok(gap < 700, `media gap ${gap} ms`);
          assert.ok(!(await states(s, 1, 0, t0)).some((e) => e.state !== "connected"), "stayed connected");
        });
      } finally {
        stun.stop();
      }
    });

    test("DIR-13 signaling server down: links unaffected, renegotiation over the mesh", async () => {
      await withScenario(`DIR-13-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        const t0 = Date.now();
        s.server.setDown(true);
        await sleep(Math.max(1.2 * T.STALE_CONNECTION_MS, 2000));
        assert.ok(!(await states(s, 0, 1, t0)).length, "no state change while the server is down");
        await s.eval(1, () => window.t.publishCounter("late"));
        await s.eval(0, () => window.t.publishCounter("late"));
        await waitFor(async () => (await s.eval(0, (k) => window.t.frames(k).length, `${s.id(1)}:late`)) > 5, 15000, "track added over the mesh (polite or impolite sender)");
        await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, `${s.id(0)}:late`)) > 5, 15000, "track added over the mesh (other side)");
        s.server.setDown(false);
        await waitFor(() => s.page(0).evaluate(() => window.t.group.signaling.connected), 10000, "signaling reconnected");
      });
    });

    test("DIR-14 bandwidth cap: sender bitrate follows the budget", async () => {
      await withScenario(`DIR-14-${pairing}`, { browsers: two(pairing) }, async (s) => {
        await s.eval(0, () => window.t.publishNoise("noise"));
        await connectAll(s);
        await waitFor(async () => (await s.eval(1, (id) => window.t.inboundBytes(id, "video"), s.id(0))) > 20000, 15000, "video flowing");
        let free = 0;
        await waitFor(async () => (free = await s.eval(0, (id) => window.t.outboundBitrate(id, 1000), s.id(1))) > 400000, 20000, `uncapped bitrate high enough to test a cap (last ${free})`);
        s.rule(s.id(0), s.id(1), { bandwidth: 250000 });
        let capped = Infinity;
        await waitFor(async () => (capped = await s.eval(0, (id) => window.t.outboundBitrate(id, 2000), s.id(1))) < 250000 * 1.3, 25000, "sender follows the cap").catch(() => {});
        const budgets = await s.eval(0, () => window.t.stats().budgets);
        console.log(`    DIR-14 ${pairing}: free ${Math.round(free / 1000)} kbps, capped ${Math.round(capped / 1000)} kbps`, JSON.stringify(budgets));
        assert.ok(capped < 250000 * 1.3, `sender follows the cap: ${capped}`);
        const budget = Object.values(budgets.links[s.id(1)] ?? {})[0];
        assert.ok(budget > BWE_FLOOR_BUDGET * 1.2 && budget < 250000 * 2, `budget near the cap, not at the estimator's floor or ceiling: ${budget}`);
        assert.equal(await s.eval(1, (id) => window.t.state(id), s.id(0)), "connected");
      });
    });

    test("DIR-15 reliable buffer overflow during an outage throws OperationError", async () => {
      await withScenario(`DIR-15-${pairing}`, { browsers: two(pairing), config: { reliableBufferBytes: 65536 } }, async (s) => {
        await connectAll(s);
        await openChannel(s, 0, 1, "chat");
        s.block(0, 1);
        await sleep(300);
        let result;
        for (let i = 0; i < 200 && !result; i++) {
          const r = await s.eval(0, (id) => window.t.sendBinary(id, "chat", 1024), s.id(1));
          if (r !== "ok") result = r;
        }
        assert.equal(result, "OperationError");
        s.block(0, 1, false);
        await s.waitState(1, 0, "connected", 30000);
      });
    });

    for (const stableTracks of pairing === "chromium" ? [false, true] : [false]) {
      test(`DIR-17 stable ${stableTracks ? "track" : "stream"} survives a link rebuild`, async () => {
        await withScenario(`DIR-17-${pairing}-${stableTracks}`, { browsers: two(pairing), peerConfig: { 1: { stableTracks } } }, async (s) => {
          await s.eval(0, () => window.t.publishCounter("camera"));
          await connectAll(s);
          const key = `${s.id(0)}:camera`;
          await waitFor(async () => (await s.eval(1, (k) => window.t.frames(k).length, key)) > 10, 15000, "frames");
          const id1 = await s.eval(1, () => window.t.tracks[0].track.id);
          await s.eval(0, (id) => window.t.hook.rebuild(id), s.id(1));
          await sleep(2000);
          const t0 = Date.now();
          await sleep(1000);
          assert.equal(await s.eval(1, () => window.t.tracks.length), 1, "no second track event");
          if (stableTracks) assert.equal(await s.eval(1, () => window.t.tracks[0].track.id), id1);
          await waitFor(async () => (await s.eval(1, ([k, f]) => window.t.frames(k, f).length, [key, t0])) > 5, 10000, "frames after the rebuild");
        });
      });
    }

    test("DIR-16 logging: state changes, ring buffer, report, remote log, redaction", async () => {
      await withScenario(`DIR-16-${pairing}`, { browsers: two(pairing), peerConfig: { 1: { shareLogWithPeers: true, logRedact: true } } }, async (s) => {
        await connectAll(s);
        const t0 = Date.now();
        s.block(0, 1);
        await s.waitState(1, 0, "reconnecting", 10000);
        s.block(0, 1, false);
        await s.waitState(1, 0, "connected", 30000);
        const entries = await s.eval(1, () => window.t.log());
        const changes = entries.filter((e) => e.time >= t0 && /state .* -> /.test(e.msg));
        assert.ok(changes.length >= 2 && changes.every((e) => e.data?.reason), "state changes with reasons");
        await s.eval(0, () => { for (let i = 0; i < 1500; i++) window.t.group.log.write("debug", "test", `filler ${i}`); });
        const all = await s.eval(0, () => window.t.log());
        assert.equal(all.length, 1024);
        assert.ok(all[0].seq > 1, "oldest overwritten, seq shows the gap");
        const report = await s.eval(0, () => window.t.report());
        assert.ok(JSON.stringify(report).length > 1000 && report.peers.length === 1);
        const refused = await s.eval(1, (id) => window.t.requestLog(id), s.id(0));
        assert.equal(refused.ok, false);
        const remote = await s.eval(0, (id) => window.t.requestLog(id), s.id(1));
        assert.ok(remote.ok && remote.entries > 0, JSON.stringify(remote));
        const redacted = JSON.stringify(await s.eval(1, () => window.t.report()));
        assert.ok(!NON_PUBLIC_IPV4.test(redacted), "no IP addresses in the redacted report");
        const plain = JSON.stringify(await s.eval(0, () => window.t.report()));
        assert.ok(NON_PUBLIC_IPV4.test(plain), "unredacted report has addresses");
      });
    });
  });
}
