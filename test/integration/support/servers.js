// Starts the reference servers for tests. They live in their own repositories, by default
// checkouts next to this one: realtic-server-node ($REALTIC_SERVER_NODE_DIR) and
// realtic-server-php ($REALTIC_SERVER_PHP_DIR). Both serve this repository as the client files,
// so pages and signaling share one origin. The PHP binary is $REALTIC_PHP or `php` on the PATH.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NODE_DIR = process.env.REALTIC_SERVER_NODE_DIR ?? join(ROOT, "..", "realtic-server-node");
const PHP_DIR = process.env.REALTIC_SERVER_PHP_DIR ?? join(ROOT, "..", "realtic-server-php");
const PHP = process.env.REALTIC_PHP ?? "php";

/** Why the Node server cannot run, or false when it can. */
export const nodeServerMissing = existsSync(join(NODE_DIR, "node_modules", "ws"))
  ? false
  : `no realtic-server-node with installed dependencies at ${NODE_DIR}`;

/** Why the PHP server cannot run, or false when it can. */
export const phpServerMissing = !existsSync(join(PHP_DIR, "signal.php"))
  ? `no realtic-server-php at ${PHP_DIR}`
  : spawnSync(PHP, ["-v"]).status !== 0
    ? `no PHP binary (${PHP})`
    : false;

/**
 * Starts the Node server of realtic-server-node with this repository as the client files.
 * @param {object} [options] options of its createSignalingServer
 */
export async function createNodeServer(options = {}) {
  if (nodeServerMissing) throw new Error(nodeServerMissing);
  const { createSignalingServer } = await import(pathToFileURL(join(NODE_DIR, "server.js")).href);
  return createSignalingServer({ clientDir: ROOT, ...options });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("connect", () => resolve(socket.end() && true));
    socket.on("error", () => resolve(false));
  });
}

/**
 * Starts the PHP server with PHP's built-in web server. Same interface as createNodeServer:
 * `port`, `signaling`, `controls`
 * (down, delayMs, duplicate, redeliver; assignments take effect on the next request),
 * `setDown(down)`, `close()`.
 * @param {{workers?: number, clientLogDir?: string}} [options]
 */
export async function createPhpServer({ workers = 8, clientLogDir } = {}) {
  if (phpServerMissing) throw new Error(phpServerMissing);
  const dir = mkdtempSync(join(tmpdir(), "realtic-php-"));
  const controlsFile = join(dir, "controls.json");
  const state = { down: false, delayMs: 0, duplicate: false, redeliver: false };
  const write = () => writeFileSync(controlsFile, JSON.stringify(state));
  write();
  const controls = new Proxy(state, {
    set(target, key, value) {
      target[key] = value;
      write();
      return true;
    },
  });
  const port = await freePort();
  const child = spawn(PHP, ["-S", `127.0.0.1:${port}`, "router.php"], {
    cwd: PHP_DIR,
    env: { ...process.env, REALTIC_CLIENT_DIR: ROOT, REALTIC_DB: join(dir, "realtic.sqlite"), REALTIC_TEST_CONTROLS: controlsFile, PHP_CLI_SERVER_WORKERS: String(workers), REALTIC_CLIENT_LOG_DIR: clientLogDir ?? "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const deadline = performance.now() + 10000;
  while (!(await canConnect(port))) {
    if (child.exitCode !== null || performance.now() > deadline) throw new Error(`PHP server did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const url = `http://localhost:${port}/signal.php`;
  return {
    port,
    url,
    logUrl: `http://localhost:${port}/log.php`,
    signaling: { type: "polling", url },
    controls,
    setDown(down) {
      controls.down = down;
    },
    async close() {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
