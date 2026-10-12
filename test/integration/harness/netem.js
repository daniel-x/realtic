// User space UDP proxy between browsers (plan section 14.3). A test-only signaling hook rewrites
// every host candidate so that each directed peer pair talks through its own proxy sockets; TCP,
// IPv6 and server reflexive candidates are dropped so no traffic bypasses the proxy. Relay (TURN)
// candidates pass unchanged.
//
// Per directed pair the test controls: down, loss, delay, jitter, bandwidth, reordering, and
// dropping by packet class (STUN, DTLS, RTP by the first byte, RFC 7983). `rebind` moves a
// peer's endpoints to new ports, like a NAT rebinding.
import dgram from "node:dgram";

/** Packet class by first byte (RFC 7983). */
export function packetClass(buf) {
  const b = buf[0];
  if (b <= 3) return "stun";
  if (b >= 20 && b <= 63) return "dtls";
  if (b >= 128 && b <= 191) return "rtp";
  return "other";
}

const DEFAULT_RULE = { down: false, loss: 0, delay: 0, jitter: 0, bandwidth: 0, reorder: 0, drop: [] };

export class NetemProxy {
  /** key `${owner}>${viewer}>${addr}:${port}` -> endpoint */
  #endpoints = new Map();
  #rules = new Map();
  #buckets = new Map();
  events = [];
  counters = new Map();

  async start() {}

  #log(text) {
    this.events.push(`${new Date().toISOString()} ${text}`);
    if (this.events.length > 20000) this.events.splice(0, 10000);
  }

  /** Sets (merges) the rule for packets travelling from `from` to `to`. */
  setRule(from, to, rule) {
    const key = `${from}>${to}`;
    const merged = { ...DEFAULT_RULE, ...(this.#rules.get(key) ?? {}), ...rule };
    this.#rules.set(key, merged);
    this.#log(`rule ${key} ${JSON.stringify(rule)}`);
  }

  /** Resets the rule of a directed pair. */
  clearRule(from, to) {
    this.#rules.delete(`${from}>${to}`);
  }

  rule(from, to) {
    return this.#rules.get(`${from}>${to}`) ?? DEFAULT_RULE;
  }

  /** Packets forwarded from -> to, by class. */
  count(from, to) {
    return this.counters.get(`${from}>${to}`) ?? { stun: 0, dtls: 0, rtp: 0, other: 0, dropped: 0 };
  }

  async #endpoint(owner, viewer, address, port) {
    const key = `${owner}>${viewer}>${address}:${port}`;
    let ep = this.#endpoints.get(key);
    if (ep) return ep;
    ep = { owner, viewer, real: { address, port }, socket: null, port: 0, key };
    this.#endpoints.set(key, ep);
    await this.#bind(ep);
    return ep;
  }

  async #bind(ep) {
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => this.#onPacket(ep, socket, msg, rinfo));
    socket.on("error", () => {});
    await new Promise((resolve) => socket.bind(0, ep.real.address, resolve));
    ep.socket = socket;
    ep.port = socket.address().port;
  }

  async #onPacket(ep, socket, msg, rinfo) {
    if (socket !== ep.socket) return;
    // A packet from the viewer's real socket rinfo, travelling viewer -> owner.
    const back = await this.#endpoint(ep.viewer, ep.owner, rinfo.address, rinfo.port);
    const from = ep.viewer;
    const to = ep.owner;
    const cls = packetClass(msg);
    const counterKey = `${from}>${to}`;
    let c = this.counters.get(counterKey);
    if (!c) this.counters.set(counterKey, (c = { stun: 0, dtls: 0, rtp: 0, other: 0, dropped: 0 }));
    const rule = this.rule(from, to);
    if (rule.down || rule.drop.includes(cls) || (rule.loss && Math.random() < rule.loss) || !this.#bandwidthOk(counterKey, rule, msg.length)) {
      c.dropped++;
      return;
    }
    c[cls]++;
    let delay = rule.delay + (rule.jitter ? Math.random() * rule.jitter : 0);
    if (rule.reorder && Math.random() < rule.reorder) delay += 20 + Math.random() * 30;
    const send = () => back.socket?.send(msg, ep.real.port, ep.real.address, () => {});
    if (delay > 0) setTimeout(send, delay);
    else send();
  }

  #bandwidthOk(key, rule, size) {
    if (!rule.bandwidth) return true;
    const now = Date.now();
    let b = this.#buckets.get(key);
    const capacity = (rule.bandwidth / 8) * 0.1;
    if (!b) this.#buckets.set(key, (b = { tokens: capacity, at: now }));
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * (rule.bandwidth / 8));
    b.at = now;
    if (b.tokens < size) return false;
    b.tokens -= size;
    return true;
  }

  /** Moves all endpoints owned by `owner` (towards `viewer`, or all viewers) to new ports. */
  async rebind(owner, viewer) {
    for (const ep of this.#endpoints.values()) {
      if (ep.owner !== owner || (viewer && ep.viewer !== viewer)) continue;
      const old = ep.socket;
      await this.#bind(ep);
      old.close();
      this.#log(`rebind ${ep.key} -> ${ep.port}`);
    }
  }

  async #rewriteCandidate(from, to, line) {
    const prefix = line.startsWith("a=") ? "a=" : "";
    const body = prefix ? line.slice(2) : line;
    const parts = body.split(" ");
    if (parts.length < 8) return line;
    const protocol = parts[2].toLowerCase();
    const address = parts[4];
    const port = Number(parts[5]);
    const type = parts[7];
    if (type === "relay") return line;
    if (protocol !== "udp" || type !== "host" || address.includes(":") || address.endsWith(".local")) return null;
    const ep = await this.#endpoint(from, to, address, port);
    parts[5] = String(ep.port);
    this.#log(`candidate ${from}>${to} ${address}:${port} -> ${address}:${ep.port}`);
    return prefix + parts.join(" ");
  }

  /** Signaling hook: rewrites candidates in `cand` messages and SDP. */
  async rewrite(from, to, msg) {
    if (msg.t === "cand") {
      const out = [];
      for (const c of msg.c ?? []) {
        if (!c.candidate) {
          out.push(c);
          continue;
        }
        const r = await this.#rewriteCandidate(from, to, c.candidate);
        if (r) out.push({ ...c, candidate: r });
      }
      return { ...msg, c: out };
    }
    if ((msg.t === "offer" || msg.t === "answer") && msg.sdp) {
      const lines = msg.sdp.split("\r\n");
      const out = [];
      for (const line of lines) {
        if (line.startsWith("a=candidate:")) {
          const r = await this.#rewriteCandidate(from, to, line);
          if (r) out.push(r);
        } else out.push(line);
      }
      return { ...msg, sdp: out.join("\r\n") };
    }
    return msg;
  }

  async stop() {
    for (const ep of this.#endpoints.values()) ep.socket?.close();
    this.#endpoints.clear();
  }
}
