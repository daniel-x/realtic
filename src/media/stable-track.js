/**
 * A track that never changes (plan section 10.3, `config.stableTracks`): frames of the current
 * source track are copied into a `MediaStreamTrackGenerator` with a `MediaStreamTrackProcessor`.
 * Only where both exist (Chromium).
 */
export class StableTrack {
  #writer;
  #reader = null;

  /** True when the browser has the required APIs. */
  static supported() {
    return typeof globalThis.MediaStreamTrackGenerator === "function" && typeof globalThis.MediaStreamTrackProcessor === "function";
  }

  /** @param {"audio"|"video"} kind */
  constructor(kind) {
    this.track = new globalThis.MediaStreamTrackGenerator({ kind });
    this.#writer = this.track.writable.getWriter();
  }

  /**
   * Feeds the stable track from `source` from now on.
   * @param {MediaStreamTrack} source
   */
  setSource(source) {
    this.#reader?.cancel().catch(() => {});
    const reader = new globalThis.MediaStreamTrackProcessor({ track: source }).readable.getReader();
    this.#reader = reader;
    const pump = async () => {
      for (;;) {
        let r;
        try {
          r = await reader.read();
        } catch {
          return;
        }
        if (r.done) return;
        if (this.#reader !== reader) {
          r.value.close();
          return;
        }
        try {
          await this.#writer.write(r.value);
        } catch {
          r.value.close();
          return;
        }
      }
    };
    pump();
  }

  stop() {
    this.#reader?.cancel().catch(() => {});
    this.#reader = null;
    this.track.stop();
  }
}
