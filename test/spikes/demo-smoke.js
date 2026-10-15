// Opens both demos in Chromium and Firefox against both reference servers and prints what the
// pages show. Usage: node test/spikes/demo-smoke.js [<kind>=<base url> ...], e.g.
// `node=http://localhost:8080` for a server started elsewhere; default: both, started here.
import { createNodeServer, createPhpServer } from "../integration/support/servers.js";
import { openPage, closeBrowsers } from "../integration/support/browsers.js";

const given = process.argv.slice(2).map((arg) => arg.split(/=(.*)/s));
for (const [kind, url] of given.length ? given : [["php"], ["node"]]) {
  const s = url ? null : kind === "php" ? await createPhpServer() : await createNodeServer();
  const base = url ?? `http://localhost:${s.port}`;
  for (const demo of ["call", "chat"]) {
    const query = `?group=smoke-${demo}${kind === "node" ? "&server=node" : ""}`;
    const a = await openPage("chromium", `${base}/examples/${demo}/${query}`);
    const b = await openPage("firefox", `${base}/examples/${demo}/${query}`);
    await new Promise((r) => setTimeout(r, 6000));
    const sel = demo === "call" ? ".tile .label" : "#peers";
    console.log(kind, demo, "A:", await a.$$eval(sel, (els) => els.map((e) => e.textContent).join(" | ")));
    console.log(kind, demo, "B:", await b.$$eval(sel, (els) => els.map((e) => e.textContent).join(" | ")));
    if (demo === "chat") {
      await a.fill("#text", `hello from A via ${kind}`);
      await a.click("button");
      await new Promise((r) => setTimeout(r, 1000));
      console.log(kind, "chat B log:", await b.$eval("#log", (e) => e.textContent));
    }
    await a.context().close();
    await b.context().close();
  }
  await s?.close();
}
await closeBrowsers();
