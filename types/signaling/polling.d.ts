/**
 * Signaling adapter for the PHP reference server (`server/php/signal.php`): repeated polling
 * (pull), no long-lived requests. Each request carries the queued outgoing messages and returns
 * the pending incoming ones plus the group's member list, from which presence events are derived.
 *
 * The adapter polls every `fastMs` while signaling is active (a message sent or received within
 * `activeMs`) and every `idleMs` otherwise; once the mesh is up, most signaling goes over it and
 * the server only sees idle polls. The server suggests both intervals; options override them.
 * Messages queued when a request fails are dropped, like the WebSocket adapter does while
 * disconnected: the library retries what matters.
 */
export class PollingSignaling {
    /**
     * @param {string} url endpoint, e.g. `https://example.com/realtic/signal.php` (relative URLs
     *   resolve against the page)
     * @param {string} selfId
     * @param {object} [options]
     * @param {string} [options.group]
     * @param {number} [options.fastMs] poll interval while active (server default 250)
     * @param {number} [options.idleMs] poll interval while idle (server default 3000)
     * @param {number} [options.activeMs] how long a message keeps polling fast
     * @param {number} [options.timeoutMs] request timeout
     * @param {typeof fetch} [options.fetch]
     */
    constructor(url: string, selfId: string, { group, fastMs, idleMs, activeMs, timeoutMs, fetch: fetchFn }?: {
        group?: string;
        fastMs?: number;
        idleMs?: number;
        activeMs?: number;
        timeoutMs?: number;
        fetch?: typeof fetch;
    });
    url: string;
    selfId: string;
    group: string;
    fastMs: number;
    idleMs: number;
    activeMs: number;
    timeoutMs: number;
    fetch: typeof fetch;
    /** @type {((from: string, message: object) => void) | null} */
    onmessage: ((from: string, message: object) => void) | null;
    /** @type {((event: {type: "join"|"leave", peer: string}) => void) | null} */
    onpresence: ((event: {
        type: "join" | "leave";
        peer: string;
    }) => void) | null;
    /** @type {((connected: boolean) => void) | null} */
    onstatus: ((connected: boolean) => void) | null;
    /** False after a failed request until the next one succeeds; true before the first answer. */
    get connected(): boolean;
    /**
     * Queues a message; the next request goes out right away.
     * @param {string} to
     * @param {object} message
     */
    send(to: string, message: object): void;
    /**
     * Sends via `navigator.sendBeacon`, for `pagehide`.
     * @param {string} to
     * @param {object} message
     */
    sendBeacon(to: string, message: object): boolean;
    /** Stops polling and tells the server this client left. */
    close(): void;
    #private;
}
