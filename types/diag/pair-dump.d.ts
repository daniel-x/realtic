/** Reads the stats report into plain maps. */
export function readStats(pc: any): Promise<Map<any, any>>;
/** Returns the selected candidate pair stats object, or undefined. */
export function selectedPair(stats: any): any;
/**
 * Builds a dump. With `all`, every pair is listed; otherwise only the selected one.
 * @param {Map<string, any>} stats
 * @param {boolean} all
 */
export function pairDump(stats: Map<string, any>, all: boolean): {
    selected: {
        state: any;
        nominated: any;
        requestsSent: any;
        responsesReceived: any;
        bytesSent: any;
        bytesReceived: any;
        rtt: string | number;
        local: {
            type: any;
            protocol: any;
            address: any;
            port: any;
            mdns: boolean;
            relayProtocol: any;
            url: any;
        };
        remote: {
            type: any;
            protocol: any;
            address: any;
            port: any;
            mdns: boolean;
            relayProtocol: any;
            url: any;
        };
    };
};
/** Summarizes a dump for the size-capped log `data` field. */
export function summarizeDump(dump: any): {
    selected: string;
    pairs: any;
    pairCount: any;
    local: any;
    remote: any;
};
