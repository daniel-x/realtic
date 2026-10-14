// forwardLog against the log endpoints of both reference servers: entries of all peers of a group
// in one file, microsecond timestamps. The PHP part is skipped when no PHP binary is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardLog } from "../../src/diag/log-forward.js";
import { RalLog } from "../../src/diag/log.js";
import { RalFakeClock, realClock } from "../../src/util/clock.js";
import { createSignalingServer } from "../../server/node/server.js";
import { createPhpServer } from "../integration/support/php-server.js";

const php = process.env.REALTIC_PHP ?? "php";
const hasPhp = spawnSync(php, ["-v"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "realtic-logs-"));
const US = "\\d{4}-\\d\\d-\\d\\d_\\d\\d-\\d\\d-\\d\\d\\.\\d{6}";
let node;
let plain;
let phpServer;

before(async () => {
  node = await createSignalingServer({ logDir: join(dir, "node"), static: false });
  plain = await createSignalingServer({ static: false });
  if (hasPhp) phpServer = await createPhpServer({ workers: 2, clientLogDir: join(dir, "php") });
});
after(async () => {
  await node.close();
  await plain.close();
  await phpServer?.close();
  rmSync(dir, { recursive: true, force: true });
});

function peer(selfId) {
  const clock = new RalFakeClock(Date.UTC(2026, 9, 13, 12, 0, 0));
  return { selfId, clock, log: new RalLog({ clock }) };
}

async function twoPeersOneFile(url, file) {
  const a = peer("A");
  const b = peer("B");
  a.clock.advance(1.789);
  a.log.write("info", "direct", "state connected -> slow", { reason: "test" }, { peer: "B", session: "s1" });
  const stopA = forwardLog(a, { url, group: "g1", intervalMs: 50 });
  const stopB = forwardLog(b, { url, group: "g1", intervalMs: 50 });
  b.log.write("debug", "signaling", "two\nlines");
  await new Promise((r) => setTimeout(r, 200));
  a.log.write("warn", "direct", "later");
  await stopA();
  await stopB();
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 3, lines.join("\n"));
  for (const line of lines) assert.match(line, new RegExp(`^${US} ${US} [AB] #\\d+ `));
  const first = lines.find((l) => l.includes(" A #1 "));
  assert.ok(first.includes(" 2026-10-13_12-00-00.001789 A #1 INFO  [direct] peer=B s=s1 state connected -> slow {\"reason\":\"test\"}"), first);
  assert.ok(lines.some((l) => l.endsWith(" B #1 DEBUG [signaling] two lines")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes(" A #2 WARN  [direct] later")), lines.join("\n"));
}

test("realClock.wallNow follows Date.now with sub-millisecond resolution", () => {
  for (let i = 0; i < 100; i++) assert.ok(Math.abs(realClock.wallNow() - Date.now()) <= 2);
});

test("Node server: entries of all peers of a group in one file", async () => {
  await twoPeersOneFile(`http://127.0.0.1:${node.port}/log`, join(dir, "node", "g1.log"));
});

test("Node server without a log directory refuses forwarded logs", async () => {
  const res = await fetch(`http://127.0.0.1:${plain.port}/log?group=g&id=A`, { method: "POST", body: '{"entries":[]}' });
  assert.equal(res.status, 404);
});

test("PHP server: entries of all peers of a group in one file", { skip: !hasPhp && "no PHP" }, async () => {
  await twoPeersOneFile(phpServer.logUrl, join(dir, "php", "g1.log"));
});

test("a failed request is sent again", async () => {
  const a = peer("R");
  a.log.write("info", "x", "kept");
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => (++calls === 1 ? Promise.reject(new Error("offline")) : realFetch(...args));
  try {
    const stop = forwardLog(a, { url: `http://127.0.0.1:${node.port}/log`, group: "g2", intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 150));
    await stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(calls >= 2);
  const lines = readFileSync(join(dir, "node", "g2.log"), "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith(" R #1 INFO  [x] kept"));
});
