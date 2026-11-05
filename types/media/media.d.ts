/**
 * A published local track (plan section 3). `replaceTrack` swaps the track on every sender
 * without renegotiation (doc §6).
 */
export class RalPublication {
    constructor(media: any, track: any, { tag, to }?: {
        tag?: any;
        to?: string;
    });
    id: string;
    track: any;
    kind: any;
    tag: any;
    to: string | Set<string>;
    closed: boolean;
    /** @type {{maxBitrate?: number, maxFramerate?: number, scaleResolutionDownBy?: number}|null} */
    limits: {
        maxBitrate?: number;
        maxFramerate?: number;
        scaleResolutionDownBy?: number;
    } | null;
    /** True when the publication targets `peerId`. */
    targets(peerId: any): any;
    /**
     * Replaces the published track on every sender.
     * @param {MediaStreamTrack} track
     */
    replaceTrack(track: MediaStreamTrack): Promise<void>;
    /**
     * Sets encoding limits that last until the next call, combined with the bandwidth budgets: the
     * lower bitrate and the larger downscale apply. Relays apply `maxBitrate` too. An empty object or
     * null removes the limits.
     * @param {{maxBitrate?: number, maxFramerate?: number, scaleResolutionDownBy?: number}|null} limits
     */
    setLimits(limits: {
        maxBitrate?: number;
        maxFramerate?: number;
        scaleResolutionDownBy?: number;
    } | null): void;
    /**
     * Changes who receives this publication, without renegotiating for receivers that stay: their
     * track and `MediaStream` stay as they are.
     * @param {"all" | string[]} to
     */
    setTargets(to: "all" | string[]): void;
    /** Stops publishing. */
    close(): void;
    #private;
}
/**
 * Media over direct connections (plan section 10). For each direct connection the group's media
 * plan lists the sources it must carry (own publications and, on a relay, forwarded tracks); this
 * class keeps the direct connection's send slots, `mid-map` announcements and encoding activity in
 * line with that plan.
 *
 * Receiving: `mid-map` from a neighbor maps its transceiver mids to origin and publication; the
 * received tracks feed the stable streams.
 */
export class MediaManager {
    /** @param {object} group internal group interface */
    constructor(group: object);
    /** @type {Map<string, RalPublication>} */
    pubs: Map<string, RalPublication>;
    l: any;
    streams: StableStreams;
    /**
     * @param {MediaStreamTrack} track
     * @param {{tag?: string, to?: "all" | string[]}} [options]
     */
    publish(track: MediaStreamTrack, options?: {
        tag?: string;
        to?: "all" | string[];
    }): RalPublication;
    /** @param {RalPublication} pub */
    unpublish(pub: RalPublication): void;
    /** @param {RalPublication} pub limits or targets of a publication changed */
    publicationChanged(pub: RalPublication): void;
    /** Replaces the track of a source on every direct connection that carries it. */
    replaceSource(key: any, track: any): Promise<void>;
    /**
     * Brings a direct connection's slots in line with the plan. Serialized per direct connection.
     * @param {import("../direct/direct-peer-connection.js").RalDirectPeerConnection} directConn
     */
    sync(directConn: import("../direct/direct-peer-connection.js").RalDirectPeerConnection): void;
    /** Senders of a direct connection, for bandwidth control. */
    senders(neighborId: any): any;
    /** Forgets a direct connection's sending and receiving state (rebuild or close). */
    resetDirect(neighborId: any): void;
    /**
     * Handles `mid-map` from a neighbor.
     * @param {import("../direct/direct-peer-connection.js").RalDirectPeerConnection} directConn
     * @param {{mids: Record<string, {origin: string, pub: string, tag: string, kind: string}>}} msg
     */
    onMidMap(directConn: import("../direct/direct-peer-connection.js").RalDirectPeerConnection, msg: {
        mids: Record<string, {
            origin: string;
            pub: string;
            tag: string;
            kind: string;
        }>;
    }): void;
    /** Re-resolves announced mids to tracks, e.g. after a negotiation round. */
    resolve(directConn: any): void;
    #private;
}
import { StableStreams } from "./stable-stream.js";
