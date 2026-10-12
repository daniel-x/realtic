import { test } from "node:test";
import assert from "node:assert/strict";
import { StableStreams } from "../../src/media/stable-stream.js";
import { wants } from "../../src/media/subscriptions.js";

class FakeStream {
  tracks = [];
  addTrack(t) { this.tracks.push(t); }
  removeTrack(t) { this.tracks = this.tracks.filter((x) => x !== t); }
}

test("stream survives a source switch; add before remove", () => {
  const events = [];
  let preferred = "A";
  const s = new StableStreams({ preferredSource: () => preferred, emit: (o, ev, d) => events.push([ev, d.track]), createStream: () => new FakeStream() });
  const info = { origin: "A", pub: "p1", tag: "camera", kind: "video" };
  s.attach(info, "A", "tA");
  assert.deepEqual(events, [["track", "tA"]]);
  s.attach(info, "C", "tC");
  assert.equal(events.length, 1);
  preferred = "C";
  s.reselect("A");
  assert.deepEqual(events[1], ["trackreplaced", "tC"]);
  s.detach("A", "p1", "A");
  s.detach("A", "p1", "C");
  assert.deepEqual(events[2], ["trackended", "tC"]);
});

test("subscription matching", () => {
  assert.ok(wants(undefined, "video", "x"));
  assert.ok(!wants({ video: false }, "video", "x"));
  assert.ok(wants({ video: false }, "audio", "x"));
  assert.ok(!wants({ tags: ["screen"] }, "video", "camera"));
});
