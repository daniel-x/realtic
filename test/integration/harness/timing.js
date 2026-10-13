// Library timings of the integration tests. The peers run on one machine, where delivery takes
// about a millisecond, so every timing can be much shorter than in the field. TEST_TIMINGS holds
// each one shrunk on its own to the smallest value that still runs reliably here; the comments say
// what bounds it. TEST_TIMINGS=default runs with the library defaults instead (the fast suite and
// the soak run).
import { DEFAULTS } from "../../../src/config.js";

/** True when the test timings apply (TEST_TIMINGS is not `default`). */
export const FAST_TIMINGS = (process.env.TEST_TIMINGS ?? "fast") !== "default";

export const TEST_TIMINGS = Object.freeze({
  // A beat must arrive well within the slow threshold even when a busy browser delays timers.
  HEARTBEAT_IDLE_MS: 100,
  SLOW_CONNECTION_MS: 300,
  // After a short outage, SCTP retransmission backoff delays the first data by up to about 1 s.
  STALE_CONNECTION_MS: 2000,
  LIVENESS_CHECK_INTERVAL_MS: 50,
  // ICE connected to `ctl` open includes the answer's way back through the signaling server.
  CHANNEL_OPEN_TIMEOUT_MS: 3000,
  // Judged by ICE consent checks. The tests freeze Chromium pages only, which check every 2.5 s.
  BACKGROUND_SLOW_MS: 4000,
  BACKGROUND_STALE_MS: 6000,
  // Setup and recovery steps include signaling round trips (PHP polling: 250 ms per poll).
  connectTimeoutMs: 3000,
  iceRestartBackoffMs: [100, 300, 600],
  recoveryStepTimeoutMs: 1500,
  reprobeIntervalsMs: [1000, 2000, 4000],
  networkProbeIntervalMs: 1000,
  candidateBatchMs: 20,
  linkStateIntervalMs: 300,
  statsIntervalMs: 500,
  switchHoldMs: 750,
  earlySwitchIntervalMs: 2500,
  relayPeerDownMs: 600,
  ackDelayMs: 50,
  retransmitTimeoutMs: 1000,
  bweReportIntervalMs: 500,
});

/** The library timings in effect for this test run. */
export const T = Object.freeze({ ...DEFAULTS, ...(FAST_TIMINGS ? TEST_TIMINGS : {}) });

/** `config` for a peer of this test run: the test timings, overridden by the scenario's values. */
export function testConfig(config = {}) {
  return FAST_TIMINGS ? { ...TEST_TIMINGS, ...config } : config;
}

/** The library timings a peer started with `config` runs with. */
export function effective(config = {}) {
  return { ...DEFAULTS, ...testConfig(config) };
}
