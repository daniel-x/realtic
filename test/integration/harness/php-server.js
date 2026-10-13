// Starts the PHP reference server (server/php) with PHP's built-in web server, for tests. It
// serves the repository's static files too, so pages and signaling share one origin. The PHP
// binary is $REALTIC_PHP or `php` on the PATH.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

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
 * Same interface as createSignalingServer of server/node: `port`, `signaling`, `controls`
 * (down, delayMs, duplicate, redeliver; assignments take effect on the next request),
 * `setDown(down)`, `close()`.
 * @param {{workers?: number, clientLogDir?: string}} [options]
 */
export async function createPhpServer({ workers = 8, clientLogDir } = {}) {
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
  const child = spawn(process.env.REALTIC_PHP ?? "php", ["-S", `127.0.0.1:${port}`, "server/php/router.php"], {
    cwd: ROOT,
    env: { ...process.env, REALTIC_DB: join(dir, "realtic.sqlite"), REALTIC_TEST_CONTROLS: controlsFile, PHP_CLI_SERVER_WORKERS: String(workers), REALTIC_CLIENT_LOG_DIR: clientLogDir ?? "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const deadline = Date.now() + 10000;
  while (!(await canConnect(port))) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`PHP server did not start: ${stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const url = `http://localhost:${port}/server/php/signal.php`;
  return {
    port,
    url,
    logUrl: `http://localhost:${port}/server/php/log.php`,
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
