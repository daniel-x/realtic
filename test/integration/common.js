// Shared helpers for integration scenarios.
import { Scenario, sleep, waitFor, PAIRINGS, pairings, closeBrowsers } from "./harness/scenario.js";

export { sleep, waitFor, PAIRINGS, pairings, closeBrowsers };

/** Fast timings for recovery tests, so a scenario does not take minutes. */
export const FAST_RECOVERY = {
  iceRestartBackoffMs: [500, 1500],
  recoveryStepTimeoutMs: 3000,
  rebuildAttempts: 1,
  reprobeIntervalsMs: [4000, 6000],
  connectTimeoutMs: 8000,
};

/**
 * Runs `fn(s)` with a started scenario; saves artifacts on failure and always stops it.
 * @param {string} name
 * @param {ConstructorParameters<typeof Scenario>[0]} options
 * @param {(s: Scenario) => Promise<void>} fn
 */
export async function withScenario(name, options, fn) {
  const s = new Scenario({ name, ...options });
  try {
    await s.start();
    await fn(s);
  } catch (error) {
    const dir = await s.saveArtifacts(name).catch(() => "?");
    error.message += `\n  artifacts: ${dir}`;
    throw error;
  } finally {
    await s.stop();
  }
}

/** Connects all peers of the scenario (full mesh membership) and waits for `connected`. */
export async function connectAll(s, timeoutMs = 30000) {
  await s.meshAll();
  await s.waitAllConnected(timeoutMs);
}

/** Events of a peer page since `since` (ms epoch), optionally of one type. */
export async function events(s, p, since = 0, type) {
  const all = await s.eval(p, () => window.t.events);
  return all.filter((e) => e.time >= since && (!type || e.type === type));
}

/** State change events of peer p about peer q since `since`. */
export async function states(s, p, q, since = 0) {
  const id = typeof q === "number" ? s.id(q) : q;
  return (await events(s, p, since, "state")).filter((e) => e.peer === id);
}

/** Opens a channel from p to q and waits until both ends are open. */
export async function openChannel(s, p, q, label, init) {
  const pid = typeof p === "number" ? s.id(p) : p;
  const qid = typeof q === "number" ? s.id(q) : q;
  await s.eval(p, ([id, l, i]) => window.t.createChannel(id, l, i), [qid, label, init]);
  await waitFor(() => s.eval(p, ([id, l]) => window.t.channelState(id, l) === "open", [qid, label]), 10000, `channel ${label} open at ${pid}`);
  await waitFor(() => s.eval(q, ([id, l]) => window.t.channelState(id, l) === "open", [pid, label]), 10000, `channel ${label} open at ${qid}`);
}

/** Messages p received from q on a channel. */
export function messages(s, p, q, label) {
  const qid = typeof q === "number" ? s.id(q) : q;
  return s.eval(p, ([id, l]) => window.t.messages(id, l), [qid, label]);
}

/** Sends `count` numbered messages from p to q. */
export function sendMany(s, p, q, label, prefix, count, start = 0) {
  const qid = typeof q === "number" ? s.id(q) : q;
  return s.eval(p, ([id, l, pre, n, st]) => window.t.sendMany(id, l, pre, n, st), [qid, label, prefix, count, start]);
}

/** Asserts that `got` holds exactly prefix+start .. prefix+(start+count-1) in order. */
export function assertSequence(assert, got, prefix, count, start = 0, ordered = true) {
  const mine = got.filter((m) => m.startsWith(prefix));
  const expected = Array.from({ length: count }, (_, i) => `${prefix}${start + i}`);
  if (ordered) assert.deepEqual(mine, expected, `sequence ${prefix}`);
  else assert.deepEqual([...mine].sort(), [...expected].sort(), `set ${prefix}`);
}

/** Link session id at p for q. */
export async function session(s, p, q) {
  const qid = typeof q === "number" ? s.id(q) : q;
  return (await s.eval(p, (id) => window.t.linkInfo(id), qid))?.session;
}

/** Log entries of a peer whose message matches `re`. */
export async function logMatches(s, p, re, since = 0) {
  const entries = await s.eval(p, () => window.t.log());
  return entries.filter((e) => e.time >= since && re.test(e.msg));
}
