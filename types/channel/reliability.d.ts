/**
 * Reliability mode of an end to end channel.
 * @typedef {object} Mode
 * @property {boolean} ordered
 * @property {number} [maxRetransmits]
 * @property {number} [maxPacketLifeTime]
 */
/** True when the mode is fully reliable. */
export function isReliable(mode: any): boolean;
/** Credit a sender may use before the first grant arrives (protocol constant). */
export const INITIAL_CREDIT: 262144;
/**
 * Sending half of an end to end channel (plan section 9.2). Reliable channels keep a retransmit
 * buffer until cumulative acks arrive and respect end to end credits; unreliable channels only
 * number their messages.
 */
export class ChannelSender {
    /**
     * @param {object} options
     * @param {Mode} options.mode
     * @param {import("../util/clock.js").Clock} options.clock
     * @param {(m: {seq: number, payload: Uint8Array, lifetime?: number}) => boolean} options.transmit
     *   hands one message to the route; returns false when the route cannot take more now
     * @param {number} [options.bufferLimit] outage buffer of reliable channels
     * @param {number} [options.rtoMs]
     * @param {() => void} [options.onDrain] called when queued bytes fall
     */
    constructor({ mode, clock, transmit, bufferLimit, rtoMs, onDrain }: {
        mode: Mode;
        clock: import("../util/clock.js").Clock;
        transmit: (m: {
            seq: number;
            payload: Uint8Array;
            lifetime?: number;
        }) => boolean;
        bufferLimit?: number;
        rtoMs?: number;
        onDrain?: () => void;
    });
    mode: Mode;
    reliable: boolean;
    clock: import("../util/clock.js").Clock;
    transmit: (m: {
        seq: number;
        payload: Uint8Array;
        lifetime?: number;
    }) => boolean;
    bufferLimit: number;
    rtoMs: number;
    onDrain: () => void;
    /** Bytes accepted by `send` but not yet handed to the route. */
    get queuedBytes(): number;
    /** Bytes handed to the route but not yet acknowledged (reliable only). */
    get unackedBytes(): number;
    /** Number of unacknowledged messages. */
    get unackedCount(): number;
    /**
     * Accepts a message. Throws `OperationError` when a reliable channel's outage buffer would
     * overflow, as `RTCDataChannel.send` does on a full buffer.
     * @param {Uint8Array} payload
     */
    send(payload: Uint8Array): void;
    /** Hands queued messages to the route while credit and route capacity allow. */
    pump(): void;
    /**
     * Cumulative ack: every message up to and including `seq` arrived.
     * @param {number} seq
     */
    onAck(seq: number): void;
    /**
     * Cumulative credit: the receiver allows sending up to `limit` bytes in total (mod 2^32).
     * @param {number} limit
     */
    onCredit(limit: number): void;
    /** Resends every unacknowledged message, e.g. after a route change. */
    retransmitAll(): void;
    /** Stops timers and drops all buffers. */
    close(): void;
    /** True when nothing is queued or unacknowledged. */
    get idle(): boolean;
    #private;
}
/**
 * Receiving half of an end to end channel: deduplication, ordering, cumulative acks and credit
 * grants (plan section 9.2, 9.3).
 */
export class ChannelReceiver {
    /**
     * @param {object} options
     * @param {Mode} options.mode
     * @param {import("../util/clock.js").Clock} options.clock
     * @param {(payload: Uint8Array) => void} options.deliver
     * @param {(seq: number) => void} options.sendAck
     * @param {(limit: number) => void} options.sendCredit
     * @param {number} [options.ackDelayMs]
     * @param {number} [options.ackEvery]
     * @param {number} [options.window] credit window in bytes
     */
    constructor({ mode, clock, deliver, sendAck, sendCredit, ackDelayMs, ackEvery, window }: {
        mode: Mode;
        clock: import("../util/clock.js").Clock;
        deliver: (payload: Uint8Array) => void;
        sendAck: (seq: number) => void;
        sendCredit: (limit: number) => void;
        ackDelayMs?: number;
        ackEvery?: number;
        window?: number;
    });
    mode: Mode;
    reliable: boolean;
    clock: import("../util/clock.js").Clock;
    deliver: (payload: Uint8Array) => void;
    sendAck: (seq: number) => void;
    sendCredit: (limit: number) => void;
    ackDelayMs: number;
    ackEvery: number;
    window: number;
    /** Highest seq up to which everything was received (reliable channels). */
    get cumulative(): number;
    /**
     * Handles one arrived message.
     * @param {number} seq
     * @param {Uint8Array} payload
     */
    receive(seq: number, payload: Uint8Array): void;
    /** Sends the pending cumulative ack now. */
    flushAck(): void;
    /** Re-sends the current credit grant (after a route change a grant may have been lost). */
    regrant(): void;
    /** True when no out-of-order messages are held. */
    get settled(): boolean;
    close(): void;
    #private;
}
/**
 * Reliability mode of an end to end channel.
 */
export type Mode = {
    ordered: boolean;
    maxRetransmits?: number;
    maxPacketLifeTime?: number;
};
