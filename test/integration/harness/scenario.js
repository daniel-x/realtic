// Scenario helper: one signaling server, N peers in pages of chosen browsers, optional netem
// proxy between every directed pair, and helpers for waiting and assertions.
import { createSignalingServer } from "../../../examples/server/server.js";
import { openPage, closeBrowsers, dedicatedBrowser } from "./browsers.js";
import { NetemProxy } from "./netem.js";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ARTIFACTS = fileURLToPath(new URL("../../../test-results/", import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `fn` until it returns a truthy value or the timeout expires.
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {number} timeoutMs
 * @param {string} what
 */
export async function waitFor(fn, timeoutMs, what = "condition") {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** Browser pairings of section 14.2. */
export const PAIRINGS = {
  chromium: ["chromium", "chromium", "chromium", "chromium", "chromium", "chromium", "chromium", "chromium"],
  firefox: ["firefox", "firefox", "firefox", "firefox", "firefox", "firefox", "firefox", "firefox"],
  mixed: ["chromium", "firefox", "chromium", "firefox", "chromium", "firefox", "chromium", "firefox"],
};

/** Pairing names to run, from REALTIC_PAIRINGS (comma separated) or all three. */
export function pairings() {
  return (process.env.REALTIC_PAIRINGS ?? "chromium,firefox,mixed").split(",").filter(Boolean);
}

export class Scenario {
  /** @type {Map<string, import("playwright").Page>} */
  pages = new Map();
  ids = [];

  /**
   * @param {object} options
   * @param {string[]} options.browsers browser per peer
   * @param {boolean} [options.proxy] route all ICE traffic through the netem proxy
   * @param {object} [options.config] library config for every peer
   * @param {Record<string, object>} [options.peerConfig] per peer config overrides
   * @param {RTCIceServer[]} [options.iceServers]
   * @param {string} [options.name] used for failure artifacts
   */
  constructor({ browsers, proxy = true, config = {}, peerConfig = {}, iceServers = [], name = "scenario", dedicated = [] }) {
    this.browsers = browsers;
    this.dedicated = dedicated;
    this.ownBrowsers = new Map();
    this.useProxy = proxy;
    this.config = config;
    this.peerConfig = peerConfig;
    this.iceServers = iceServers;
    this.name = name;
  }

  async start() {
    this.server = await createSignalingServer({});
    this.base = `http://localhost:${this.server.port}`;
    if (this.useProxy) {
      this.proxy = new NetemProxy();
      await this.proxy.start();
    }
    const letters = "ABCDEFGHIJKLMNOP";
    for (let i = 0; i < this.browsers.length; i++) {
      const id = `${letters[i]}${Math.random().toString(36).slice(2, 6)}`;
      let own;
      if (this.dedicated.includes(i)) {
        own = await dedicatedBrowser(this.browsers[i]);
        this.ownBrowsers.set(id, own);
      }
      await this.openPeer(id, this.browsers[i], {}, own);
    }
    return this;
  }

  /** Opens one peer page and starts its group. */
  async openPeer(id, browser, extraConfig = {}, own) {
    const page = await openPage(browser, `${this.base}/test/integration/pages/peer.html`, own);
    if (this.proxy) await page.exposeFunction("__outgoingSignal", (to, msg) => this.proxy.rewrite(id, to, msg));
    await page.waitForFunction(() => window.t?.ready);
    await page.evaluate((o) => window.t.start(o), {
      id,
      signalingUrl: this.server.url,
      config: { ...this.config, ...(this.peerConfig[id] ?? {}), ...(this.peerConfig[this.ids.length] ?? {}), ...extraConfig },
      iceServers: this.iceServers,
      hooks: !!this.proxy,
    });
    page.browserName = browser;
    this.pages.set(id, page);
    if (!this.ids.includes(id)) this.ids.push(id);
    return page;
  }

  /** The page of peer index or id. */
  page(p) {
    return this.pages.get(typeof p === "number" ? this.ids[p] : p);
  }

  id(i) {
    return this.ids[i];
  }

  /** Runs `fn(arg)` in a peer page. */
  eval(p, fn, arg) {
    return this.page(p).evaluate(fn, arg);
  }

  /** Adds every peer to every other (full mesh membership). */
  async meshAll(ids = this.ids) {
    for (const a of ids) for (const b of ids) if (a !== b) await this.eval(a, (x) => window.t.addPeer(x), b);
  }

  /** Waits until peer `a` sees `b` in one of the states. */
  async waitState(a, b, states, timeoutMs = 20000) {
    const ia = typeof a === "number" ? this.ids[a] : a;
    const ib = typeof b === "number" ? this.ids[b] : b;
    const want = [].concat(states);
    return waitFor(async () => {
      const s = await this.eval(ia, (x) => window.t.state(x), ib);
      return want.includes(s) ? s : false;
    }, timeoutMs, `${ia} sees ${ib} in ${want.join("|")}`);
  }

  /** Waits until all pairs are connected. */
  async waitAllConnected(timeoutMs = 30000, ids = this.ids) {
    for (const a of ids) for (const b of ids) if (a !== b) await this.waitState(a, b, "connected", timeoutMs);
  }

  /** Index of an id. */
  index(id) {
    return this.ids.indexOf(id);
  }

  /** Blocks or unblocks the path between two peers in both directions. */
  block(a, b, blocked = true) {
    this.proxy.setRule(this.#id(a), this.#id(b), { down: blocked });
    this.proxy.setRule(this.#id(b), this.#id(a), { down: blocked });
  }

  /** Sets netem rules for the directed path a -> b. */
  rule(a, b, rule) {
    this.proxy.setRule(this.#id(a), this.#id(b), rule);
  }

  #id(p) {
    return typeof p === "number" ? this.ids[p] : p;
  }

  /** Saves logs of every peer and the proxy event log under test-results/<name>/. */
  async saveArtifacts(label = this.name) {
    const dir = `${ARTIFACTS}${label.replace(/[^\w.-]+/g, "_")}/`;
    await mkdir(dir, { recursive: true });
    for (const [id, page] of this.pages) {
      try {
        const report = await page.evaluate(() => window.t.report());
        await writeFile(`${dir}${id}.json`, JSON.stringify(report, null, 1));
        await writeFile(`${dir}${id}.log`, await page.evaluate(() => window.t.logText()));
      } catch (e) {
        await writeFile(`${dir}${id}.error`, String(e));
      }
    }
    if (this.proxy) await writeFile(`${dir}proxy.log`, this.proxy.events.join("\n"));
    return dir;
  }

  /** Closes one peer's page (no unload handlers when `runUnload` is false). */
  async closePeer(p, runUnload = true) {
    const id = this.#id(p);
    const page = this.pages.get(id);
    this.pages.delete(id);
    await page.close({ runBeforeUnload: runUnload });
    await page.context().close().catch(() => {});
  }

  /** Kills the browser process of a peer opened with `dedicated`. */
  killBrowser(p) {
    const id = this.#id(p);
    this.ownBrowsers.get(id)?.server.process().kill("SIGKILL");
    this.ownBrowsers.delete(id);
    this.pages.delete(id);
  }

  async stop() {
    for (const page of this.pages.values()) await page.context().close().catch(() => {});
    this.pages.clear();
    for (const b of this.ownBrowsers.values()) await b.server.close().catch(() => {});
    await this.proxy?.stop();
    await this.server?.close();
  }
}

export { closeBrowsers };
