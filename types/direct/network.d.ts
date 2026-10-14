/**
 * Gathers server reflexive addresses with a throwaway connection.
 * @returns {Promise<Set<string>>}
 */
export function gatherSrflx(RTC: any, iceServers: any, clock: any, timeoutMs?: number): Promise<Set<string>>;
/**
 * Network change detection (plan section 5, decision D15). Where available, the Network
 * Information API `change` event; everywhere, a probe every `networkProbeIntervalMs` and on
 * `visibilitychange` to visible: a throwaway RTCPeerConnection gathers server reflexive
 * candidates, and a changed set of public addresses means a network change. Host candidates are
 * not compared, because mDNS names change per connection.
 */
export class NetworkWatcher {
    constructor(group: any);
    l: any;
    start(): void;
    stop(): void;
    /** Network Information API `change`. */
    onConnectionChange(): void;
    /** Runs one probe now. */
    probeNow(reason: any): Promise<void>;
    #private;
}
