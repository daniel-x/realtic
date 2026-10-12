import { TRACK_SWAPPED } from "./attach.js";

/**
 * Stable streams (plan section 10.3): one MediaStream per origin and publication that lives as
 * long as the publication, fed by whichever source (direct link or relay) the current route
 * uses. On a switch the new track is added before the old one is removed, so a `<video>` with
 * that `srcObject` keeps playing.
 */
export class StableStreams {
  #entries = new Map();

  /**
   * @param {object} options
   * @param {(origin: string) => string | null} options.preferredSource link id the origin's route uses
   * @param {(origin: string, event: string, detail: object) => void} options.emit
   * @param {() => MediaStream} [options.createStream]
   */
  constructor({ preferredSource, emit, createStream = () => new MediaStream() }) {
    this.preferredSource = preferredSource;
    this.emit = emit;
    this.createStream = createStream;
  }

  /**
   * Registers a track for a publication from a source link.
   * @param {{origin: string, pub: string, tag: string, kind: string}} info
   * @param {string} source link id
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
    this.#select(e);
  }

  /**
   * Removes a source of a publication; ends the publication when no source is left.
   * @param {string} origin
   * @param {string} pub
   * @param {string} source
   */
  detach(origin, pub, source) {
    const key = `${origin}:${pub}`;
    const e = this.#entries.get(key);
    if (!e || !e.sources.delete(source)) return;
    if (e.sources.size) return this.#select(e);
    if (e.current) e.stream.removeTrack(e.current);
    this.#entries.delete(key);
    if (e.announced) this.emit(origin, "trackended", { track: e.current, stream: e.stream, tag: e.tag, kind: e.kind, origin, pub });
  }

  /** Removes every source that came over `source`. */
  detachSource(source) {
    for (const e of [...this.#entries.values()]) this.detach(e.origin, e.pub, source);
  }

  /** Removes every publication of `origin`. */
  dropOrigin(origin) {
    for (const e of [...this.#entries.values()]) {
      if (e.origin !== origin) continue;
      for (const s of [...e.sources.keys()]) this.detach(origin, e.pub, s);
    }
  }

  /** Re-evaluates the source of every publication of `origin`, e.g. after a route change. */
  reselect(origin) {
    for (const e of this.#entries.values()) if (e.origin === origin) this.#select(e);
  }

  #select(e) {
    const preferred = this.preferredSource(e.origin);
    const source = e.sources.has(preferred) ? preferred : e.sources.has(e.currentSource) ? e.currentSource : e.sources.keys().next().value;
    const track = e.sources.get(source);
    e.currentSource = source;
    if (track === e.current) return;
    const old = e.current;
    e.current = track;
    e.stream.addTrack(track);
    if (old) e.stream.removeTrack(old);
    if (old && typeof e.stream.dispatchEvent === "function") e.stream.dispatchEvent(new Event(TRACK_SWAPPED));
    if (!e.announced) {
      e.announced = true;
      this.emit(e.origin, "track", { track, stream: e.stream, tag: e.tag, kind: e.kind, origin: e.origin, pub: e.pub });
    } else if (old) {
      this.emit(e.origin, "trackreplaced", { track, oldTrack: old, stream: e.stream, tag: e.tag, kind: e.kind, origin: e.origin, pub: e.pub });
    }
  }

  /** Current entries, for diagnostics. */
  list() {
    return [...this.#entries.values()].map((e) => ({ origin: e.origin, pub: e.pub, tag: e.tag, kind: e.kind, source: e.currentSource, sources: [...e.sources.keys()] }));
  }
}
