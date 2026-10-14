// RalWebSocketSignaling.resume(): make before break with a fake WebSocket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RalWebSocketSignaling } from "../../src/signaling/websocket.js";

function fakeSockets() {
  const sockets = [];
  class FakeWebSocket {
    readyState = 0;
    sent = [];
    constructor(url) {
      this.url = url;
      sockets.push(this);
    }
    send(frame) {
      if (this.readyState !== 1) throw new Error("not open");
      this.sent.push(JSON.parse(frame).msg.n);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
  }
  return { sockets, FakeWebSocket };
}

function adapter() {
  const { sockets, FakeWebSocket } = fakeSockets();
  const a = new RalWebSocketSignaling("ws://x/signal", "A", { WebSocket: FakeWebSocket });
  const status = [];
  a.onstatus = (up) => status.push(up);
  sockets[0].open();
  return { a, sockets, status };
}

test("resume queues messages until the new socket opens, then closes the old one", () => {
  const { a, sockets, status } = adapter();
  a.send("B", { n: 1 });
  a.resume();
  assert.equal(sockets.length, 2);
  assert.ok(a.connected);
  a.send("B", { n: 2 });
  a.send("B", { n: 3 });
  sockets[1].open();
  assert.deepEqual(sockets[0].sent, [1]);
  assert.deepEqual(sockets[1].sent, [2, 3]);
  assert.equal(sockets[0].readyState, 3);
  a.send("B", { n: 4 });
  assert.deepEqual(sockets[1].sent, [2, 3, 4]);
  assert.deepEqual(status, [true]);
  a.close();
});

test("the server closing the old socket before the new one opens loses nothing", () => {
  const { a, sockets, status } = adapter();
  a.resume();
  a.send("B", { n: 1 });
  sockets[0].close();
  assert.ok(a.connected);
  a.send("B", { n: 2 });
  sockets[1].open();
  assert.deepEqual(sockets[1].sent, [1, 2]);
  assert.deepEqual(status, [true]);
  a.close();
});

test("a later close of the new socket reconnects", async () => {
  const { a, sockets, status } = adapter();
  a.resume();
  sockets[1].open();
  sockets[1].close();
  assert.deepEqual(status, [true, false]);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sockets.length, 3);
  a.close();
});

test("a failed replacement keeps the old socket, or reconnects when that is gone too", async () => {
  const { a, sockets } = adapter();
  a.resume();
  a.send("B", { n: 1 });
  sockets[1].close();
  a.send("B", { n: 2 });
  assert.deepEqual(sockets[0].sent, [2]);
  a.resume();
  sockets[0].close();
  sockets[2].close();
  assert.equal(a.connected, false);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sockets.length, 4);
  a.close();
});
