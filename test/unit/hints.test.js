import { test } from "node:test";
import assert from "node:assert/strict";
import { failureHint } from "../../src/diag/hints.js";
import { pairDump } from "../../src/diag/pair-dump.js";

const c = (type, address, port, extra = {}) => ({ type, address, port, protocol: "udp", mdns: address.endsWith(".local"), ...extra });

test("local network permission pattern", () => {
  const dump = {
    localCandidates: [c("host", "192.168.1.2", 1), c("srflx", "1.2.3.4", 2)],
    remoteCandidates: [c("host", "192.168.1.3", 1), c("srflx", "1.2.3.4", 3)],
    pairs: [{ state: "failed", responsesReceived: 0, local: c("host", "192.168.1.2", 1), remote: c("host", "192.168.1.3", 1) }],
  };
  assert.equal(failureHint(dump), "local-network-permission");
});

test("mdns pattern", () => {
  const dump = {
    localCandidates: [c("host", "192.168.1.2", 1)],
    remoteCandidates: [c("host", "abc.local", 1)],
    pairs: [],
  };
  assert.equal(failureHint(dump), "mdns-unresolved");
});

test("symmetric nat pattern", () => {
  const dump = {
    localCandidates: [c("srflx", "5.5.5.5", 1000, { url: "stun:a" }), c("srflx", "5.5.5.5", 1001, { url: "stun:b" })],
    remoteCandidates: [c("srflx", "6.6.6.6", 7)],
    pairs: [{ state: "failed", responsesReceived: 0, local: c("srflx", "5.5.5.5", 1000), remote: c("srflx", "6.6.6.6", 7) }],
  };
  assert.equal(failureHint(dump), "symmetric-nat");
});

test("pair dump marks missing counters unknown", () => {
  const stats = new Map([
    ["t", { id: "t", type: "transport", selectedCandidatePairId: "p" }],
    ["p", { id: "p", type: "candidate-pair", state: "succeeded", localCandidateId: "l", remoteCandidateId: "r", responsesReceived: 3 }],
    ["l", { id: "l", type: "local-candidate", candidateType: "host", address: "10.0.0.1", port: 5, protocol: "udp" }],
    ["r", { id: "r", type: "remote-candidate", candidateType: "srflx", address: "x.local", port: 6, protocol: "udp" }],
  ]);
  const d = pairDump(stats, true);
  assert.equal(d.selected.requestsSent, "unknown");
  assert.equal(d.selected.responsesReceived, 3);
  assert.equal(d.selected.remote.mdns, true);
  assert.equal(d.pairs.length, 1);
});
