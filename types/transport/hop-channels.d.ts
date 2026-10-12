/**
 * Transport key of an end to end reliability mode.
 * @param {{ordered: boolean, maxRetransmits?: number|null, maxPacketLifeTime?: number|null}} mode
 */
export function modeKey(mode: {
    ordered: boolean;
    maxRetransmits?: number | null;
    maxPacketLifeTime?: number | null;
}): string;
/** Parses a partial mode key back into a mode. */
export function parseModeKey(key: any): {
    ordered: boolean;
    maxRetransmits?: undefined;
    maxPacketLifeTime?: undefined;
} | {
    ordered: boolean;
    maxRetransmits: number;
    maxPacketLifeTime?: undefined;
} | {
    ordered: boolean;
    maxRetransmits: number;
    maxPacketLifeTime: number;
};
export const CTL: "ctl";
export const REL: "rel";
export const UNREL: "unrel";
/** Transport channels of one peer connection. */
export class HopChannels extends Emitter {
    /**
     * @param {RTCPeerConnection} pc
     * @param {object} options
     * @param {boolean} options.impolite
     * @param {number} options.highWater
     * @param {number} options.lowWater
     * @param {number} options.flowLimit per-flow queue limit in bytes
     * @param {(event: string, data?: object) => void} [options.log]
     */
    constructor(pc: RTCPeerConnection, { impolite, highWater, lowWater, flowLimit, log }: {
        impolite: boolean;
        highWater: number;
        lowWater: number;
        flowLimit: number;
        log?: (event: string, data?: object) => void;
    });
    highWater: number;
    lowWater: number;
    flowLimit: number;
    log: (event: string, data?: object) => void;
    /** True when `ctl` is open. */
    get ctlOpen(): boolean;
    /** The SCTP maximum message size, or 65536 when unknown. */
    get maxMessageSize(): number;
    /**
     * Sends a control message on `ctl`. Queued while `ctl` is not open.
     * @param {object} msg
     */
    sendCtl(msg: object): boolean;
    /** Sends the 1 byte heartbeat on `ctl`. */
    sendBeat(): boolean;
    /**
     * Queues an envelope for `key`'s transport channel. Returns false when the flow's queue is
     * full; unreliable flows then drop their oldest message instead and return true.
     * @param {string} key transport key from `modeKey`
     * @param {string} flow flow identifier for fair scheduling
     * @param {Uint8Array} bytes
     */
    sendEnvelope(key: string, flow: string, bytes: Uint8Array): boolean;
    /** Bytes queued for `flow` on `key` that the browser has not taken yet. */
    queuedBytes(key: any, flow: any): any;
    /**
     * Makes sure a partial reliability transport exists. The impolite side creates it and
     * announces `transport-open`; the polite side asks with `open-transport` (decision D25).
     * @param {string} key
     */
    ensureMode(key: string): void;
    /**
     * Handles the transport control messages. Returns true when `msg` was one of them.
     * @param {object} msg
     */
    handleCtl(msg: object): boolean;
    /** Transport channels with their negotiated reliability, for diagnostics. */
    describe(): {
        key: any;
        id: any;
        ordered: any;
        maxRetransmits: any;
        maxPacketLifeTime: any;
        readyState: any;
    }[];
    /** Total bufferedAmount over all transport channels. */
    get bufferedAmount(): number;
    close(): void;
    #private;
}
import { Emitter } from "../util/emitter.js";
