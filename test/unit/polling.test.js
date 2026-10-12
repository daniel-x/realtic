// PollingSignaling against the PHP reference server. Skipped when no PHP binary is available.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { PollingSignaling } from "../../src/signaling/polling.js";
import { createSignaling } from "../../src/signaling/create.js";
import { WebSocketSignaling } from "../../src/signaling/websocket.js";
import { createPhpServer } from "../integration/harness/php-server.js";

const php = process.env.REALTIC_PHP ?? "php";
const hasPhp = spawnSync(php, ["-v"]).status === 0;
let server;
const open = [];

before(async () => {
  if (hasPhp) server = await createPhpServer({ workers: 4 });
});
after(async () => {
  for (const a of open) a.close();
  await server?.close();
});

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function client(id, group) {
  const a = new PollingSignaling(server.url, id, { group, fastMs: 50, idleMs: 200 });
  a.got = [];
  a.presence = [];
  a.onmessage = (from, msg) => a.got.push({ from, msg });
  a.onpresence = (e) => a.presence.push(`${e.type}:${e.peer}`);
  open.push(a);
  return a;
}

test("createSignaling picks the adapter from the URL", () => {
  const ws = createSignaling({ url: "ws://localhost:1/signal", group: "r" }, "A");
  assert.ok(ws instanceof WebSocketSignaling);
  ws.close();
  const p = createSignaling({ url: "http://localhost:1/signal.php" }, "A");
  assert.ok(p instanceof PollingSignaling);
  p.close();
  assert.throws(() => createSignaling({ url: "x", type: "carrier-pigeon" }, "A"), TypeError);
});

test("presence, at most once delivery, leave", { skip: !hasPhp && "no PHP" }, async () => {
  const a = client("A", "r1");
  const b = client("B", "r1");
  await until(() => a.presence.includes("join:B") && b.presence.includes("join:A"));
  a.send("B", { t: "offer", n: 1 });
  a.send("B", { t: "cand", n: 2 });
  await until(() => b.got.length === 2);
  assert.deepEqual(b.got.map((m) => m.msg.n), [1, 2]);
  assert.equal(b.got[0].from, "A");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(b.got.length, 2);
  b.close();
  await until(() => a.presence.includes("leave:B"));
});

test("server down: connected goes false and recovers", { skip: !hasPhp && "no PHP" }, async () => {
  const a = client("C", "r2");
  const states = [];
  a.onstatus = (ok) => states.push(ok);
  await until(() => states.includes(true));
  server.setDown(true);
  await until(() => !a.connected);
  assert.throws(() => a.send("X", { t: "cand" }));
  server.setDown(false);
  await until(() => a.connected, 8000);
  assert.deepEqual(states, [true, false, true]);
});

test("messages to non-members are dropped, bad ids rejected", { skip: !hasPhp && "no PHP" }, async () => {
  const response = await fetch(`${server.url}?group=r3&id=${encodeURIComponent("bad id")}`, { method: "POST", body: "{}" });
  assert.equal(response.status, 400);
  const a = client("E", "r3");
  await until(() => a.presence.length === 0 && a.connected);
  a.send("nobody", { t: "cand" });
  const b = client("nobody", "r3");
  await until(() => b.presence.includes("join:E"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.got.length, 0);
});

test("a poll that arrives after leave does not add the client back", { skip: !hasPhp && "no PHP" }, async () => {
  const post = (id, body) => fetch(`${server.url}?group=r4&id=${id}`, { method: "POST", body: JSON.stringify(body) });
  await post("F", {});
  await post("G", {});
  assert.equal((await post("F", { leave: true })).status, 200);
  assert.equal((await post("F", {})).status, 410);
  assert.deepEqual((await (await post("G", {})).json()).members, ["G"]);
});
