/**
 * Encodes a user message: one kind byte (0 binary, 1 text) followed by the bytes.
 * @param {string | ArrayBuffer | ArrayBufferView} data
 */
export function encodeMessage(data: string | ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer>;
/**
 * Decodes a user message into a string or an ArrayBuffer.
 * @param {Uint8Array} payload
 */
export function decodeMessage(payload: Uint8Array): string | ArrayBuffer;
/**
 * End to end data channel with `RTCDataChannel`-like API (plan section 9.2). Survives route
 * changes, ICE restarts and link rebuilds. Created by `peer.createChannel()` or delivered by the
 * peer's `channel` event.
 */
export class RalDataChannel extends EventTarget {
    /**
     * @param {object} session internal end to end session
     * @param {number} id
     * @param {{label: string, protocol?: string, ordered?: boolean, maxRetransmits?: number, maxPacketLifeTime?: number}} init
     */
    constructor(session: object, id: number, init: {
        label: string;
        protocol?: string;
        ordered?: boolean;
        maxRetransmits?: number;
        maxPacketLifeTime?: number;
    });
    /** End to end channel id. */
    id: number;
    label: string;
    protocol: string;
    ordered: boolean;
    maxRetransmits: number;
    maxPacketLifeTime: number;
    negotiated: boolean;
    /** Only `"arraybuffer"` is supported. */
    binaryType: string;
    /** `connecting` | `open` | `closing` | `closed` */
    get readyState(): string;
    /** Bytes accepted by `send` and not yet handed to the network. */
    get bufferedAmount(): any;
    set bufferedAmountLowThreshold(n: number);
    get bufferedAmountLowThreshold(): number;
    /**
     * Sends a message. Throws `InvalidStateError` unless open, and `OperationError` when the
     * outage buffer of a reliable channel is full.
     * @param {string | ArrayBuffer | ArrayBufferView} data
     */
    send(data: string | ArrayBuffer | ArrayBufferView): void;
    /** Closes the channel after the reliable data sent before is delivered. */
    close(): void;
    /** @internal */
    _setState(state: any): void;
    /** @internal */
    _deliver(payload: any): void;
    /** @internal */
    _drained(before: any): void;
    set onopen(fn: any);
    get onopen(): any;
    set onmessage(fn: any);
    get onmessage(): any;
    set onclose(fn: any);
    get onclose(): any;
    set onerror(fn: any);
    get onerror(): any;
    set onbufferedamountlow(fn: any);
    get onbufferedamountlow(): any;
    #private;
}
