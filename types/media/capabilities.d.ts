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
    features: {
        setSinkId: boolean;
        getDisplayMedia: boolean;
        encodedTransform: boolean;
        encodedStreams: boolean;
        trackGenerator: boolean;
        networkInformation: boolean;
    };
}>;
