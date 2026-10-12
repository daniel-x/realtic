/**
 * Offer/answer handling of one RTCPeerConnection (plan section 4.3, decision D1).
 *
 * - Only the impolite side offers. The polite side asks with `renegotiate`.
 * - `negotiationneeded` during a non-stable state sets `offerPending`, served on the next
 *   `stable` (doc §2.3).
 * - Perfect negotiation collision handling stays as a safety net: the impolite side ignores a
 *   colliding offer, the polite side rolls back implicitly.
 * - Candidates that arrive before the remote description are held and applied after it.
 *
 * All `handle*` calls must come through the link's serial queue (doc §2.2).
 */
export class Negotiator {
    /**
     * @param {RTCPeerConnection} pc
     * @param {object} options
     * @param {boolean} options.impolite
     * @param {(msg: object) => void} options.signal sends a signaling message to the remote side
     * @param {(msg: object) => (void | Promise<void>)} [options.beforeAnswer]
     *   runs with the offer message after the remote offer is applied and before the answer is
     *   created
     * @param {() => void} [options.onstable] called whenever a negotiation round completes
     * @param {() => object} [options.offerExtras] extra fields for the offer message, read after
     *   the local description is set
     * @param {(msg: string, data?: object) => void} options.log
     */
    constructor(pc: RTCPeerConnection, { impolite, signal, beforeAnswer, onstable, offerExtras, log }: {
        impolite: boolean;
        signal: (msg: object) => void;
        beforeAnswer?: (msg: object) => (void | Promise<void>);
        onstable?: () => void;
        offerExtras?: () => object;
        log: (msg: string, data?: object) => void;
    });
    makingOffer: boolean;
    offerPending: boolean;
    ignoreOffer: boolean;
    pc: RTCPeerConnection;
    impolite: boolean;
    signal: (msg: object) => void;
    beforeAnswer: (msg: object) => (void | Promise<void>);
    offerExtras: () => object;
    onstable: () => void;
    log: (msg: string, data?: object) => void;
    /** Starts an offer (impolite) or asks for one (polite). */
    negotiate(reason?: string, extra?: {}): Promise<void>;
    /** @param {{sdp: string}} msg */
    handleOffer(msg: {
        sdp: string;
    }): Promise<void>;
    /** @param {{sdp: string}} msg */
    handleAnswer(msg: {
        sdp: string;
    }): Promise<void>;
    /** @param {{c: RTCIceCandidateInit[]}} msg */
    handleCandidates(msg: {
        c: RTCIceCandidateInit[];
    }): Promise<void>;
    #private;
}
