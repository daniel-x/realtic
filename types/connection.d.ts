/**
 * End to end connection to one remote peer, direct or through a relay (plan section 3). It survives link rebuilds, ICE restarts and
 * route switches, so app state bound to it never has to be rebuilt (doc §3.8).
 *
 * Events: `statechange` (state, reason), `routechange` (route), `channel` (RealticChannel),
 * `track` ({track, stream, tag, origin, kind}), `trackreplaced` ({track, oldTrack, stream, tag}),
 * `trackended` ({track, stream, tag}).
 */
export class RealticConnection extends Emitter {
    /**
     * @param {object} group internal group interface
     * @param {string} id
     */
    constructor(group: object, id: string);
    /** Remote hello (protocol, keys, capabilities), once received. */
    remote: any;
    /** End to end AES-GCM key for relayed data. */
    pairKey: any;
    /** Last error text and hint. */
    lastError: any;
    hint: any;
    id: string;
    impolite: boolean;
    l: any;
    session: Session;
    /** `connecting` | `connected` | `slow` | `reconnecting` | `unreachable` | `closed` */
    get state(): string;
    /** Reason of the last state change. */
    get reason(): string;
    /** `{ kind: "direct" | "relay", via, candidateType }` or null without a route. */
    get route(): {
        kind: string;
        via: any;
        candidateType: any;
    };
    /** Internal route descriptor. */
    get routeInfo(): any;
    /** The direct link's RTCPeerConnection, for advanced use. */
    get rtcPeerConnection(): any;
    /** End to end liveness monitor of relayed routes. */
    get e2e(): LivenessMonitor;
    /**
     * Creates an end to end data channel (plan section 9.2).
     * @param {string} label
     * @param {{ordered?: boolean, maxRetransmits?: number, maxPacketLifeTime?: number, protocol?: string}} [init]
     */
    createChannel(label: string, init?: {
        ordered?: boolean;
        maxRetransmits?: number;
        maxPacketLifeTime?: number;
        protocol?: string;
    }): import("./index.js").RealticChannel;
    /**
     * Fetches the remote side's diagnostic report. Rejects when the remote app did not enable
     * `shareLogWithPeers`.
     * @param {number} [timeoutMs]
     */
    requestLog(timeoutMs?: number): Promise<any>;
    /**
     * Switches the sending route. Unacknowledged reliable data is resent on the new route.
     * @param {{kind: "direct"} | {kind: "relay", via: string, flow: string} | null} route
     * @param {string} reason
     */
    setRoute(route: {
        kind: "direct";
    } | {
        kind: "relay";
        via: string;
        flow: string;
    } | null, reason: string): void;
    /**
     * Sends an end to end beat on a specific route (standby relays, plan section 7.2a).
     * @param {{kind: "relay", via: string, flow: string}} route
     */
    beatOn(route: {
        kind: "relay";
        via: string;
        flow: string;
    }): void;
    /**
     * Handles an envelope addressed to us from this peer.
     * @param {import("./transport/framing.js").Envelope} e
     * @param {boolean} relayed
     * @param {string} via neighbor the envelope arrived from
     */
    receiveEnvelope(e: import("./transport/framing.js").Envelope, relayed: boolean, via: string): void;
    /** Lets end to end senders continue after a transport drained. */
    pump(): void;
    /**
     * Sets the state, emitting `statechange` on change.
     * @param {string} state
     * @param {string} reason
     */
    setState(state: string, reason: string): void;
    /** True after the peer was connected once. */
    get everConnected(): boolean;
    /** Closes the peer object. */
    close(reason?: string): void;
    #private;
}
import { Emitter } from "./util/emitter.js";
import { Session } from "./channel/session.js";
import { LivenessMonitor } from "./liveness/monitor.js";
