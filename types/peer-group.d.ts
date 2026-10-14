/**
 * A group of peers in a mesh (plan section 3). The app owns membership: it calls `addPeer` and
 * `removePeer`, or enables `autoPeers` to follow the adapter's presence events.
 *
 * Events: `connection` (RalPeerConnection) when a connection is created, `peerleft`
 * (RalPeerConnection, reason), `presence` ({type, peer}).
 */
export class RalPeerGroup extends Emitter {
    /**
     * @param {object} options
     * @param {string} [options.selfId] fresh per page load (doc §7); generated when absent
     * @param {import("./signaling/adapter.js").SignalingAdapter | import("./signaling/create.js").SignalingOptions} options.signaling
     *   an adapter, or the settings of a reference server (see createSignaling)
     * @param {RTCIceServer[]} [options.iceServers]
     * @param {Partial<typeof import("./config.js").DEFAULTS>} [options.config]
     * @param {import("./util/clock.js").Clock} [options.clock]
     * @param {typeof RTCPeerConnection} [options.RTCPeerConnection]
     * @param {boolean} [options.autoPeers] add and remove peers from adapter presence events
     */
    constructor({ selfId, signaling, iceServers, config, clock, RTCPeerConnection: RTC, autoPeers }: {
        selfId?: string;
        signaling: import("./signaling/adapter.js").SignalingAdapter | import("./signaling/create.js").SignalingOptions;
        iceServers?: RTCIceServer[];
        config?: Partial<typeof import("./config.js").DEFAULTS>;
        clock?: import("./util/clock.js").Clock;
        RTCPeerConnection?: typeof RTCPeerConnection;
        autoPeers?: boolean;
    });
    /**
     * One connection per known peer, also when it could not be opened.
     * @type {Map<string, RalPeerConnection>}
     */
    connections: Map<string, RalPeerConnection>;
    /**
     * The current RalDirectPeerConnection of each connection that has one, i.e. every existing
     * RTCPeerConnection. Each is owned by its RalPeerConnection (`connection.directConn`), which
     * replaces the entry on a rebuild.
     * @type {Map<string, import("./direct/direct-peer-connection.js").RalDirectPeerConnection>}
     */
    directConns: Map<string, import("./direct/direct-peer-connection.js").RalDirectPeerConnection>;
    selfId: string;
    config: Readonly<{
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
    }>;
    clock: import("./util/clock.js").Clock;
    iceServers: RTCIceServer[];
    signaling: import("./signaling/adapter.js").SignalingAdapter | import("./signaling/create.js").SignalingOptions;
    RTC: {
        new (configuration?: RTCConfiguration): RTCPeerConnection;
        prototype: RTCPeerConnection;
        generateCertificate(keygenAlgorithm: AlgorithmIdentifier): Promise<RTCCertificate>;
    };
    autoPeers: boolean;
    log: RalLog;
    onListenerError: (error: any, name: any) => void;
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
    hooks: any;
    /** Protocol version this peer speaks (test hooks may override it). */
    protocol: any;
    router: SignalingRouter;
    media: MediaManager;
    routing: Routing;
    network: NetworkWatcher;
    /** Resolves when keys and capabilities are ready. */
    get ready(): Promise<void>;
    /** Local codec capabilities, once collected. */
    get localCaps(): any;
    /** RTCConfiguration for a direct connection (plan section 11). */
    rtcConfig(withTurn: any): {
        iceServers: RTCIceServer[];
        bundlePolicy: string;
    };
    /** True when TURN servers are configured. */
    get hasTurn(): boolean;
    /**
     * Adds a peer to the group and starts connecting to it. Returns the stable RalPeerConnection.
     * @param {string} peerId
     */
    addPeer(peerId: string): RalPeerConnection;
    /**
     * Removes a peer: sends `bye` and closes its direct connection.
     * @param {string} peerId
     */
    removePeer(peerId: string, reason?: string): void;
    /**
     * The index this side uses for `peerId` on `directConn`, allocating and announcing a new one.
     * @param {import("./direct/direct-peer-connection.js").RalDirectPeerConnection} directConn
     * @param {string} peerId
     */
    localIndex(directConn: import("./direct/direct-peer-connection.js").RalDirectPeerConnection, peerId: string): any;
    /** Peer id for an index in the neighbor's table, or undefined. */
    remoteIndex(directConn: any, idx: any): any;
    /** @internal neighbor id whose received tracks of `origin` the stable stream should use */
    mediaSourceFor(origin: any): any;
    /** @internal re-plans media on all open direct connections */
    mediaChanged(): void;
    /** True when this side wants `origin`'s track of `kind` and `tag`. */
    subscribed(origin: any, kind: any, tag: any): boolean;
    /** This side's subscription for `origin`. */
    subscription(origin: any): any;
    /** True when hello with `peerId` completed. */
    helloDone(peerId: any): boolean;
    /**
     * Publishes a local track to all peers or a list of peer ids.
     * @param {MediaStreamTrack} track
     * @param {{tag?: string, to?: "all" | string[]}} [options]
     */
    publish(track: MediaStreamTrack, options?: {
        tag?: string;
        to?: "all" | string[];
    }): import("./index.js").RalPublication;
    /**
     * Sets which media of `origin` this side wants. Unsubscribed flows stop at their source.
     * @param {string} origin
     * @param {import("./media/subscriptions.js").Subscription} sub
     */
    setSubscription(origin: string, sub: import("./media/subscriptions.js").Subscription): void;
    /**
     * Runs a liveness check on all direct connections at once; restarts ICE on slow or stale ones.
     */
    checkDirectConns(reason: any): void;
    /** ICE restart on every live direct connection (decision D15). */
    restartAll(reason: any): void;
    /** Sends `bye` to all peers via mesh and signaling. Usable from `pagehide`. */
    leave(): void;
    /** Browser and library features (plan section 10.6). */
    capabilities(): {
        setSinkId: boolean;
        getDisplayMedia: boolean;
        encodedTransform: boolean;
        encodedStreams: boolean;
        trackGenerator: boolean;
        networkInformation: boolean;
    };
    /** Per direct connection and per route metrics, relay load and budgets. */
    getStats(): {
        selfId: any;
        load: number;
        relayFlows: {
            flow: any;
            origin: any;
            target: any;
            role: any;
            kinds: any;
        }[];
        directConns: {};
        peers: {};
        budgets: {
            direct: any;
            relayed: any;
            reported: any;
        };
    };
    /** JSON-serializable bundle for problem reports (plan section 12.1). */
    diagnosticReport(): Promise<any>;
    /** Closes all connections. */
    close(reason?: string): void;
    /** True after close(). */
    get closed(): boolean;
    #private;
}
import { Emitter } from "./util/emitter.js";
import { RalPeerConnection } from "./peer-connection.js";
import { RalLog } from "./diag/log.js";
import { SignalingRouter } from "./signaling/router.js";
import { MediaManager } from "./media/media.js";
import { Routing } from "./routing/route.js";
import { NetworkWatcher } from "./direct/network.js";
