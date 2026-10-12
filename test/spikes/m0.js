// Runs the M0 feasibility spikes in Chromium and Firefox and prints the results as JSON.
import { startHttp } from "../integration/harness/http.js";
import { openPage, closeBrowsers } from "../integration/harness/browsers.js";

const http = await startHttp();
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox"]) {
  try {
    const page = await openPage(name, `${http.url}/test/spikes/m0.html`);
    await page.waitForFunction(() => window.spike);
    const res = await page.evaluate(() => window.spike());
    console.log(name, JSON.stringify(res, null, 1));
  } catch (e) {
    console.log(name, "FAILED", e.message);
  }
}
await closeBrowsers();
await http.close();
