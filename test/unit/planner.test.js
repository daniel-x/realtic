import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, RouteSelector, chooseStandby, CLASS, routeKey, relayLoad, codecPathOk } from "../../src/routing/planner.js";
import { directBudgets, relayBudget, scaleFor, encodingParams, BudgetReporter } from "../../src/media/bwe.js";
import { RalFakeClock } from "../../src/util/clock.js";

const ok = (rtt, extra = {}) => ({ state: "ok", rtt, candidateType: "host", ...extra });
const neighbor = (toNeighbor, table, extra = {}) => ({ toNeighbor, table: new Map(Object.entries(table)), load: 0, relay: true, mediaRelay: "allow", major: 1, ...extra });

const base = { target: "B", maxRelayLoad: 0.8, major: 1, self: "A" };

test("direct without TURN beats any relay; relay beats TURN", () => {
  const neighbors = new Map([["C", neighbor(ok(5), { B: ok(5) })]]);
  let list = candidates({ ...base, direct: ok(300), neighbors });
  assert.deepEqual(list.map(routeKey), ["direct", "relay:C"]);
  list = candidates({ ...base, direct: ok(10, { candidateType: "relay" }), neighbors });
  assert.deepEqual(list.map((c) => c.cls), [CLASS.PEER_RELAY, CLASS.TURN]);
});

test("relays are filtered by liveness, load, opt-out, version and media policy", () => {
  const neighbors = new Map([
    ["C", neighbor(ok(5), { B: { state: "stale" } })],
    ["D", neighbor(ok(5), { B: ok(5) }, { load: 0.9 })],
    ["E", neighbor(ok(5), { B: ok(5) }, { relay: false })],
    ["F", neighbor(ok(5), { B: ok(5) }, { major: 2 })],
    ["G", neighbor(ok(5), { B: ok(5) }, { mediaRelay: "never" })],
    ["H", neighbor(ok(5), { B: ok(5) })],
  ]);
  assert.deepEqual(candidates({ ...base, neighbors, media: true }).map(routeKey), ["relay:H"]);
  assert.deepEqual(candidates({ ...base, neighbors }).map(routeKey), ["relay:G", "relay:H"]);
});

test("least loaded relay wins among equals", () => {
  const neighbors = new Map([
    ["C", neighbor(ok(10), { B: ok(10) }, { load: 0.5 })],
    ["D", neighbor(ok(10), { B: ok(10) }, { load: 0.1 })],
  ]);
  const list = candidates({ ...base, neighbors });
  assert.equal(list[0].via, "D");
  assert.equal(chooseStandby(list, list[0]).via, "C");
});

test("codec capability check", () => {
  const vp8 = { send: { video: ["video/VP8"] }, recv: { video: ["video/VP8"] } };
  const h264 = { send: { video: ["video/H264"] }, recv: { video: ["video/H264"] } };
  assert.ok(codecPathOk(vp8, vp8, vp8, "video"));
  assert.ok(!codecPathOk(vp8, h264, vp8, "video"));
  assert.ok(codecPathOk(undefined, vp8, vp8, "video"));
});

test("hysteresis: switch only after threshold holds", () => {
  const clock = new RalFakeClock();
  const sel = new RouteSelector(clock, { switchThreshold: 0.25, switchHoldMs: 3000 });
  const r = (via, cost) => ({ kind: "relay", via, cls: 1, cost });
  assert.equal(sel.decide([r("C", 100)]).route.via, "C");
  assert.equal(sel.decide([r("D", 80), r("C", 100)]).route.via, "C");
  assert.equal(sel.decide([r("D", 50), r("C", 100)]).route.via, "C");
  clock.advance(2000);
  assert.equal(sel.decide([r("D", 50), r("C", 100)]).route.via, "C");
  clock.advance(1000);
  const d = sel.decide([r("D", 50), r("C", 100)]);
  assert.equal(d.route.via, "D");
  assert.ok(d.changed);
  assert.equal(sel.decide([r("C", 10)]).route.via, "C");
});

test("load figure", () => {
  assert.equal(relayLoad(500000, 1000000, false), 0.5);
  assert.equal(relayLoad(0, 0, true), 0.3);
});

test("budgets: audio reserve, video by weight; relay reports the minimum", () => {
  const b = directBudgets(1000000, [{ id: "a", kind: "audio" }, { id: "v1", kind: "video" }, { id: "v2", kind: "video", weight: 3 }], { headroom: 0.9, audioReserveBps: 64000 });
  assert.equal(b.get("a"), 64000);
  assert.equal(b.get("v1"), 209000);
  assert.equal(b.get("v2"), 627000);
  assert.equal(relayBudget([500000, 300000]), 300000);
  assert.equal(scaleFor(250000, [[300000, 2], [120000, 4]]), 2);
  assert.equal(scaleFor(100000, [[300000, 2], [120000, 4]]), 4);
});

test("budget reporter throttles but reports drops at once", () => {
  const clock = new RalFakeClock();
  const r = new BudgetReporter(clock, 500, 0.2);
  assert.ok(r.due(new Map([["v", 1000]])));
  assert.ok(!r.due(new Map([["v", 950]])));
  assert.ok(r.due(new Map([["v", 700]])));
  clock.advance(600);
  assert.ok(r.due(new Map([["v", 750]])));
});

test("a relay that forwards no media stays usable for data, behind relays that forward media", () => {
  const neighbors = new Map([
    ["C", neighbor(ok(5), { B: ok(5) }, { relayMedia: false })],
    ["D", neighbor(ok(100), { B: ok(100) })],
  ]);
  const withMedia = candidates({ ...base, neighbors, media: true });
  assert.deepEqual(withMedia.map(routeKey), ["relay:D", "relay:C"]);
  assert.equal(withMedia[1].dataOnly, true);
  assert.equal(withMedia[0].dataOnly, undefined);
  const dataOnly = candidates({ ...base, neighbors });
  assert.deepEqual(dataOnly.map(routeKey), ["relay:C", "relay:D"]);
  assert.equal(dataOnly[0].dataOnly, undefined);
});

test("a relay that forwards no media ignores the media policy, because it carries data only", () => {
  const neighbors = new Map([["C", neighbor(ok(5), { B: ok(5) }, { relayMedia: false })]]);
  const list = candidates({ ...base, neighbors, media: true, mediaPolicy: () => "never" });
  assert.deepEqual(list.map(routeKey), ["relay:C"]);
});

test("the load an app reports adds to the relay load figure", () => {
  assert.equal(relayLoad(0, 1000000, false, 0.9), 0.9);
  assert.equal(relayLoad(500000, 1000000, true, 0.1), 0.9);
  assert.equal(relayLoad(0, 0, false), 0);
});

test("encoding parameters combine budget and limits", () => {
  const steps = [[300000, 2], [120000, 4]];
  assert.equal(encodingParams(undefined, null, steps), undefined);
  assert.equal(encodingParams(undefined, {}, steps), undefined);
  assert.deepEqual(encodingParams(1000000, null, steps), { maxBitrate: 1000000, scaleResolutionDownBy: 1 });
  assert.deepEqual(encodingParams(1000000, { maxBitrate: 250000 }, steps), { maxBitrate: 250000, scaleResolutionDownBy: 1 });
  assert.deepEqual(encodingParams(100000, { maxBitrate: 250000, scaleResolutionDownBy: 2 }, steps), { maxBitrate: 100000, scaleResolutionDownBy: 4 });
  assert.deepEqual(encodingParams(undefined, { maxBitrate: 32000 }, steps), { maxBitrate: 32000 });
  assert.deepEqual(encodingParams(undefined, { maxFramerate: 15, scaleResolutionDownBy: 2 }, steps), { scaleResolutionDownBy: 2, maxFramerate: 15 });
});
