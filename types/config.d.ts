/**
 * Returns the defaults merged with `overrides`.
 * @param {Partial<typeof DEFAULTS>} [overrides]
 */
export function makeConfig(overrides?: Partial<typeof DEFAULTS>): Readonly<{
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
    restartRequestGapMs: 2000;
    reprobeIntervalsMs: number[];
    networkProbeIntervalMs: 10000;
    sleepCheckIntervalMs: 1000;
    sleepMinMs: 2000;
    sleepRebuildMs: 30000;
    helloRetryMs: 3000;
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
/**
 * Default configuration. Every timing and tunable of the library lives here and can be
 * overridden per group through `new RalPeerGroup({ config })`. Timing values follow doc §3.5.
 */
export const DEFAULTS: Readonly<{
    /** Sender sends a 1 byte beat on `ctl` after this long without sending anything. */
    HEARTBEAT_IDLE_MS: 500;
    /**
     * Silence after which a direct connection or route is `slow`. Do not go below 1000 (WiFi power
     * save).
     */
    SLOW_CONNECTION_MS: 1000;
    /** Silence after which a direct connection or route is stale and recovery starts. */
    STALE_CONNECTION_MS: 5000;
    /** Period of the receiver side silence check. */
    LIVENESS_CHECK_INTERVAL_MS: 250;
    /** Time from ICE `connected` to `ctl` open before the direct connection is rebuilt. */
    CHANNEL_OPEN_TIMEOUT_MS: 8000;
    /** Slow threshold while the remote side announced background mode (judged by ICE consent). */
    BACKGROUND_SLOW_MS: 12000;
    /** Stale threshold while the remote side announced background mode. */
    BACKGROUND_STALE_MS: 20000;
    /** Time a new connection may take until `ctl` opens before recovery starts. */
    connectTimeoutMs: 12000;
    /** Delays before the ICE restarts of one recovery attempt; after the last, a full rebuild. */
    iceRestartBackoffMs: number[];
    /**
     * Number of full rebuilds after the ICE restarts before the direct connection is `unreachable`.
     */
    rebuildAttempts: 1;
    /** Time an ICE restart or rebuild may take to reach `connected` before the next step. */
    recoveryStepTimeoutMs: 8000;
    /**
     * Minimum time between two ICE restarts and between two rebuilds of one direct connection;
     * requests inside it are ignored, so both sides asking at once cause one restart.
     */
    restartRequestGapMs: 2000;
    /** Background re-probe intervals after `unreachable`; the last value repeats. */
    reprobeIntervalsMs: number[];
    /** Period of the network change probe (srflx candidate comparison). */
    networkProbeIntervalMs: 10000;
    /** Period of the sleep check timer. */
    sleepCheckIntervalMs: 1000;
    /** A sleep check tick this late or later is a sleep; less is load on the main thread. */
    sleepMinMs: 2000;
    /**
     * After a sleep this long, direct connections are rebuilt at once instead of ICE restarted: ICE
     * consent (30 s) has expired and the other side's recovery is far along. See sleepReaction.
     */
    sleepRebuildMs: 30000;
    /** Period of `hello` resends until the peer answers. */
    helloRetryMs: 3000;
    /** Candidate batching window (doc §2.4). */
    candidateBatchMs: 50;
    /** Direct connection table broadcast period. */
    directTableIntervalMs: 2000;
    /** getStats() based direct connection metric period. */
    statsIntervalMs: 1000;
    /** Relative cost improvement a route needs before it replaces the current one. */
    switchThreshold: 0.25;
    /** Time the improvement must hold. */
    switchHoldMs: 3000;
    /** Minimum time between two early switches to a standby relay per pair. */
    earlySwitchIntervalMs: 10000;
    /** Relay load above which a relay refuses or is not chosen. */
    maxRelayLoad: 0.8;
    /** Maximum number of relay flows a peer accepts. */
    maxRelayFlows: 32;
    /**
     * A relay sends `route-down` for an end silent this long, before the direct connection's own
     * stale verdict.
     */
    relayPeerDownMs: 3000;
    /**
     * Maximum hops (direct connections) of a route: 1 is direct, 2 is through one relay. Only 2 is
     * supported.
     */
    maxHops: 2;
    /** Make-before-break overlap of a planned route switch, in RTTs, bounded below. */
    switchOverlapMinMs: 50;
    /** Cumulative end to end acks are sent after this delay or this many messages. */
    ackDelayMs: 100;
    ackEvery: 32;
    /** End to end retransmit timeout of reliable channels (lower bound, doubles per retry). */
    retransmitTimeoutMs: 3000;
    /** Credit window per reliable channel (bytes in flight). */
    creditWindowBytes: 1048576;
    /** Outage buffer per reliable channel: unacknowledged plus queued bytes. */
    reliableBufferBytes: 16777216;
    /** Relay per-flow queue limit in bytes. */
    relayQueueBytes: 2097152;
    /** Hop transport channel buffer level above which sending pauses. */
    hopHighWaterBytes: 1048576;
    /** Hop transport channel `bufferedAmountLowThreshold`. */
    hopLowWaterBytes: 262144;
    /** Upper bound for envelope fragments, also limited by `sctp.maxMessageSize`. */
    maxFragmentBytes: 65536;
    /** Audio reservation per audio flow in the per direct connection budget (bits per second). */
    audioReserveBps: 64000;
    /** Fraction of `availableOutgoingBitrate` distributed as budgets. */
    bweHeadroom: 0.9;
    /** Minimum time between two budget reports. */
    bweReportIntervalMs: 500;
    /** Relative budget drop that is reported at once. */
    bweDropReport: 0.2;
    /** Bitrate steps at which `scaleResolutionDownBy` grows: [bps, scale]. */
    bweResolutionSteps: number[][];
    /** Budget assumed when a browser reports no `availableOutgoingBitrate`. */
    bweFallbackBps: 1500000;
    /** Ring buffer size of the log. */
    logCapacity: 1024;
    /** Minimum level of the `entry` event and the console mirror. */
    logLevel: "info";
    /** Mirror log entries to the console. */
    logConsole: false;
    /** Replace IP addresses in log entries and reports with placeholders. */
    logRedact: false;
    /** Answer `peer.requestLog()` of remote peers. */
    shareLogWithPeers: false;
    /** Act as relay for other pairs. */
    relay: true;
    /** `"allow"` or `"never"`: whether media of this peer may be re-encoded by a relay. */
    mediaRelay: "allow";
    /** Narrows relay authorization: `(originId, targetId) => boolean`. */
    allowRelay: any;
    /** `"fallback"`, `"always"` or `"relay-only"`, see section 11 of the plan. */
    turnMode: "fallback";
    /** Give a single generated track per publication that never changes (where supported). */
    stableTracks: false;
    /** Documented test target, not a hard limit. */
    maxPeers: 16;
    /** Test-only hooks, see the integration tests. */
    testHooks: any;
}>;
/** Protocol version of this library build (section 9.1). */
export const PROTOCOL: Readonly<{
    major: 1;
    minor: 0;
    features: string[];
}>;
/** Library version. */
export const VERSION: "0.1.0";
