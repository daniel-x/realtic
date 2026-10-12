/**
 * Network change detection (plan section 5, decision D15). Where available, the Network
 * Information API `change` event; everywhere, a probe every `networkProbeIntervalMs` and on
 * `visibilitychange` to visible: a throwaway RTCPeerConnection gathers server reflexive
 * candidates, and a changed set of public addresses means a network change. Host candidates are
 * not compared, because mDNS names change per connection.
 */
export class NetworkWatcher {
  #group;
  #timer = null;
  #last = null;
  #probing = false;
  #stopped = false;

  constructor(group) {
    this.#group = group;
    this.l = group.log.scope("link");
  }

  #stunServers() {
    const servers = this.#group.config.testHooks?.probeIceServers ?? this.#group.iceServers;
    return servers
      .map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => /^stuns?:/i.test(u)) }))
      .filter((s) => s.urls.length);
  }

  start() {
    if (!this.#group.RTC || this.#timer !== null) return;
    if (!this.#stunServers().length) return;
    this.#timer = this.#group.clock.setInterval(() => this.probeNow("interval"), this.#group.config.networkProbeIntervalMs);
    this.probeNow("start");
  }

  stop() {
    this.#stopped = true;
    if (this.#timer !== null) this.#group.clock.clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Network Information API `change`. */
  onConnectionChange() {
    const c = globalThis.navigator?.connection;
    this.l.info("network information change", { type: c?.type, effectiveType: c?.effectiveType });
    this.#group.restartAll("network change");
    this.probeNow("connection change");
  }

  /** Runs one probe now. */
  async probeNow(reason) {
    if (this.#probing || this.#stopped) return;
    const servers = this.#stunServers();
    if (!servers.length || !this.#group.RTC) return;
    this.#probing = true;
    try {
      const addresses = await gatherSrflx(this.#group.RTC, servers, this.#group.clock);
      if (this.#stopped) return;
      const key = [...addresses].sort().join(",");
      if (this.#last !== null && key !== this.#last && addresses.size) {
        this.l.info("public address changed", { reason, before: this.#last, after: key });
        this.#last = key;
        this.#group.restartAll("network change");
      } else if (addresses.size) {
        this.#last = key;
      }
    } catch (error) {
      this.l.debug("network probe failed", { error: error?.message });
    } finally {
      this.#probing = false;
    }
  }
}

/**
 * Gathers server reflexive addresses with a throwaway connection.
 * @returns {Promise<Set<string>>}
 */
export function gatherSrflx(RTC, iceServers, clock, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const pc = new RTC({ iceServers });
    const found = new Set();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // already closed
      }
      resolve(found);
    };
    const timer = clock.setTimeout(finish, timeoutMs);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      const c = e.candidate;
      const type = c.type ?? / typ (\w+)/.exec(c.candidate)?.[1];
      if (type === "srflx") found.add(`${c.address ?? c.candidate.split(" ")[4]}:${c.port ?? c.candidate.split(" ")[5]}`.split(":")[0]);
    };
    pc.createDataChannel("probe");
    pc.setLocalDescription().catch(finish);
  });
}
