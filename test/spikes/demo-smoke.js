import { createSignalingServer } from "../../examples/server/server.js";
import { openPage, closeBrowsers } from "../integration/harness/browsers.js";
const s = await createSignalingServer({});
const base = `http://localhost:${s.port}`;
for (const demo of ["call", "chat"]) {
  const a = await openPage("chromium", `${base}/examples/${demo}/?room=smoke-${demo}`);
  const b = await openPage("firefox", `${base}/examples/${demo}/?room=smoke-${demo}`);
  await new Promise((r) => setTimeout(r, 6000));
  const sel = demo === "call" ? ".tile .label" : "#peers";
  console.log(demo, "A:", await a.$$eval(sel, (els) => els.map((e) => e.textContent).join(" | ")));
  console.log(demo, "B:", await b.$$eval(sel, (els) => els.map((e) => e.textContent).join(" | ")));
  if (demo === "chat") {
    await a.fill("#text", "hello from A");
    await a.click("button");
    await new Promise((r) => setTimeout(r, 1000));
    console.log("chat B log:", await b.$eval("#log", (e) => e.textContent));
  }
  await a.context().close(); await b.context().close();
}
await closeBrowsers(); await s.close();
