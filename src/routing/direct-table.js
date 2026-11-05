/**
 * Direct connection tables (plan section 7.1). Each peer sends its direct connection table to its
 * neighbors on `ctl`; with at most one relay no flooding is needed.
 */

/** Builds this peer's `direct-table` message. */
export function buildDirectTable(group, load) {
  const conns = [];
  for (const [peer, directConn] of group.directConns) {
    const m = directConn.ralMetrics;
    conns.push({
      peer,
      state: m.state,
      rtt: m.rtt === undefined ? undefined : Math.round(m.rtt),
      bitrate: m.bitrate,
      loss: m.loss,
      candidateType: directConn.ralViaTurn ? "relay" : m.candidateType,
      mms: directConn.ralMaxMessageSize,
    });
  }
  return { t: "direct-table", conns, load, relay: !!group.config.relay, mediaRelay: group.config.mediaRelay, relayMedia: group.relaysMedia, ts: Math.round(group.clock.now()) };
}

/**
 * Neighbor table store: what each neighbor last reported.
 */
export class NeighborTables {
  #tables = new Map();

  /**
   * @param {string} neighbor
   * @param {object} msg `direct-table` message
   * @param {number} now
   */
  update(neighbor, msg, now) {
    const table = new Map();
    for (const l of msg.conns ?? []) {
      if (typeof l?.peer === "string") table.set(l.peer, { state: l.state, rtt: l.rtt, bitrate: l.bitrate, loss: l.loss, candidateType: l.candidateType, mms: l.mms });
    }
    this.#tables.set(neighbor, { table, load: Number(msg.load) || 0, relay: msg.relay !== false, mediaRelay: msg.mediaRelay === "never" ? "never" : "allow", relayMedia: msg.relayMedia !== false, at: now });
  }

  /** @param {string} neighbor */
  get(neighbor) {
    return this.#tables.get(neighbor);
  }

  /** @param {string} neighbor */
  delete(neighbor) {
    this.#tables.delete(neighbor);
  }

  /** Entry of neighbor's direct connection to target, or undefined. */
  entry(neighbor, target) {
    return this.#tables.get(neighbor)?.table.get(target);
  }

  /** Neighbor ids. */
  keys() {
    return this.#tables.keys();
  }

  /** Drops tables older than `maxAgeMs`. */
  expire(now, maxAgeMs) {
    for (const [id, t] of this.#tables) if (now - t.at > maxAgeMs) this.#tables.delete(id);
  }
}
