// Time scale of the integration tests. The peers run on one machine, where delivery takes about a
// millisecond, so the library's silence and backoff timings can be much shorter than in the field
// and stay far apart from the working state. REALTIC_TIME_SCALE sets the factor (default 0.25;
// the fast suite and the soak run use 1, the real defaults).
//
// Not scaled: timings that cover negotiation round trips through the signaling server
// (connectTimeoutMs, recoveryStepTimeoutMs, and CHANNEL_OPEN_TIMEOUT_MS, because DTLS on the
// answering side waits until the offerer has the answer), the background thresholds, which are judged by ICE
// consent checks the browser sends about every 5 s, and the bandwidth estimation periods.
import { DEFAULTS } from "../../../src/config.js";

export const TIME_SCALE = Number(process.env.REALTIC_TIME_SCALE ?? 0.25);

const SCALED_KEYS = [
  "HEARTBEAT_IDLE_MS",
  "SLOW_CONNECTION_MS",
  "STALE_CONNECTION_MS",
  "LIVENESS_CHECK_INTERVAL_MS",
  "iceRestartBackoffMs",
  "reprobeIntervalsMs",
  "linkStateIntervalMs",
  "switchHoldMs",
  "earlySwitchIntervalMs",
  "relayHopDownMs",
];

/** A library duration in the test's time scale. */
export const ms = (n) => Math.round(n * TIME_SCALE);

/** A tolerance in the test's time scale, never below `floor` (timer jitter does not scale). */
export const tolerance = (n, floor = 250) => Math.max(ms(n), floor);

/** `config` with every scaled timing set, from `config` or the defaults, in the test's time scale. */
export function scaleTiming(config = {}) {
  const out = { ...config };
  for (const key of SCALED_KEYS) {
    const value = config[key] ?? DEFAULTS[key];
    out[key] = Array.isArray(value) ? value.map(ms) : ms(value);
  }
  return out;
}
