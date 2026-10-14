// Static HTTP server for test pages and library sources, on localhost (a secure context).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TYPES = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".json": "application/json",
};

/**
 * Starts a static server rooted at the repository. Returns `{ server, url, close }`.
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => boolean} [extra]
 *   optional handler that returns true when it handled the request
 */
export async function startHttp(extra) {
  const server = createServer(async (req, res) => {
    if (extra && extra(req, res)) return;
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.includes("..")) return void res.writeHead(403).end();
    try {
      const body = await readFile(join(ROOT, path === "/" ? "test/integration/pages/peer.html" : path));
      res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://localhost:${server.address().port}`;
  return { server, url, close: () => new Promise((resolve) => server.close(resolve)) };
}
