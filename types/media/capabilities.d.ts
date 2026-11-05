/**
 * Estimates encoding of a video format with `mediaCapabilities.encodingInfo`. Firefox accepts the
 * type "transmission" only, Chromium "webrtc". Null when the browser gives no estimate.
 * @param {{contentType?: string, width: number, height: number, bitrate: number, framerate: number}} format
 * @returns {Promise<{supported: boolean, smooth: boolean, powerEfficient: boolean}|null>}
 */
export function probeEncoding({ contentType, width, height, bitrate, framerate }: {
    contentType?: string;
    width: number;
    height: number;
    bitrate: number;
    framerate: number;
}): Promise<{
    supported: boolean;
    smooth: boolean;
    powerEfficient: boolean;
} | null>;
/** Feature flags of this browser. */
export function features(): {
    setSinkId: boolean;
    getDisplayMedia: boolean;
    encodedTransform: boolean;
    encodedStreams: boolean;
    trackGenerator: boolean;
    networkInformation: boolean;
};
/**
 * Collects codec lists, decode probes and features. Never rejects.
 * @param {number} [timeoutMs]
 */
export function collect(timeoutMs?: number): Promise<{
    send: {
        audio: any[];
        video: any[];
    };
    recv: {
        audio: any[];
        video: any[];
    };
    decode: {};
    encode: {};
    features: {
        setSinkId: boolean;
        getDisplayMedia: boolean;
        encodedTransform: boolean;
        encodedStreams: boolean;
        trackGenerator: boolean;
        networkInformation: boolean;
    };
}>;
