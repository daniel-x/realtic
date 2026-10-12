/** Returns a random id of `length` hex characters. */
export function randomId(length = 16) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

/** Returns a connection session id (doc §3.6). */
export function sessionId() {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * True when `self` is the impolite side of the pair. The lexicographically greater id is
 * impolite, so both sides derive opposite roles without an exchange.
 * @param {string} self
 * @param {string} other
 */
export function isImpolite(self, other) {
  return self > other;
}
