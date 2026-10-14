/**
 * @typedef {object} DirectHooks callbacks of the owning RalPeerConnection
 * @property {(msg: object) => void} signal sends a signaling message (session ids added)
 * @property {(task: () => Promise<void>) => void} enqueue runs a negotiation task in order
 * @property {() => void} open `ctl` opened
 * @property {() => void} ctlClosed the remote side closed `ctl`
 * @property {(msg: object) => void} ctl control message not handled here
 * @property {(bytes: Uint8Array, key: string) => void} envelope
 * @property {(key: string) => void} drain a transport channel can take more data
 * @property {() => void} remotetrack the browser fired `track`
 * @property {() => void} negotiated a negotiation round completed
 * @property {(metrics: object, stats: RTCStatsReport) => void} metrics
 * @property {(state: string, silence: number) => void} liveness local liveness verdict changed
 * @property {(state: string) => void} remoteVerdict the remote side's verdict changed
 * @property {() => void} connected ICE connected for the first time
 * @property {() => void} failed the connection state became `failed`
 * @property {() => void} watchdog `ctl` did not open in time after ICE connected
 * @property {() => void} connectTimeout `ctl` did not open within `connectTimeoutMs`
 */
/** @typedef {InstanceType<ReturnType<typeof defineClass>>} RalDirectPeerConnection */
/**
 * The RalDirectPeerConnection class on top of `Base`, the browser's RTCPeerConnection or an
 * injected subclass of it. Classes are cached per base.
 * @param {typeof RTCPeerConnection} Base
 */
export function directPeerConnectionClass(Base: typeof RTCPeerConnection): any;
/**
 * callbacks of the owning RalPeerConnection
 */
export type DirectHooks = {
    /**
     * sends a signaling message (session ids added)
     */
    signal: (msg: object) => void;
    /**
     * runs a negotiation task in order
     */
    enqueue: (task: () => Promise<void>) => void;
    /**
     * `ctl` opened
     */
    open: () => void;
    /**
     * the remote side closed `ctl`
     */
    ctlClosed: () => void;
    /**
     * control message not handled here
     */
    ctl: (msg: object) => void;
    envelope: (bytes: Uint8Array, key: string) => void;
    /**
     * a transport channel can take more data
     */
    drain: (key: string) => void;
    /**
     * the browser fired `track`
     */
    remotetrack: () => void;
    /**
     * a negotiation round completed
     */
    negotiated: () => void;
    metrics: (metrics: object, stats: RTCStatsReport) => void;
    /**
     * local liveness verdict changed
     */
    liveness: (state: string, silence: number) => void;
    /**
     * the remote side's verdict changed
     */
    remoteVerdict: (state: string) => void;
    /**
     * ICE connected for the first time
     */
    connected: () => void;
    /**
     * the connection state became `failed`
     */
    failed: () => void;
    /**
     * `ctl` did not open in time after ICE connected
     */
    watchdog: () => void;
    /**
     * `ctl` did not open within `connectTimeoutMs`
     */
    connectTimeout: () => void;
};
export type RalDirectPeerConnection = InstanceType<ReturnType<typeof defineClass>>;
/** @param {typeof RTCPeerConnection} Base */
declare function defineClass(Base: typeof RTCPeerConnection): {
    new (rtcConfig: RTCConfiguration, { connection, remoteId, impolite, config, clock, log, hooks }: {
        connection: object;
        remoteId: string;
        impolite: boolean;
        config: Readonly<typeof import("../config.js").DEFAULTS>;
        clock: import("../util/clock.js").Clock;
        log: ReturnType<import("../diag/log.js").RalLog["scope"]>;
        hooks: DirectHooks;
    }): {
        "__#private@#hooks": DirectHooks;
        "__#private@#config": Readonly<Readonly<{
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
            sleepCheckIntervalMs: 1000;
            sleepMinMs: 2000;
            sleepRebuildMs: 30000;
            candidateBatchMs: 50;
            directTableIntervalMs: 2000;
            statsIntervalMs: 1000;
            switchThreshold: 0.25;
            switchHoldMs: 3000;
            earlySwitchIntervalMs: 10000;
            maxRelayLoad: 0.8;
            maxRelayFlows: 32;
            relayPeerDownMs: 3000;
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
        "__#private@#clock": import("../util/clock.js").Clock;
        "__#private@#l": {
            debug: (msg: any, data: any) => void;
            info: (msg: any, data: any) => void;
            warn: (msg: any, data: any) => void;
            error: (msg: any, data: any) => void;
            ids: {
                peer?: string;
                session?: string;
            };
        };
        "__#private@#hop": HopChannels;
        "__#private@#neg": Negotiator;
        "__#private@#batcher": CandidateBatcher;
        "__#private@#monitor": LivenessMonitor;
        "__#private@#heartbeat": Heartbeat;
        "__#private@#watchdog": Watchdog;
        "__#private@#checkTimer": any;
        "__#private@#statsTimer": any;
        "__#private@#connectTimer": any;
        "__#private@#polling": boolean;
        "__#private@#lastVerdictAt": number;
        "__#private@#remoteVerdict": string;
        "__#private@#lastCounters": Map<any, any>;
        "__#private@#ctlRtt": any;
        "__#private@#metrics": {
            rtt: any;
            bitrate: any;
            loss: any;
            candidateType: any;
            remoteCandidateType: any;
        };
        "__#private@#ctlOpen": boolean;
        "__#private@#everConnected": boolean;
        "__#private@#closed": boolean;
        "__#private@#retired": Promise<any>;
        "__#private@#onRetired": any;
        /** @type {{tr: RTCRtpTransceiver, kind: string, key: string|null}[]} */
        "__#private@#slots": {
            tr: RTCRtpTransceiver;
            kind: string;
            key: string | null;
        }[];
        /** @type {Map<string, {kind: string, resolve: Function, reject: Function}>} */
        "__#private@#slotRequests": Map<string, {
            kind: string;
            resolve: Function;
            reject: Function;
        }>;
        /** @type {{req: string, tr: RTCRtpTransceiver}[]} */
        "__#private@#grants": {
            req: string;
            tr: RTCRtpTransceiver;
        }[];
        /** @type {Set<Function>} */
        "__#private@#stableWaiters": Set<Function>;
        /** Session id of this connection. */
        ralSession: string;
        /** Session id of the remote side's connection, once known. */
        ralRemoteSession: any;
        /** The RalPeerConnection this connection belongs to. */
        ralConnection: any;
        ralRemoteId: string;
        ralImpolite: boolean;
        onicecandidate: (e: any) => void;
        onnegotiationneeded: () => void;
        oniceconnectionstatechange: () => void;
        onconnectionstatechange: () => void;
        ontrack: () => void;
        /** True after ralRetire(). */
        get ralClosed(): boolean;
        /** True when `ctl` is open. */
        get ralCtlOpen(): boolean;
        /** True when `ctl` is open and data arrives in time. */
        get ralHealthy(): boolean;
        /** True when the connection can carry traffic now (healthy or slow). */
        get ralUsable(): boolean;
        /** Milliseconds since data or media last arrived (consent too in background mode). */
        get ralSilence(): number;
        /** Liveness verdict: `ok`, `slow` or `stale`. */
        get ralLiveness(): string;
        /** True while the remote side announced background mode. */
        get ralRemoteBackground(): boolean;
        /** Latest metrics (plan section 7.1). */
        get ralMetrics(): {
            state: string;
            rtt: any;
            bitrate: any;
            loss: any;
            candidateType: any;
            remoteCandidateType: any;
        };
        /** True when the selected pair runs over TURN on either side. */
        get ralViaTurn(): boolean;
        /** SCTP maximum message size. */
        get ralMaxMessageSize(): number;
        /** Transport channels, for diagnostics. */
        get ralTransports(): {
            key: any;
            id: any;
            ordered: any;
            maxRetransmits: any;
            maxPacketLifeTime: any;
            readyState: any;
        }[];
        /** Total bufferedAmount over the transport channels. */
        get ralBufferedAmount(): number;
        /**
         * Sends a signaling message to the neighbor, tagged with both session ids.
         * @param {object} msg
         */
        ralSignal(msg: object): void;
        /**
         * Applies an `offer`, `answer` or `cand` message.
         * @param {object} msg
         */
        ralHandleSignal(msg: object): Promise<any>;
        /** Runs a negotiation round (impolite: offer; polite: `renegotiate`). */
        ralNegotiate(reason: any): Promise<any>;
        /** Restarts ICE now, rolling back an unanswered offer first. */
        ralIceRestart(): Promise<any>;
        "__#private@#iceRestart"(): Promise<void>;
        /**
         * Settles with `operation` or when this connection is retired, whichever comes first.
         * Chromium leaves the promise of an operation pending forever when the connection closes
         * under it, which would block the owner's negotiation queue for every later connection.
         */
        "__#private@#untilRetired"(operation: any): Promise<any>;
        /**
         * Sends a control message on `ctl`.
         * @param {object} msg
         */
        ralSendCtl(msg: object): boolean;
        /**
         * Queues an envelope on a transport channel.
         * @param {string} key
         * @param {string} flow
         * @param {Uint8Array} bytes
         */
        ralSendEnvelope(key: string, flow: string, bytes: Uint8Array): boolean;
        /** Bytes queued for a flow on a transport channel. */
        ralQueuedBytes(key: any, flow: any): any;
        /** Sends `bg` or `fg` (plan section 6.1). */
        ralSetBackground(on: any): void;
        /** Beats and re-checks liveness now. Returns true when the connection is slow or stale. */
        ralCheckNow(): boolean;
        /**
         * Records a round trip sample measured with the periodic `direct-table` echo. It refreshes
         * every direct-table period, while the candidate pair RTT refreshes only with consent checks.
         * @param {number} ms
         */
        ralNoteControlRtt(ms: number): void;
        /** Test hook: closes all transport channels, like an SCTP abort. */
        ralAbortTransport(): void;
        /**
         * Ends this connection. With `silent`, closing waits 30 s, so the remote side learns of a
         * rebuild only from the new session id (test hook for doc §3.6).
         */
        ralRetire(silent?: boolean): void;
        "__#private@#onStable"(): void;
        "__#private@#onIceState"(): void;
        "__#private@#onConnState"(): void;
        "__#private@#onCtlOpen"(): void;
        "__#private@#onTransportClose"(key: any): void;
        "__#private@#onWatchdog"(): void;
        "__#private@#onCtl"(msg: any): void;
        "__#private@#onLiveness"(state: any, silence: any): void;
        "__#private@#check"(): void;
        "__#private@#sendVerdict"(state: any): void;
        /**
         * Local arrival time of the last packet a stats object counts: from
         * `lastPacketReceivedTimestamp`, or, where a browser lacks it, `fallback` when the `counter`
         * grew since the previous poll.
         */
        "__#private@#lastArrival"(s: any, counter: any, key: any, now: any, fallback: any): any;
        "__#private@#pollLiveness"(): Promise<void>;
        "__#private@#collectStats"(): Promise<void>;
        "__#private@#metricState"(): string;
        /**
         * Returns an idle or new send slot of `kind` and marks it used by `key`.
         * @param {"audio"|"video"} kind
         * @param {string} key
         * @returns {Promise<{tr: RTCRtpTransceiver, kind: string, key: string|null}>}
         */
        ralAcquireSendSlot(kind: "audio" | "video", key: string): Promise<{
            tr: RTCRtpTransceiver;
            kind: string;
            key: string | null;
        }>;
        /**
         * Marks a slot idle and stops sending on it. No renegotiation.
         * @param {{tr: RTCRtpTransceiver, key: string|null}} slot
         */
        ralReleaseSendSlot(slot: {
            tr: RTCRtpTransceiver;
            key: string | null;
        }): void;
        /** True when the slot belongs to this connection and it is not retired. */
        ralOwnsSlot(slot: any): boolean;
        /**
         * The receiving transceiver with `mid`.
         * @param {string} mid
         */
        ralTransceiver(mid: string): RTCRtpTransceiver;
        "__#private@#waitStable"(cond: any): Promise<any>;
        "__#private@#onSlotRequest"(msg: any): void;
        "__#private@#offerExtras"(): {
            grants?: undefined;
        } | {
            grants: any[];
        };
        "__#private@#applyGrants"(msg: any): void;
        readonly canTrickleIceCandidates: boolean | null;
        readonly connectionState: RTCPeerConnectionState;
        readonly currentLocalDescription: RTCSessionDescription | null;
        readonly currentRemoteDescription: RTCSessionDescription | null;
        readonly iceConnectionState: RTCIceConnectionState;
        readonly iceGatheringState: RTCIceGatheringState;
        readonly localDescription: RTCSessionDescription | null;
        ondatachannel: ((this: RTCPeerConnection, ev: RTCDataChannelEvent) => any) | null;
        onicecandidateerror: ((this: RTCPeerConnection, ev: RTCPeerConnectionIceErrorEvent) => any) | null;
        onicegatheringstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        onsignalingstatechange: ((this: RTCPeerConnection, ev: Event) => any) | null;
        readonly pendingLocalDescription: RTCSessionDescription | null;
        readonly pendingRemoteDescription: RTCSessionDescription | null;
        readonly remoteDescription: RTCSessionDescription | null;
        readonly sctp: RTCSctpTransport | null;
        readonly signalingState: RTCSignalingState;
        addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
        addIceCandidate(candidate: RTCIceCandidateInit | null, successCallback: VoidFunction, failureCallback: RTCPeerConnectionErrorCallback): Promise<void>;
        addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
        addTransceiver(trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit): RTCRtpTransceiver;
        close(): void;
        createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
        createAnswer(successCallback: RTCSessionDescriptionCallback, failureCallback: RTCPeerConnectionErrorCallback): Promise<void>;
        createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit): RTCDataChannel;
        createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
        createOffer(successCallback: RTCSessionDescriptionCallback, failureCallback: RTCPeerConnectionErrorCallback, options?: RTCOfferOptions): Promise<void>;
        getConfiguration(): RTCConfiguration;
        getReceivers(): RTCRtpReceiver[];
        getSenders(): RTCRtpSender[];
        getStats(selector?: MediaStreamTrack | null): Promise<RTCStatsReport>;
        getTransceivers(): RTCRtpTransceiver[];
        removeTrack(sender: RTCRtpSender): void;
        restartIce(): void;
        setConfiguration(configuration?: RTCConfiguration): void;
        setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
        setLocalDescription(description: RTCLocalSessionDescriptionInit, successCallback: VoidFunction, failureCallback: RTCPeerConnectionErrorCallback): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
        setRemoteDescription(description: RTCSessionDescriptionInit, successCallback: VoidFunction, failureCallback: RTCPeerConnectionErrorCallback): Promise<void>;
        addEventListener<K extends keyof RTCPeerConnectionEventMap>(type: K, listener: (this: RTCPeerConnection, ev: RTCPeerConnectionEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
        addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
        removeEventListener<K extends keyof RTCPeerConnectionEventMap>(type: K, listener: (this: RTCPeerConnection, ev: RTCPeerConnectionEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
        dispatchEvent(event: Event): boolean;
    };
    generateCertificate(keygenAlgorithm: AlgorithmIdentifier): Promise<RTCCertificate>;
};
import { HopChannels } from "../transport/hop-channels.js";
import { Negotiator } from "./negotiation.js";
import { CandidateBatcher } from "../signaling/queue.js";
import { LivenessMonitor } from "../liveness/monitor.js";
import { Heartbeat } from "../liveness/heartbeat.js";
import { Watchdog } from "./watchdog.js";
export {};
