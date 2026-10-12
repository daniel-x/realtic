/**
 * Stable streams (plan section 10.3): one MediaStream per origin and publication that lives as
 * long as the publication, fed by whichever source (direct link or relay) the current route
 * uses. On a switch the new track is added before the old one is removed, so a `<video>` with
 * that `srcObject` keeps playing.
 */
export class StableStreams {
    /**
     * @param {object} options
     * @param {(origin: string) => string | null} options.preferredSource link id the origin's route uses
     * @param {(origin: string, event: string, detail: object) => void} options.emit
     * @param {() => MediaStream} [options.createStream]
     */
    constructor({ preferredSource, emit, createStream }: {
        preferredSource: (origin: string) => string | null;
        emit: (origin: string, event: string, detail: object) => void;
        createStream?: () => MediaStream;
    });
    preferredSource: (origin: string) => string | null;
    emit: (origin: string, event: string, detail: object) => void;
    createStream: () => MediaStream;
    /**
     * Registers a track for a publication from a source link.
     * @param {{origin: string, pub: string, tag: string, kind: string}} info
     * @param {string} source link id
     * @param {MediaStreamTrack} track
     */
    attach(info: {
        origin: string;
        pub: string;
        tag: string;
        kind: string;
    }, source: string, track: MediaStreamTrack): void;
    /**
     * Removes a source of a publication; ends the publication when no source is left.
     * @param {string} origin
     * @param {string} pub
     * @param {string} source
     */
    detach(origin: string, pub: string, source: string): void;
    /** Removes every source that came over `source`. */
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
