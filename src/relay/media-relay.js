import { wants } from "../media/subscriptions.js";

/**
 * Media planning per link (plan section 10.2, 10.4): which sources a link carries, whether they
 * are active, and at which bitrate. Own publications go to peers on a direct route; on a relay,
 * received tracks are forwarded to the targets of accepted flows.
 */
export class MediaRelay {
  #group;
  #routing;

  constructor(group, routing) {
    this.#group = group;
    this.#routing = routing;
    this.l = group.log.scope("media");
  }

  /**
   * Sources link `link` must carry: `[{key, info, track, active, params}]`.
   * @param {import("../link/direct-link.js").DirectLink} link
   */
  plan(link) {
    const g = this.#group;
    const out = [];
    const neighbor = link.remoteId;
    const route = g.peers.get(neighbor)?.routeInfo;
    for (const pub of g.media.pubs.values()) {
      if (!pub.targets(neighbor) || route?.kind !== "direct") continue;
      const sub = this.#routing.remoteSubscription(neighbor, g.selfId);
      out.push({
        key: `self:${pub.id}`,
        info: { origin: g.selfId, pub: pub.id, tag: pub.tag, kind: pub.kind },
        track: pub.track,
        active: wants(sub, pub.kind, pub.tag),
      });
    }
    return out;
  }

  /** Media kinds the pair with `peerId` exchanges. */
  kindsFor(peerId) {
    const g = this.#group;
    const kinds = new Set();
    for (const pub of g.media.pubs.values()) if (pub.targets(peerId)) kinds.add(pub.kind);
    return [...kinds];
  }

  /** True when the pair with `peerId` exchanges media. */
  pairHasMedia(peerId) {
    return this.kindsFor(peerId).length > 0;
  }

  receivedSource() {}
  receivedSourceGone() {}
  forwardedSourcesGone() {}
  subscriptionsChanged() {}
  onMidMap() {}
  onMetrics() {}
  onBwe() {}
  tick() {}

  /** Bitrate this peer forwards for others, in bps. */
  relayedBps() {
    return 0;
  }

  budgetsSnapshot() {
    return {};
  }

  close() {}
}
