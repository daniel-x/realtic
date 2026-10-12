import { Emitter } from "../util/emitter.js";
import { realClock } from "../util/clock.js";

/** Log levels in ascending order. */
export const LEVELS = ["debug", "info", "warn", "error"];

const MAX_DATA_CHARS = 2048;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?<![\w:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

/**
 * Replaces IP addresses in a string with stable placeholders from `table`.
 * @param {string} text
 * @param {Map<string, string>} table
 */
export function redactText(text, table) {
  const sub = (ip) => {
    if (!table.has(ip)) table.set(ip, `ip${table.size + 1}`);
    return table.get(ip);
  };
  const sub6 = (ip) => (ip.includes("::") || ip.split(":").length === 8 ? sub(ip) : ip);
  return text.replace(IPV4, sub).replace(IPV6, sub6);
}

/** Formats UTC milliseconds as `yyyy-MM-dd_HH-mm-ss.SSS` (doc §5). */
export function formatTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_` +
    `${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`
  );
}

function capData(data) {
  if (data === undefined) return undefined;
  let json;
  try {
    json = JSON.stringify(data, (_, v) => (typeof v === "bigint" ? String(v) : v));
  } catch {
    return { unserializable: String(data) };
  }
  if (json === undefined) return undefined;
  if (json.length <= MAX_DATA_CHARS) return JSON.parse(json);
  return { truncated: true, size: json.length, head: json.slice(0, MAX_DATA_CHARS) };
}

/**
 * Ring buffer logger (section 12.1). Records all levels; `level` filters only the `entry` event
 * and the console mirror. Never throws.
 */
export class Log extends Emitter {
  #buffer;
  #next = 0;
  #count = 0;
  #seq = 0;
  #clock;
  #redactTable = new Map();

  /**
   * @param {object} [options]
   * @param {number} [options.capacity]
   * @param {string} [options.level]
   * @param {boolean} [options.console]
   * @param {boolean} [options.redact]
   * @param {import("../util/clock.js").Clock} [options.clock]
   */
  constructor({ capacity = 1024, level = "info", console: mirror = false, redact = false, clock = realClock } = {}) {
    super();
    this.#buffer = new Array(capacity);
    this.#clock = clock;
    this.level = level;
    this.mirror = mirror;
    this.redact = redact;
  }

  /** Buffer capacity. */
  get capacity() {
    return this.#buffer.length;
  }

  /**
   * Writes one entry.
   * @param {"debug"|"info"|"warn"|"error"} level
   * @param {string} area
   * @param {string} msg
   * @param {object} [data]
   * @param {{peer?: string, session?: string}} [ids]
   */
  write(level, area, msg, data, ids = {}) {
    try {
      let entry = {
        seq: ++this.#seq,
        time: this.#clock.wallNow(),
        level,
        area,
        peer: ids.peer,
        session: ids.session,
        msg: String(msg),
        data: capData(data),
      };
      if (this.redact) entry = this.#redactEntry(entry);
      this.#buffer[this.#next] = entry;
      this.#next = (this.#next + 1) % this.#buffer.length;
      this.#count = Math.min(this.#count + 1, this.#buffer.length);
      if (LEVELS.indexOf(level) >= LEVELS.indexOf(this.level)) {
        if (this.mirror) globalThis.console?.[level === "debug" ? "log" : level]?.(Log.line(entry));
        this.emit("entry", entry);
      }
    } catch {
      // logging never throws and never logs its own failures
    }
  }

  /**
   * Returns a scoped writer with fixed area and ids.
   * @param {string} area
   * @param {{peer?: string, session?: string}} [ids]
   */
  scope(area, ids = {}) {
    const write = (level) => (msg, data) => this.write(level, area, msg, data, ids);
    return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"), ids };
  }

  /**
   * Copy of buffered entries, oldest first.
   * @param {{since?: number, level?: string}} [filter]
   */
  entries({ since = 0, level = "debug" } = {}) {
    const min = LEVELS.indexOf(level);
    const out = [];
    const start = (this.#next - this.#count + this.#buffer.length) % this.#buffer.length;
    for (let i = 0; i < this.#count; i++) {
      const e = this.#buffer[(start + i) % this.#buffer.length];
      if (e.seq > since && LEVELS.indexOf(e.level) >= min) out.push(structuredCloneSafe(e));
    }
    return out;
  }

  /** The buffered entries as readable lines. Timestamps are UTC. */
  text(filter) {
    return this.entries(filter).map(Log.line).join("\n");
  }

  /** Empties the buffer; `seq` keeps counting. */
  clear() {
    this.#buffer.fill(undefined);
    this.#count = 0;
    this.#next = 0;
  }

  /** Redacts a string with this log's placeholder table. */
  redactString(text) {
    return redactText(text, this.#redactTable);
  }

  #redactEntry(entry) {
    return JSON.parse(this.redactString(JSON.stringify(entry)));
  }

  /** Formats one entry as a line. */
  static line(e) {
    const ids = [e.peer && `peer=${e.peer}`, e.session && `s=${e.session}`].filter(Boolean).join(" ");
    const data = e.data === undefined ? "" : ` ${JSON.stringify(e.data)}`;
    return `${formatTime(e.time)} ${e.level.toUpperCase().padEnd(5)} [${e.area}]${ids ? " " + ids : ""} ${e.msg}${data}`;
  }
}

function structuredCloneSafe(e) {
  return { ...e, data: e.data === undefined ? undefined : JSON.parse(JSON.stringify(e.data)) };
}
