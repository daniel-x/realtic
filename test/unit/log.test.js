import { test } from "node:test";
import assert from "node:assert/strict";
import { RalLog, formatTime, redactText } from "../../src/diag/log.js";
import { RalFakeClock } from "../../src/util/clock.js";

test("ring buffer overwrites oldest and seq shows the gap", () => {
  const log = new RalLog({ capacity: 4, clock: new RalFakeClock() });
  for (let i = 0; i < 6; i++) log.write("info", "link", `m${i}`);
  const e = log.entries();
  assert.deepEqual(e.map((x) => x.seq), [3, 4, 5, 6]);
  assert.deepEqual(log.entries({ since: 4 }).map((x) => x.msg), ["m4", "m5"]);
});

test("level filter applies to entry event, buffer keeps all", () => {
  const log = new RalLog({ capacity: 10, level: "warn" });
  const seen = [];
  log.on("entry", (e) => seen.push(e.level));
  log.write("debug", "x", "a");
  log.write("error", "x", "b");
  assert.deepEqual(seen, ["error"]);
  assert.equal(log.entries().length, 2);
  assert.equal(log.entries({ level: "warn" }).length, 1);
});

test("text uses UTC timestamps", () => {
  assert.equal(formatTime(Date.UTC(2026, 9, 12, 3, 4, 5, 6)), "2026-10-12_03-04-05.006000");
  assert.equal(formatTime(Date.UTC(2026, 9, 12, 3, 4, 5, 6) + 0.789), "2026-10-12_03-04-05.006789");
  assert.equal(formatTime(Date.UTC(2026, 9, 12, 3, 4, 5, 999) + 0.9999), "2026-10-12_03-04-06.000000");
  const log = new RalLog({ clock: new RalFakeClock(Date.UTC(2026, 0, 1)) });
  log.write("info", "link", "hi", { a: 1 }, { peer: "p1" });
  assert.equal(log.text(), '2026-01-01_00-00-00.000000 INFO  [link] peer=p1 hi {"a":1}');
});

test("data is capped and unserializable data does not throw", () => {
  const log = new RalLog();
  log.write("info", "x", "big", { s: "x".repeat(10000) });
  assert.equal(log.entries()[0].data.truncated, true);
  const cyclic = {};
  cyclic.self = cyclic;
  log.write("info", "x", "cyclic", cyclic);
  assert.ok(log.entries()[1].data.unserializable);
});

test("redaction gives stable placeholders", () => {
  const t = new Map();
  assert.equal(redactText("a 10.0.0.1 b 10.0.0.2 c 10.0.0.1", t), "a ip1 b ip2 c ip1");
  const log = new RalLog({ redact: true });
  log.write("info", "x", "cand 192.168.1.5:5000", { ip: "fe80::1:2:3" });
  const e = log.entries()[0];
  assert.equal(e.msg, "cand ip1:5000");
  assert.equal(e.data.ip, "ip2");
});

test("listener errors do not escape", () => {
  const log = new RalLog();
  log.on("entry", () => { throw new Error("boom"); });
  log.write("info", "x", "ok");
  assert.equal(log.entries().length, 1);
});
