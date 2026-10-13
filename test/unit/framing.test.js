import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, decode, rewriteIdx, rewriteLifetime, aad, serial, split, Reassembler, TYPE, FLAG, BASE_HEADER } from "../../src/transport/framing.js";
import { RalFakeClock } from "../../src/util/clock.js";

test("encode/decode base header", () => {
  const payload = new Uint8Array([1, 2, 3]);
  const buf = encode({ version: 1, type: TYPE.DATA, srcIdx: 3, dstIdx: 7, channelId: 513, seq: 0xfffffffe, payload });
  assert.equal(buf.length, BASE_HEADER + 3);
  const e = decode(buf);
  assert.deepEqual([e.version, e.type, e.flags, e.srcIdx, e.dstIdx, e.channelId, e.seq], [1, 0, 0, 3, 7, 513, 0xfffffffe]);
  assert.deepEqual([...e.payload], [1, 2, 3]);
  assert.equal(e.fragCount, undefined);
});

test("fragment and lifetime fields give a 17 byte header", () => {
  const buf = encode({ version: 1, type: 0, flags: FLAG.ENCRYPTED, srcIdx: 0, dstIdx: 1, channelId: 2, seq: 9, fragIndex: 4, fragCount: 5, lifetime: 1234, payload: new Uint8Array(2) });
  assert.equal(buf.length, 17 + 2);
  const e = decode(buf);
  assert.equal(e.flags, FLAG.ENCRYPTED | FLAG.FRAGMENTED | FLAG.LIFETIME);
  assert.deepEqual([e.fragIndex, e.fragCount, e.lifetime], [4, 5, 1234]);
  rewriteIdx(buf, 9, 8);
  rewriteLifetime(buf, 77);
  const f = decode(buf);
  assert.deepEqual([f.srcIdx, f.dstIdx, f.lifetime, f.seq], [9, 8, 77, 9]);
});

test("decode rejects short input", () => {
  assert.equal(decode(new Uint8Array(5)), null);
  const buf = encode({ version: 1, type: 0, srcIdx: 0, dstIdx: 0, channelId: 0, seq: 0, fragIndex: 0, fragCount: 1 });
  assert.equal(decode(buf.subarray(0, 12)), null);
});

test("aad excludes rewritable fields", () => {
  const a = aad({ version: 1, type: 0, channelId: 5, seq: 6 });
  const b = aad({ version: 1, type: 0, channelId: 5, seq: 6, fragIndex: 0, fragCount: 0 });
  assert.deepEqual(a, b);
});

test("serial arithmetic wraps", () => {
  assert.ok(serial.lt(0xffffffff, 0));
  assert.ok(serial.lt(1, 2));
  assert.ok(!serial.lt(2, 1));
  assert.equal(serial.add(0xffffffff, 2), 1);
  assert.equal(serial.diff(0xfffffffe, 1), 3);
});

test("split and reassemble in any order", () => {
  const clock = new RalFakeClock();
  const data = new Uint8Array(1000).map((_, i) => i & 255);
  const parts = split(data, 300);
  assert.equal(parts.length, 4);
  const r = new Reassembler(clock);
  const order = [2, 0, 3, 1];
  let out = null;
  for (const i of order) out = r.add("k", i, parts.length, parts[i]) ?? out;
  assert.deepEqual(out, data);
  assert.equal(r.bytes, 0);
});

test("reassembler drops stale and duplicate fragments", () => {
  const clock = new RalFakeClock();
  const r = new Reassembler(clock, 1000);
  assert.equal(r.add("a", 0, 2, new Uint8Array(5)), null);
  assert.equal(r.add("a", 0, 2, new Uint8Array(5)), null);
  assert.equal(r.bytes, 5);
  clock.advance(2000);
  assert.equal(r.add("b", 0, 2, new Uint8Array(1)), null);
  assert.equal(r.bytes, 1);
  assert.equal(r.add("a", 1, 2, new Uint8Array(5)), null);
});
