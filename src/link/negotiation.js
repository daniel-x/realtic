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
  makingOffer = false;
  offerPending = false;
  ignoreOffer = false;
  #heldCandidates = [];

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
  constructor(pc, { impolite, signal, beforeAnswer, onstable, offerExtras, log }) {
    this.pc = pc;
    this.impolite = impolite;
    this.signal = signal;
    this.beforeAnswer = beforeAnswer;
    this.offerExtras = offerExtras;
    this.onstable = onstable;
    this.log = log;
  }

  /** Starts an offer (impolite) or asks for one (polite). */
  async negotiate(reason = "needed", extra = {}) {
    if (this.pc.signalingState === "closed") return;
    if (!this.impolite) {
      this.signal({ t: "renegotiate", reason, ...extra });
      return;
    }
    if (this.makingOffer || this.pc.signalingState !== "stable") {
      this.offerPending = true;
      return;
    }
    this.makingOffer = true;
    this.offerPending = false;
    try {
      await this.pc.setLocalDescription();
      if (this.pc.signalingState === "have-local-offer") {
        this.signal({ t: "offer", sdp: this.pc.localDescription.sdp, reason, ...this.offerExtras?.() });
      }
    } finally {
      this.makingOffer = false;
    }
  }

  /** @param {{sdp: string}} msg */
  async handleOffer(msg) {
    const collision = this.makingOffer || this.pc.signalingState !== "stable";
    this.ignoreOffer = this.impolite && collision;
    if (this.ignoreOffer) {
      this.log("ignored colliding offer");
      return;
    }
    await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
    await this.#applyHeld();
    await this.beforeAnswer?.(msg);
    await this.pc.setLocalDescription();
    this.signal({ t: "answer", sdp: this.pc.localDescription.sdp });
    this.onstable?.();
  }

  /** @param {{sdp: string}} msg */
  async handleAnswer(msg) {
    if (this.pc.signalingState !== "have-local-offer") {
      this.log("dropped answer in state " + this.pc.signalingState);
      return;
    }
    await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    await this.#applyHeld();
    this.onstable?.();
    if (this.offerPending) await this.negotiate("pending");
  }

  /** @param {{c: RTCIceCandidateInit[]}} msg */
  async handleCandidates(msg) {
    for (const c of msg.c ?? []) {
      if (!this.pc.remoteDescription) {
        this.#heldCandidates.push(c);
        continue;
      }
      await this.#addCandidate(c);
    }
  }

  async #applyHeld() {
    const held = this.#heldCandidates;
    this.#heldCandidates = [];
    for (const c of held) await this.#addCandidate(c);
  }

  async #addCandidate(c) {
    try {
      await this.pc.addIceCandidate(c);
    } catch (error) {
      if (!this.ignoreOffer) this.log("addIceCandidate failed", { error: error.message, candidate: c.candidate });
    }
  }
}
