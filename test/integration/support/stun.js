// Test STUN server (plan section 14.3): answers only binding requests (RFC 8489) with an address
// the test sets, so a test can simulate a new public address after a network change.
import dgram from "node:dgram";

const MAGIC = 0x2112a442;

export class TestStunServer {
  /** Address reported in XOR-MAPPED-ADDRESS; port is the request's source port. */
  reportAddress = "203.0.113.1";
  requests = 0;

  async start(host = "127.0.0.1") {
    this.socket = dgram.createSocket("udp4");
    this.socket.on("message", (msg, rinfo) => this.#onMessage(msg, rinfo));
    await new Promise((resolve) => this.socket.bind(0, host, resolve));
    this.port = this.socket.address().port;
    this.url = `stun:${host}:${this.port}`;
    return this;
  }

  #onMessage(msg, rinfo) {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001 || msg.readUInt32BE(4) !== MAGIC) return;
    this.requests++;
    const txid = msg.subarray(8, 20);
    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(0x0020, 0);
    attr.writeUInt16BE(8, 2);
    attr.writeUInt8(0, 4);
    attr.writeUInt8(0x01, 5);
    attr.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 6);
    const ip = this.reportAddress.split(".").map(Number);
    const ipInt = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
    attr.writeUInt32BE((ipInt ^ MAGIC) >>> 0, 8);
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0);
    header.writeUInt16BE(attr.length, 2);
    header.writeUInt32BE(MAGIC, 4);
    txid.copy(header, 8);
    this.socket.send(Buffer.concat([header, attr]), rinfo.port, rinfo.address);
  }

  stop() {
    this.socket?.close();
  }
}
