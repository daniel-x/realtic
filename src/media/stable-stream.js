import { TRACK_SWAPPED } from "./attach.js";
import { StableTrack } from "./stable-track.js";

/**
 * Stable streams (plan section 10.3): one MediaStream per origin and publication that lives as
 * long as the publication, fed by whichever source (direct connection or relay) the current route
 * uses. On a switch the new track is added before the old one is removed, so a `<video>` with
 * that `srcObject` keeps playing.
 */
export class StableStreams {
  #entries = new Map();

  /**
   * @param {object} options
   * @param {(origin: string) => string | null} options.preferredSource neighbor id the origin's route uses
   * @param {(origin: string, event: string, detail: object) => void} options.emit
   * @param {() => MediaStream} [options.createStream]
   * @param {boolean} [options.stableTracks] give one generated track per publication (Chromium)
   */
  constructor({ preferredSource, emit, createStream = () => new MediaStream(), stableTracks = false, graceMs = 15000, clock = globalThis }) {
    this.graceMs = graceMs;
    this.clock = clock;
    this.preferredSource = preferredSource;
    this.emit = emit;
    this.createStream = createStream;
    this.stableTracks = stableTracks && StableTrack.supported();
  }

  /**
   * Registers a track for a publication from a source neighbor.
   * @param {{origin: string, pub: string, tag: string, kind: string}} info
   * @param {string} source neighbor id
   * @param {MediaStreamTrack} track
   */
  attach(info, source, track) {
    const key = `${info.origin}:${info.pub}`;
    let e = this.#entries.get(key);
    if (!e) {
      e = { ...info, sources: new Map(), current: null, currentSource: null, stream: this.createStream(), announced: false };
      this.#entries.set(key, e);
    }
    e.tag = info.tag;
    e.sources.set(source, track);
    if (e.graceTimer) {
      this.clock.clearTimeout(e.graceTimer);
      e.graceTimer = null;
    }
    this.#select(e);
  }

  /**
   * Removes a source of a publication; ends the publication when no source is left. With `grace`,
   * the stream waits `graceMs` for a new source first (direct connection rebuild or route repair).
   * @param {string} origin
   * @param {string} pub
   * @param {string} source
   * @param {boolean} [grace]
   */
  detach(origin, pub, source, grace = false) {
    const key = `${origin}:${pub}`;
    const e = this.#entries.get(key);
    if (!e || !e.sources.delete(source)) return;
    if (e.sources.size) return this.#select(e);
    if (grace) {
      if (!e.graceTimer) e.graceTimer = this.clock.setTimeout(() => this.#end(key, e), this.graceMs);
      return;
    }
    this.#end(key, e);
  }

  #end(key, e) {
    if (this.#entries.get(key) !== e || e.sources.size) return;
    if (e.graceTimer) this.clock.clearTimeout(e.graceTimer);
    const visible = e.pipe ? e.pipe.track : e.current;
    if (visible) e.stream.removeTrack(visible);
    e.pipe?.stop();
    this.#entries.delete(key);
    if (e.announced) this.emit(e.origin, "trackended", detail(e, { track: visible }));
  }

  /** Removes every source that came over `source`, keeping the streams for `graceMs`. */
  detachSource(source) {
    for (const e of [...this.#entries.values()]) this.detach(e.origin, e.pub, source, true);
  }

  /** Removes every publication of `origin`. */
  dropOrigin(origin) {
    for (const e of [...this.#entries.values()]) {
      if (e.origin !== origin) continue;
      for (const s of [...e.sources.keys()]) this.detach(origin, e.pub, s);
      if (!e.sources.size) this.#end(`${origin}:${e.pub}`, e);
    }
  }

  /** Re-evaluates the source of every publication of `origin`, e.g. after a route change. */
  reselect(origin) {
    for (const e of this.#entries.values()) if (e.origin === origin) this.#select(e);
  }

  #select(e) {
    if (!e.sources.size) return;
    const preferred = this.preferredSource(e.origin);
    const source = e.sources.has(preferred) ? preferred : e.sources.has(e.currentSource) ? e.currentSource : e.sources.keys().next().value;
    const track = e.sources.get(source);
    e.currentSource = source;
    if (track === e.current) return;
    const old = e.current;
    e.current = track;
    if (this.stableTracks) {
      if (!e.pipe) {
        e.pipe = new StableTrack(e.kind);
        e.stream.addTrack(e.pipe.track);
      }
      e.pipe.setSource(track);
      if (!e.announced) {
        e.announced = true;
        this.emit(e.origin, "track", detail(e, { track: e.pipe.track }));
      } else {
        this.emit(e.origin, "trackreplaced", detail(e, { track: e.pipe.track, sourceTrack: track, oldTrack: e.pipe.track }));
      }
      return;
    }
    e.stream.addTrack(track);
    if (old) e.stream.removeTrack(old);
    if (old && typeof e.stream.dispatchEvent === "function") e.stream.dispatchEvent(new Event(TRACK_SWAPPED));
    if (!e.announced) {
      e.announced = true;
      this.emit(e.origin, "track", detail(e, { track }));
    } else if (old) {
      this.emit(e.origin, "trackreplaced", detail(e, { track, oldTrack: old }));
    }
  }

  /** Current entries, for diagnostics. */
  list() {
    return [...this.#entries.values()].map((e) => ({ origin: e.origin, pub: e.pub, tag: e.tag, kind: e.kind, source: e.currentSource, sources: [...e.sources.keys()] }));
  }
}

function detail(e, tracks) {
  return { ...tracks, stream: e.stream, tag: e.tag, kind: e.kind, origin: e.origin, pub: e.pub };
}
