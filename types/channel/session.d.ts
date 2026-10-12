/**
 * End to end session with one remote peer (plan section 9.2): the end to end control channel 0,
 * user channels, acks and credits. Route-agnostic: envelopes go out through `transmit` and come
 * in through `receive`.
 *
 * Events: `channel` (RealticChannel), `control` (msg) for control messages other than channel
 * setup, `beat`.
 */
export class Session extends Emitter {
    /**
     * @param {object} options
     * @param {boolean} options.impolite
     * @param {Readonly<typeof import("../config.js").DEFAULTS>} options.config
     * @param {import("../util/clock.js").Clock} options.clock
     * @param {(e: {type: number, channelId: number, seq: number, payload: Uint8Array, lifetime?: number}, key: string) => boolean} options.transmit
     * @param {ReturnType<import("../diag/log.js").Log["scope"]>} options.log
     */
    constructor({ impolite, config, clock, transmit, log }: {
        impolite: boolean;
        config: Readonly<typeof import("../config.js").DEFAULTS>;
        clock: import("../util/clock.js").Clock;
        transmit: (e: {
            type: number;
            channelId: number;
            seq: number;
            payload: Uint8Array;
            lifetime?: number;
        }, key: string) => boolean;
        log: ReturnType<import("../diag/log.js").Log["scope"]>;
    });
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
        maxHops: 1;
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
    transmit: (e: {
        type: number;
        channelId: number;
        seq: number;
        payload: Uint8Array;
        lifetime?: number;
    }, key: string) => boolean;
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
    /**
     * Creates a user channel (state `connecting`) and announces it with `ch-open`.
     * @param {string} label
     * @param {{ordered?: boolean, maxRetransmits?: number, maxPacketLifeTime?: number, protocol?: string}} [init]
     */
    createChannel(label: string, init?: {
        ordered?: boolean;
        maxRetransmits?: number;
        maxPacketLifeTime?: number;
        protocol?: string;
    }): RealticChannel;
    /**
     * Sends a message on the end to end control channel.
     * @param {object} msg
     */
    sendControl(msg: object): void;
    /** @internal used by RealticChannel */
    sendUser(id: any, payload: any): void;
    /** @internal used by RealticChannel */
    bufferedAmount(id: any): any;
    /** @internal used by RealticChannel */
    closeChannel(id: any): void;
    /**
     * Handles one complete (reassembled, decrypted) envelope.
     * @param {{type: number, channelId: number, seq: number}} e
     * @param {Uint8Array} payload
     */
    receive(e: {
        type: number;
        channelId: number;
        seq: number;
    }, payload: Uint8Array): void;
    /** Sends an end to end beat (relayed routes). */
    sendBeat(): void;
    /** After a route change: resend unacknowledged data and re-grant credit. */
    routeChanged(): void;
    /** Lets senders hand queued data to the route again (transport drained). */
    pump(): void;
    /** Open user channels. */
    get channels(): any[];
    /** Total bytes not yet acknowledged over all reliable channels. */
    get unackedBytes(): number;
    /** Closes all channels. */
    close(): void;
    #private;
}
import { Emitter } from "../util/emitter.js";
import { RealticChannel } from "./channel.js";
