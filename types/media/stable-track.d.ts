/**
 * A track that never changes (plan section 10.3, `config.stableTracks`): frames of the current
 * source track are copied into a `MediaStreamTrackGenerator` with a `MediaStreamTrackProcessor`.
 * Only where both exist (Chromium).
 */
export class StableTrack {
    /** True when the browser has the required APIs. */
    static supported(): boolean;
    /** @param {"audio"|"video"} kind */
    constructor(kind: "audio" | "video");
    track: any;
    /**
     * Feeds the stable track from `source` from now on.
     * @param {MediaStreamTrack} source
     */
    setSource(source: MediaStreamTrack): void;
    stop(): void;
    #private;
}
