import { startHttp } from "../integration/harness/http.js";
import { openPage, closeBrowsers } from "../integration/harness/browsers.js";
const http = await startHttp();
for (const b of ["chromium", "firefox"]) {
  const p = await openPage(b, `${http.url}/test/spikes/swap.html`);
  await p.waitForFunction(() => window.swap);
  console.log(b, "swap", await p.evaluate(() => window.swap("swap")), "reassign", await p.evaluate(() => window.swap("reassign")));
}
await closeBrowsers(); await http.close();
