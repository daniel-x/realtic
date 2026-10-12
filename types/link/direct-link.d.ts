/**
 * A direct link to one neighbor (plan section 5). The object lives as long as the neighbor is in
 * the group; RTCPeerConnection generations come and go under it.
 *
 * Events:
 * - `state` (state, reason): `connecting` | `connected` | `slow` | `recovering` | `unreachable` | `closed`
 * - `ctl` (msg): control message from the neighbor, after transport messages were handled
 * - `envelope` (bytes, key): binary envelope from a transport channel
 * - `open`: `ctl` opened in a new generation
 * - `rebuilt`: a new generation replaced the old one; slots and transceivers are gone
 * - `negotiated`: a negotiation round completed
 * - `metrics` (metrics): periodic link metrics
 * - `drain` (key): a transport channel can take more data
 * - `remotetrack` (transceiver): the browser fired `track`
 */
export class DirectLink extends Emitter {
    /**
     * @param {object} ctx group context
     * @param {string} ctx.selfId
     * @param {Readonly<typeof import("../config.js").DEFAULTS>} ctx.config
     * @param {import("../util/clock.js").Clock} ctx.clock
     * @param {import("../diag/log.js").Log} ctx.log
     * @param {(to: string, msg: object, link: DirectLink) => void} ctx.sendSignal
     * @param {(link: DirectLink, withTurn: boolean) => RTCConfiguration} ctx.rtcConfig
     * @param {typeof RTCPeerConnection} ctx.RTCPeerConnection
     * @param {(link: DirectLink) => boolean} [ctx.canAddTurn]
     * @param {string} remoteId
     */
    constructor(ctx: {
        selfId: string;
        config: Readonly<typeof import("../config.js").DEFAULTS>;
        clock: import("../util/clock.js").Clock;
        log: import("../diag/log.js").Log;
        sendSignal: (to: string, msg: object, link: DirectLink) => void;
        rtcConfig: (link: DirectLink, withTurn: boolean) => RTCConfiguration;
        RTCPeerConnection: typeof RTCPeerConnection;
        canAddTurn?: (link: DirectLink) => boolean;
    }, remoteId: string);
    /** Latest link metrics (plan section 7.1). */
    metrics: {
        state: string;
        rtt: any;
        bitrate: any;
        loss: any;
        candidateType: any;
        remoteCandidateType: any;
    };
    /** Last error text and hint. */
    lastError: any;
    hint: any;
    ctx: {
        selfId: string;
        config: Readonly<typeof import("../config.js").DEFAULTS>;
        clock: import("../util/clock.js").Clock;
        log: import("../diag/log.js").Log;
        sendSignal: (to: string, msg: object, link: DirectLink) => void;
        rtcConfig: (link: DirectLink, withTurn: boolean) => RTCConfiguration;
        RTCPeerConnection: typeof RTCPeerConnection;
        canAddTurn?: (link: DirectLink) => boolean;
    };
    remoteId: string;
    impolite: boolean;
    config: Readonly<Readonly<{
        HEARTBEAT_IDLE_MS: 500;
        SLOW_CONNECTION_MS: 1000;
        STALE_CONNECTION_MS: 5000;
        LIVENESS_CHECK_INTERVAL_MS: 250;
        CHANNEL_OPEN_TIMEOUT_MS: 8000;
        BACKGROUND_SLOW_MS: 12000;
        BACKGROUND_STALE_MS: 20000;
        connectTimeoutMs: 12000;
        iceRestartBackoffMs: number[];
        rebuildAttempts: 1;
        recoveryStepTimeoutMs: 8000;
        reprobeIntervalsMs: number[];
        networkProbeIntervalMs: 10000;
        candidateBatchMs: 50;
        linkStateIntervalMs: 2000;
        statsIntervalMs: 1000;
        switchThreshold: 0.25;
        switchHoldMs: 3000;
        earlySwitchIntervalMs: 10000;
        maxRelayLoad: 0.8;
        maxRelayFlows: 32;
        relayHopDownMs: 3000;
        maxHops: 2;
        switchOverlapMinMs: 50;
        ackDelayMs: 100;
        ackEvery: 32;
        retransmitTimeoutMs: 3000;
        creditWindowBytes: 1048576;
        reliableBufferBytes: 16777216;
        relayQueueBytes: 2097152;
        hopHighWaterBytes: 1048576;
        hopLowWaterBytes: 262144;
        maxFragmentBytes: 65536;
        audioReserveBps: 64000;
        bweHeadroom: 0.9;
        bweReportIntervalMs: 500;
        bweDropReport: 0.2;
        bweResolutionSteps: number[][];
        bweFallbackBps: 1500000;
        logCapacity: 1024;
        logLevel: "info";
        logConsole: false;
        logRedact: false;
        shareLogWithPeers: false;
        relay: true;
        mediaRelay: "allow";
        allowRelay: any;
        turnMode: "fallback";
        stableTracks: false;
        maxPeers: 16;
        testHooks: any;
    }>>;
    clock: import("../util/clock.js").Clock;
    l: {
        debug: (msg: any, data: any) => void;
        info: (msg: any, data: any) => void;
        warn: (msg: any, data: any) => void;
        error: (msg: any, data: any) => void;
        ids: {
            peer?: string;
            session?: string;
        };
    };
    /** Link state. */
    get state(): string;
    /** Reason of the last state change. */
    get reason(): string;
    /** Milliseconds since data or media last arrived (consent too in background mode). */
    get silence(): number;
    /** Liveness verdict: `ok`, `slow` or `stale`. */
    get liveness(): string;
    /** True when `ctl` is open and data arrives in time. */
    get healthy(): boolean;
    /** True when the link can carry traffic now (healthy or slow). */
    get usable(): boolean;
    /** The current connection session id. */
    get session(): string;
    /** The current RTCPeerConnection, for advanced use. */
    get pc(): RTCPeerConnection;
    /** SCTP maximum message size of the current generation. */
    get maxMessageSize(): number;
    /** The last candidate pair dump. */
    get lastDump(): any;
    /** True while the remote side announced background mode. */
    get remoteBackground(): boolean;
    /** Starts the first generation. */
    start(): void;
    /**
     * Handles a signaling message from the neighbor (from the server or the mesh).
     * @param {object} msg
     */
    handleSignal(msg: object): void;
    /**
     * Records a round trip sample measured with the periodic `link-state` echo. It refreshes every
     * link-state period, while the candidate pair RTT refreshes only with consent checks.
     * @param {number} ms
     */
    noteControlRtt(ms: number): void;
    /** True when the selected pair runs over TURN on either side. */
    get viaTurn(): boolean;
    /**
     * ICE restart on a working link, e.g. after a network change (decision D15). The impolite
     * side restarts, the polite side asks for it.
     * @param {string} reason
     */
    iceRestart(reason: string): void;
    /**
     * Rebuilds the connection now. With `silent`, the old connection is abandoned without closing
     * it, so the remote side learns of the rebuild only from the new session id (test hook for
     * doc §3.6).
     */
    rebuild(reason?: string, silent?: boolean): void;
    /** Test hook: closes all transport channels of the current generation, like an SCTP abort. */
    abortTransport(): void;
    /** Re-checks liveness now and restarts ICE when the link is slow or stale. */
    checkNow(reason: any): void;
    /** Sends `bg` or `fg` (plan section 6.1). */
    setBackground(on: any): void;
    /**
     * Sends a control message on `ctl`.
     * @param {object} msg
     */
    sendCtl(msg: object): boolean;
    /** True when `ctl` is open in the current generation. */
    get ctlOpen(): boolean;
    /**
     * Queues an envelope on a transport channel.
     * @param {string} key
     * @param {string} flow
     * @param {Uint8Array} bytes
     */
    sendEnvelope(key: string, flow: string, bytes: Uint8Array): boolean;
    /** Bytes queued for a flow on a transport channel. */
    queuedBytes(key: any, flow: any): any;
    /** Transport channels of the current generation, for diagnostics. */
    get transports(): {
        key: any;
        id: any;
        ordered: any;
        maxRetransmits: any;
        maxPacketLifeTime: any;
        readyState: any;
    }[];
    /** Total bufferedAmount over the transport channels. */
    get bufferedAmount(): number;
    /**
     * Returns an idle or new send slot of `kind` and marks it used by `key`.
     * @param {"audio"|"video"} kind
     * @param {string} key
     * @returns {Promise<{tr: RTCRtpTransceiver, kind: string, key: string|null}>}
     */
    acquireSendSlot(kind: "audio" | "video", key: string): Promise<{
        tr: RTCRtpTransceiver;
        kind: string;
        key: string | null;
    }>;
    /**
     * Marks a slot idle and stops sending on it. No renegotiation.
     * @param {{tr: RTCRtpTransceiver, key: string|null}} slot
     */
    releaseSendSlot(slot: {
        tr: RTCRtpTransceiver;
        key: string | null;
    }): void;
    /** True when the slot belongs to the current generation. */
    ownsSlot(slot: any): boolean;
    /**
     * The receiving transceiver with `mid` in the current generation.
     * @param {string} mid
     */
    transceiver(mid: string): RTCRtpTransceiver;
    /** Asks for a renegotiation (impolite: offer; polite: `renegotiate`). */
    renegotiate(reason: any): void;
    /** Closes the link for good. */
    close(reason?: string): void;
    #private;
}
import { Emitter } from "../util/emitter.js";
