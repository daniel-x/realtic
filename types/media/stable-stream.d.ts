/**
 * Stable streams (plan section 10.3): one MediaStream per origin and publication that lives as
 * long as the publication, fed by whichever source (direct connection or relay) the current route
 * uses. On a switch the new track is added before the old one is removed, so a `<video>` with
 * that `srcObject` keeps playing.
 */
export class StableStreams {
    /**
     * @param {object} options
     * @param {(origin: string) => string | null} options.preferredSource neighbor id the origin's route uses
     * @param {(origin: string, event: string, detail: object) => void} options.emit
     * @param {() => MediaStream} [options.createStream]
     * @param {boolean} [options.stableTracks] give one generated track per publication (Chromium)
     * @param {number} [options.graceMs] how long a stream without a source waits for a new one
     * @param {import("../util/clock.js").Clock} [options.clock]
     */
    constructor({ preferredSource, emit, createStream, stableTracks, graceMs, clock }: {
        preferredSource: (origin: string) => string | null;
        emit: (origin: string, event: string, detail: object) => void;
        createStream?: () => MediaStream;
        stableTracks?: boolean;
        graceMs?: number;
        clock?: import("../util/clock.js").Clock;
    });
    graceMs: number;
    clock: import("../util/clock.js").Clock;
    preferredSource: (origin: string) => string | null;
    emit: (origin: string, event: string, detail: object) => void;
    createStream: () => MediaStream;
    stableTracks: boolean;
    /**
     * Registers a track for a publication from a source neighbor.
     * @param {{origin: string, pub: string, tag: string, kind: string}} info
     * @param {string} source neighbor id
     * @param {MediaStreamTrack} track
     */
    attach(info: {
        origin: string;
        pub: string;
        tag: string;
        kind: string;
    }, source: string, track: MediaStreamTrack): void;
    /**
     * Removes a source of a publication; ends the publication when no source is left. With `grace`,
     * the stream waits `graceMs` for a new source first (direct connection rebuild or route repair).
     * @param {string} origin
     * @param {string} pub
     * @param {string} source
     * @param {boolean} [grace]
     */
    detach(origin: string, pub: string, source: string, grace?: boolean): void;
    /** Removes every source that came over `source`, keeping the streams for `graceMs`. */
    detachSource(source: any): void;
    /** Removes every publication of `origin`. */
    dropOrigin(origin: any): void;
    /** Re-evaluates the source of every publication of `origin`, e.g. after a route change. */
    reselect(origin: any): void;
    /** Current entries, for diagnostics. */
    list(): {
        origin: any;
        pub: any;
        tag: any;
        kind: any;
        source: any;
        sources: any[];
    }[];
    #private;
}
