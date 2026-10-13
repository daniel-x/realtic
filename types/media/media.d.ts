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
    /** True when the publication targets `peerId`. */
    targets(peerId: any): any;
    /**
     * Replaces the published track on every sender.
     * @param {MediaStreamTrack} track
     */
    replaceTrack(track: MediaStreamTrack): Promise<void>;
    /** Stops publishing. */
    close(): void;
    #private;
}
/**
 * Media over links (plan section 10). For each link the group's media plan lists the sources it
 * must carry (own publications and, on a relay, forwarded tracks); this class keeps the link's
 * send slots, `mid-map` announcements and encoding activity in line with that plan.
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
    /** Replaces the track of a source on every link that carries it. */
    replaceSource(key: any, track: any): Promise<void>;
    /**
     * Brings a link's slots in line with the plan. Serialized per link.
     * @param {import("../link/direct-peer-connection.js").RalDirectPeerConnection} link
     */
    sync(link: import("../link/direct-peer-connection.js").RalDirectPeerConnection): void;
    /** Senders of a link, for bandwidth control. */
    senders(linkId: any): any;
    /** Forgets a link's sending and receiving state (rebuild or close). */
    resetLink(linkId: any): void;
    /**
     * Handles `mid-map` from a neighbor.
     * @param {import("../link/direct-peer-connection.js").RalDirectPeerConnection} link
     * @param {{mids: Record<string, {origin: string, pub: string, tag: string, kind: string}>}} msg
     */
    onMidMap(link: import("../link/direct-peer-connection.js").RalDirectPeerConnection, msg: {
        mids: Record<string, {
            origin: string;
            pub: string;
            tag: string;
            kind: string;
        }>;
    }): void;
    /** Re-resolves announced mids to tracks, e.g. after a negotiation round. */
    resolve(link: any): void;
    #private;
}
import { StableStreams } from "./stable-stream.js";
