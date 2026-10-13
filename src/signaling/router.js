import { randomId } from "../util/ids.js";

/** Message types that must never pass through a relay peer (plan section 4.4). */
const SERVER_OR_DIRECT = new Set(["offer", "answer"]);
const SERVER_ONLY = new Set(["hello"]);
/** Types that also go through the server while it is up, so a lost mesh copy costs nothing. */
const BOTH_WHEN_UP = new Set(["offer", "answer", "renegotiate"]);
/** Message types a relay may forward. */
export const RELAYABLE = new Set(["cand", "renegotiate", "bye"]);

/**
 * Sends signaling over the mesh first and the server second (plan section 4.4, decision D2).
 *
 * - `hello` always goes through the server.
 * - `offer`/`answer` go over the direct link they renegotiate when its `ctl` is open, else through
 *   the server.
 * - `cand`, `renegotiate`, `bye` go over the direct link, else through a relay neighbor, else
 *   through the server.
 * - While a direct link is open but not healthy, the message also goes through the server.
 *   Receivers drop duplicates by message id.
 */
export class SignalingRouter {
  /**
   * @param {object} options
   * @param {string} options.selfId
   * @param {() => import("./adapter.js").SignalingAdapter} options.adapter
   * @param {(id: string) => import("../link/direct-peer-connection.js").RalDirectPeerConnection | undefined} options.link
   * @param {(target: string) => string | undefined} options.relayFor neighbor that has a live link to target
   * @param {ReturnType<import("../diag/log.js").Log["scope"]>} options.log
   * @param {{outgoingSignal?: (to: string, msg: object) => (object | Promise<object>)}} [options.hooks]
   */
  constructor({ selfId, adapter, link, relayFor, log, hooks }) {
    this.selfId = selfId;
    this.adapter = adapter;
    this.link = link;
    this.relayFor = relayFor;
    this.l = log;
    this.hooks = hooks;
  }

  /**
   * Sends a signaling message.
   * @param {string} to
   * @param {object} msg
   * @param {{serverOnly?: boolean}} [options]
   */
  async send(to, msg, { serverOnly = false } = {}) {
    let full = { ...msg, from: this.selfId, to, id: msg.id ?? randomId(12) };
    if (this.hooks?.outgoingSignal) {
      try {
        full = await this.hooks.outgoingSignal(to, full);
      } catch (error) {
        this.l.warn("outgoing signal hook failed", { error: error.message });
      }
      if (!full) return;
    }
    const paths = serverOnly ? ["server"] : this.#paths(to, full.t);
    for (const path of paths) {
      if (path === "server") this.#toServer(to, full);
      else this.link(path)?.ralSendCtl({ t: "sig", msg: full });
    }
    this.l.debug("signal sent", { t: full.t, to, id: full.id, size: full.sdp?.length ?? 0, paths });
  }

  #paths(to, t) {
    if (SERVER_ONLY.has(t)) return ["server"];
    const direct = this.link(to);
    if (direct?.ralCtlOpen) {
      if (direct.ralHealthy && direct.ralConnection.directState === "connected") return BOTH_WHEN_UP.has(t) ? [to, "server"] : [to];
      if (direct.ralUsable) return [to, "server"];
    }
    if (SERVER_OR_DIRECT.has(t)) return ["server"];
    const via = this.relayFor(to);
    if (via) return [via, "server"];
    return ["server"];
  }

  #toServer(to, msg) {
    if (this.adapter().connected === false) return;
    try {
      const r = this.adapter().send(to, msg);
      if (r && typeof r.catch === "function") r.catch((error) => this.l.warn("signaling send failed", { t: msg.t, to, error: error?.message }));
    } catch (error) {
      this.l.warn("signaling send failed", { t: msg.t, to, error: error?.message });
    }
  }

  /**
   * Best-effort send for `pagehide`: `sendBeacon` when the adapter has it, else a normal send.
   * @param {string} to
   * @param {object} msg
   */
  beacon(to, msg) {
    const full = { ...msg, from: this.selfId, to, id: randomId(12) };
    const adapter = this.adapter();
    try {
      if (adapter.sendBeacon?.(to, full)) return;
      adapter.send(to, full);
    } catch {
      // the page is going away
    }
  }
}
