/**
 * Detects that the device slept or the page was suspended: a periodic timer that fires much later
 * than scheduled. Browsers have no event for a resume from system sleep.
 *
 * The sleep estimate is the larger of the monotonic and the wall-clock delta between two ticks,
 * minus the interval, so it is low by up to one interval: the monotonic clock pauses during sleep on Linux and macOS but keeps
 * running on Windows, and the wall clock runs on everywhere. `unobservedMs` is the part the
 * monotonic clock missed, which silence measured with it does not contain. A wall-clock step
 * without sleep looks like a sleep; the reactions are safe for that case.
 */
export class SleepWatcher {
  #clock;
  #timer = null;
  #lastMono;
  #lastWall;

  /**
   * @param {object} options
   * @param {import("../util/clock.js").Clock} options.clock
   * @param {number} options.intervalMs tick interval
   * @param {number} options.minSleepMs smallest delay reported as a sleep
   * @param {(sleep: {sleepMs: number, unobservedMs: number}) => void} options.onresume
   */
  constructor({ clock, intervalMs, minSleepMs, onresume }) {
    this.#clock = clock;
    this.intervalMs = intervalMs;
    this.minSleepMs = minSleepMs;
    this.onresume = onresume;
  }

  start() {
    this.#lastMono = this.#clock.now();
    this.#lastWall = this.#clock.wallNow();
    this.#timer = this.#clock.setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.#timer !== null) this.#clock.clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Compares the clocks with the last tick; reports a sleep when the tick came late. */
  tick() {
    const mono = this.#clock.now();
    const wall = this.#clock.wallNow();
    const monoDelta = mono - this.#lastMono;
    const wallDelta = wall - this.#lastWall;
    this.#lastMono = mono;
    this.#lastWall = wall;
    const sleepMs = Math.max(monoDelta, wallDelta) - this.intervalMs;
    if (sleepMs < this.minSleepMs) return;
    this.onresume?.({ sleepMs, unobservedMs: Math.max(0, wallDelta - monoDelta) });
  }
}

/**
 * What a direct connection does after a sleep of `sleepMs`:
 *
 * - `"check"`: heartbeat now, and an ICE restart one `SLOW_CONNECTION_MS` later if the direct
 *   connection is still slow or stale. For short sleeps, after which the other side has not
 *   judged this one stale, and when nothing shows that the device was suspended: a timer that a
 *   hidden tab throttled fires late too, while data keeps arriving.
 * - `"restart"`: ICE restart now, from the stale threshold on. The other side has started its
 *   recovery; waiting for the own stale verdict only costs time.
 * - `"rebuild"`: a new RTCPeerConnection now, from `sleepRebuildMs` on (ICE consent expired, the
 *   other side's recovery is far along), and for a connection that is `unreachable`.
 *
 * Suspended means the monotonic clock missed at least half of the sleep, or the connection heard
 * nothing for at least half of it.
 * @param {{sleepMs: number, unobservedMs: number, silenceMs: number, unreachable: boolean}} state
 * @param {{STALE_CONNECTION_MS: number, sleepRebuildMs: number}} config
 * @returns {"check"|"restart"|"rebuild"}
 */
export function sleepReaction({ sleepMs, unobservedMs, silenceMs, unreachable }, config) {
  if (unreachable) return "rebuild";
  const suspended = unobservedMs >= sleepMs / 2 || silenceMs >= sleepMs / 2;
  if (!suspended || sleepMs < config.STALE_CONNECTION_MS) return "check";
  return sleepMs >= config.sleepRebuildMs ? "rebuild" : "restart";
}
