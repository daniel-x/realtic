/** Returns a random id of `length` hex characters. */
export function randomId(length?: number): string;
/** Returns a connection session id (doc §3.6). */
export function sessionId(): string;
/**
 * True when `self` is the impolite side of the pair. The lexicographically greater id is
 * impolite, so both sides derive opposite roles without an exchange.
 * @param {string} self
 * @param {string} other
 */
export function isImpolite(self: string, other: string): boolean;
