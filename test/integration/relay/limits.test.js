// Media limits and relay policy: relayMedia, setLimits, setTargets, profile, setMetered, reportLoad.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { withScenario, sleep, waitFor, PAIRINGS, pairings, closeBrowsers, connectAll, openChannel, messages, sendMany, FAST_RECOVERY, FAST_TIMINGS } from "../common.js";

after(() => closeBrowsers());

const FAST = FAST_TIMINGS ? FAST_RECOVERY : { ...FAST_RECOVERY, directTableIntervalMs: 1000 };

const route = (s, p, q) => s.eval(p, (id) => window.t.route(id), s.id(q));

const waitRoute = (s, p, q, via, timeoutMs = 30000) => waitFor(async () => {
  const r = await route(s, p, q);
  return r?.kind === "relay" && (via === undefined || r.via === s.id(via)) ? r : false;
}, timeoutMs, `${s.id(p)} routes to ${s.id(q)} through a relay`);

async function blockedMesh(s, blocked) {
  for (const [a, b] of blocked) s.block(a, b);
  await s.meshAll();
}

const frames = (s, p, q, tag = "camera") => s.eval(p, (k) => window.t.frames(k).length, `${s.id(q)}:${tag}`);

const framesGrow = (s, p, q, what) => waitFor(async () => {
  const first = await frames(s, p, q);
  await sleep(1000);
  return (await frames(s, p, q)) > first;
}, 30000, what);

const setHookProfile = (s, p, profile) => s.eval(p, (values) => {
  window.t.group.hooks.profile = values;
  window.t.group.checkProfile();
}, profile);

for (const pairing of pairings()) {
  describe(`limits ${pairing}`, { concurrency: false }, () => {
    const browsers = (n) => PAIRINGS[pairing].concat(PAIRINGS[pairing]).slice(0, n);

    test("LIM-1 relayMedia false: data passes the relay, media does not, own media stays relayable", async () => {
      await withScenario(`LIM-1-${pairing}`, { browsers: browsers(3), config: { ...FAST, relayMedia: false } }, async (s) => {
        await s.eval(0, () => window.t.publishCounter("camera"));
        await s.eval(1, () => window.t.publishCounter("camera"));
        await blockedMesh(s, [[0, 1]]);
        await waitRoute(s, 0, 1, 2);
        await openChannel(s, 0, 1, "d");
        await sendMany(s, 0, 1, "d", "m", 20);
        await waitFor(async () => (await messages(s, 1, 0, "d")).length >= 20, 15000, "data through the relay");
        await sleep(3000);
        assert.equal(await frames(s, 1, 0), 0, "no media through the relay");
        assert.equal(await s.eval(2, () => window.t.group.relaysMedia), false);
        const forwarded = await s.eval(2, (id) => window.t.group.directConns.get(id).getSenders().filter((x) => x.track?.kind === "video").length, s.id(1));
        assert.equal(forwarded, 0, "the relay has no forwarding sender");
      });
    });

    test("LIM-2 auto: a relay that gets metered loses its media routes, media moves to another relay", async () => {
      await withScenario(`LIM-2-${pairing}`, { browsers: browsers(4), config: FAST }, async (s) => {
        await s.eval(0, () => window.t.publishCounter("camera"));
        await blockedMesh(s, [[0, 1]]);
        const first = await waitRoute(s, 0, 1);
        await framesGrow(s, 1, 0, "video through the first relay");
        const firstIndex = [2, 3].find((p) => s.id(p) === first.via);
        const otherIndex = firstIndex === 2 ? 3 : 2;
        await s.eval(firstIndex, () => window.t.group.setMetered(true));
        assert.equal(await s.eval(firstIndex, () => window.t.group.relaysMedia), false);
        await waitRoute(s, 0, 1, otherIndex);
        await framesGrow(s, 1, 0, "video through the other relay");
      });
    });

    test("LIM-3 auto: a compute limited relay keeps data, a metered origin stays relayable", async () => {
      await withScenario(`LIM-3-${pairing}`, { browsers: browsers(3), config: FAST }, async (s) => {
        await s.eval(0, () => window.t.publishCounter("camera"));
        await blockedMesh(s, [[0, 1]]);
        await waitRoute(s, 0, 1, 2);
        await s.eval(0, () => window.t.group.setMetered(true));
        await sleep(2000);
        await framesGrow(s, 1, 0, "video of a metered origin through a relay");
        await openChannel(s, 0, 1, "d");
        await setHookProfile(s, 2, { cpuLimited: true });
        await waitFor(async () => {
          const count = await frames(s, 1, 0);
          await sleep(1500);
          return (await frames(s, 1, 0)) === count;
        }, 20000, "video stops at the compute limited relay");
        await sendMany(s, 0, 1, "d", "m", 20);
        await waitFor(async () => (await messages(s, 1, 0, "d")).length >= 20, 15000, "data still passes");
        await setHookProfile(s, 2, { cpuLimited: false });
        await framesGrow(s, 1, 0, "video comes back");
      });
    });

    test("LIM-4 setLimits: lasts on the sender, combines, and relays apply the bitrate limit", async () => {
      await withScenario(`LIM-4-${pairing}`, { browsers: browsers(3), config: FAST }, async (s) => {
        await s.eval(0, () => window.t.publishCounter("camera"));
        await blockedMesh(s, [[0, 1]]);
        await waitRoute(s, 0, 1, 2);
        await framesGrow(s, 1, 0, "video at the target");
        await s.eval(0, () => window.t.pubs.get("camera").setLimits({ maxBitrate: 150000, maxFramerate: 10, scaleResolutionDownBy: 2 }));
        const check = async (p, q) => waitFor(async () => {
          const params = (await s.eval(p, (id) => window.t.senderParams(id), s.id(q))).flat();
          return params.some((e) => e.active && e.maxBitrate <= 150000) ? params : false;
        }, 15000, `limit at ${p} toward ${q}`);
        const origin = await check(0, 2);
        assert.ok(origin.some((e) => e.scale === 2), JSON.stringify(origin));
        await check(2, 1);
        const raw = await s.eval(0, (id) => window.t.group.directConns.get(id).getSenders().filter((x) => x.track?.kind === "video").map((x) => x.getParameters().encodings[0].maxFramerate), s.id(2));
        assert.ok(raw.includes(10), JSON.stringify(raw));
        await s.eval(0, () => window.t.pubs.get("camera").setLimits(null));
        await waitFor(async () => (await s.eval(0, (id) => window.t.senderParams(id), s.id(2))).flat().every((e) => e.maxBitrate === undefined || e.maxBitrate > 150000), 15000, "limit removed");
      });
    });

    test("LIM-5 setTargets: a receiver that stays keeps its stream, one that goes stops receiving", async () => {
      await withScenario(`LIM-5-${pairing}`, { browsers: browsers(3), config: FAST }, async (s) => {
        await s.eval(0, () => window.t.publishCounter("camera"));
        await connectAll(s);
        await framesGrow(s, 1, 0, "video at the first receiver");
        await framesGrow(s, 2, 0, "video at the second receiver");
        const streamOf = (p) => s.eval(p, (id) => {
          const entry = window.t.tracks.filter((x) => x.origin === id && x.kind === "video").at(-1);
          return { stream: entry?.stream?.id, count: window.t.tracks.filter((x) => x.origin === id && x.kind === "video").length };
        }, s.id(0));
        const before = await streamOf(1);
        await s.eval(0, (id) => window.t.pubs.get("camera").setTargets([id]), s.id(1));
        await waitFor(async () => {
          const count = await frames(s, 2, 0);
          await sleep(1500);
          return (await frames(s, 2, 0)) === count;
        }, 15000, "the second receiver stops");
        await framesGrow(s, 1, 0, "the first receiver goes on");
        assert.deepEqual(await streamOf(1), before);
        await s.eval(0, () => window.t.pubs.get("camera").setTargets("all"));
        await framesGrow(s, 2, 0, "the second receiver gets video again");
        assert.deepEqual(await streamOf(1), before);
      });
    });

    test("LIM-6 profile: setMetered and test values fire profilechange", async () => {
      await withScenario(`LIM-6-${pairing}`, { browsers: browsers(2), config: FAST }, async (s) => {
        await s.eval(0, () => window.t.publishCounter("camera"));
        await connectAll(s);
        await framesGrow(s, 1, 0, "video");
        const profile = await s.eval(0, () => {
          window.t.profiles = [];
          window.t.group.on("profilechange", (p) => window.t.profiles.push(p));
          return window.t.group.profile();
        });
        assert.equal(profile.metered, false);
        assert.equal(typeof profile.cpuLimited, "boolean");
        await s.eval(0, () => window.t.group.setMetered(true));
        assert.equal((await s.eval(0, () => window.t.profiles.at(-1))).metered, true);
        await setHookProfile(s, 0, { cpuLimited: true, connectionType: "cellular" });
        const last = await s.eval(0, () => window.t.profiles.at(-1));
        assert.equal(last.cpuLimited, true);
        assert.equal(last.connectionType, "cellular");
        const encode = await s.eval(0, () => window.t.group.probeEncoding({ width: 360, height: 360, bitrate: 500000, framerate: 24 }));
        assert.ok(encode === null || typeof encode.supported === "boolean", JSON.stringify(encode));
      });
    });

    test("LIM-7 reportLoad: raises the load figure, routes leave the relay", async () => {
      await withScenario(`LIM-7-${pairing}`, { browsers: browsers(4), config: FAST }, async (s) => {
        await blockedMesh(s, [[0, 1]]);
        const first = await waitRoute(s, 0, 1);
        const firstIndex = [2, 3].find((p) => s.id(p) === first.via);
        const otherIndex = firstIndex === 2 ? 3 : 2;
        await s.eval(firstIndex, () => window.t.group.reportLoad(2));
        assert.ok((await s.eval(firstIndex, () => window.t.stats().load)) >= 2);
        await waitRoute(s, 0, 1, otherIndex);
        await s.eval(firstIndex, () => window.t.group.reportLoad(0));
        assert.ok((await s.eval(firstIndex, () => window.t.stats().load)) < 1);
      });
    });
  });
}
