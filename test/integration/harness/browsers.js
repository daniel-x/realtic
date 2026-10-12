// Launches Chromium and Firefox with fake media, raw host candidates and loopback ICE, and opens
// test pages in separate browser contexts.
import { chromium, firefox, webkit } from "playwright";

const CHROMIUM_ARGS = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--disable-features=WebRtcHideLocalIpsWithMdns",
  "--allow-loopback-in-peer-connection",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling",
];

const FIREFOX_PREFS = {
  "media.navigator.streams.fake": true,
  "media.navigator.permission.disabled": true,
  "media.peerconnection.ice.obfuscate_host_addresses": false,
  "media.peerconnection.ice.loopback": true,
  "media.autoplay.default": 0,
  "media.autoplay.block-webaudio": false,
  "media.peerconnection.ice.default_address_only": false,
};

const engines = { chromium, firefox, webkit };
const launched = new Map();

/**
 * Returns a shared browser instance of the given engine, launching it on first use.
 * @param {"chromium"|"firefox"|"webkit"} name
 */
export async function browser(name) {
  if (!launched.has(name)) {
    const options = {};
    if (name === "chromium") options.args = CHROMIUM_ARGS;
    if (name === "firefox") options.firefoxUserPrefs = FIREFOX_PREFS;
    launched.set(name, engines[name].launch(options));
  }
  return launched.get(name);
}

/**
 * Opens a page in a fresh browser context of the given engine.
 * @param {"chromium"|"firefox"|"webkit"} name
 * @param {string} url
 */
export async function openPage(name, url) {
  const b = await browser(name);
  const context = await b.newContext(name === "chromium" ? { permissions: ["camera", "microphone"] } : {});
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error(`[${name} pageerror]`, e.message));
  if (process.env.REALTIC_PAGE_CONSOLE) page.on("console", (m) => console.log(`[${name}]`, m.text()));
  await page.goto(url);
  return page;
}

/** Closes all launched browsers. */
export async function closeBrowsers() {
  for (const p of launched.values()) await (await p).close().catch(() => {});
  launched.clear();
}
