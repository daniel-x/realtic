import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../../src/util/clock.js";
import { Emitter } from "../../src/util/emitter.js";

test("fake clock runs timers in order", () => {
  const c = new FakeClock();
  const seen = [];
  c.setTimeout(() => seen.push("b"), 20);
  c.setTimeout(() => seen.push("a"), 10);
  const id = c.setInterval(() => seen.push("i"), 15);
  c.advance(31);
  assert.deepEqual(seen, ["a", "i", "b", "i"]);
  c.clearInterval(id);
  c.advance(100);
  assert.equal(seen.length, 4);
  assert.equal(c.now(), 131);
});

test("emitter once and off", () => {
  const e = new Emitter();
  let n = 0;
  e.once("x", () => n++);
  e.emit("x");
  e.emit("x");
  assert.equal(n, 1);
});
