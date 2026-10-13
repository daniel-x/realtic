/**
 * The connection to one other peer of the group, kept up as long as the peer is known (plan
 * section 3). It is direct, wrapping the RTCPeerConnection of its direct link, or routed through a
 * relay, using the relay's direct link. Finding routes, keeping standby routes warm and switching
 * routes happen inside; the object survives link rebuilds, ICE restarts and route switches, so app
 * state bound to it never has to be rebuilt (doc §3.8).
 *
 * Events: `statechange` (state, reason), `routechange` (route), `channel` (ReatChannel),
 * `track` ({track, stream, tag, origin, kind}), `trackreplaced` ({track, oldTrack, stream, tag}),
 * `trackended` ({track, stream, tag}).
 */
export class ReatPeerConnection extends Emitter {
    /**
     * @param {object} group internal group interface
     * @param {string} id
     */
    constructor(group: object, id: string);
    /** Last error text and hint of the direct connection. */
    directError: any;
    directHint: any;
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
    /** `connecting` | `connected` | `slow` | `reconnecting` | `unreachable` | `closing` | `closed` */
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
    /**
     * The current ReatDirectPeerConnection to this peer (an RTCPeerConnection), or null without one.
     * A rebuild replaces it.
     */
    get direct(): any;
    /** The current RTCPeerConnection to this peer, or null without one; for advanced use. */
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
    }): import("./index.js").ReatChannel;
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
    /** True once the direct connection was started (after hello). */
    get directStarted(): boolean;
    /** `connecting` | `connected` | `slow` | `recovering` | `unreachable` | `closed` */
    get directState(): string;
    /** Reason of the last direct state change. */
    get directReason(): string;
    /** The last candidate pair dump. */
    get lastDump(): any;
    /**
     * Starts the direct connection. `hooks` are the group's handlers; each gets the current
     * ReatDirectPeerConnection first.
     * @param {object} hooks
     */
    startDirect(hooks: object): void;
    /**
     * Handles a signaling message of the direct connection (from the server or the mesh).
     * @param {object} msg
     */
    handleDirectSignal(msg: object): void;
    /**
     * ICE restart on a working direct connection, e.g. after a network change (decision D15). The
     * impolite side restarts, the polite side asks for it.
     * @param {string} reason
     */
    directIceRestart(reason: string): void;
    /** Re-checks liveness now and restarts ICE when the direct connection is slow or stale. */
    checkDirect(reason: any): void;
    /**
     * Rebuilds the direct connection now. With `silent`, the old one is abandoned without closing
     * it, so the remote side learns of the rebuild only from the new session id (test hook for
     * doc §3.6).
     */
    rebuildDirect(reason?: string, silent?: boolean): void;
    /**
     * Closes the direct connection for good.
     * @param {string} reason
     */
    closeDirect(reason: string): void;
    /**
     * Sets the state, emitting `statechange` on change.
     * @param {string} state
     * @param {string} reason
     */
    setState(state: string, reason: string): void;
    /** True after the peer was connected once. */
    get everConnected(): boolean;
    /**
     * Closes the connection: `closing` before anything is shut down, `closed` at the end.
     * @param {string} [reason]
     */
    close(reason?: string): void;
    #private;
}
import { Emitter } from "./util/emitter.js";
import { Session } from "./channel/session.js";
import { LivenessMonitor } from "./liveness/monitor.js";
