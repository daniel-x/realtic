/**
 * End to end encryption of relayed data (plan section 9.4): ECDH P-256 agreement on the keys
 * exchanged in `hello`, HKDF-SHA-256 to an AES-GCM-256 key per pair, a random 12 byte IV per
 * envelope. Output layout: `iv (12) | ciphertext | tag (16)`.
 */

const IV_BYTES = 12;
export const OVERHEAD = IV_BYTES + 16;

const subtle = () => globalThis.crypto.subtle;

/** Generates this group's ECDH key pair. */
export async function generateKeyPair() {
  return subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/** Exports a public key as JWK for `hello`. */
export async function exportPublic(publicKey) {
  const jwk = await subtle().exportKey("jwk", publicKey);
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/**
 * Derives the pair key from our private key and the remote public JWK. Both sides derive the
 * same key because the salt is built from the sorted peer ids.
 * @param {CryptoKey} privateKey
 * @param {JsonWebKey} remoteJwk
 * @param {string} selfId
 * @param {string} remoteId
 */
export async function derivePairKey(privateKey, remoteJwk, selfId, remoteId) {
  const remote = await subtle().importKey("jwk", remoteJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle().deriveBits({ name: "ECDH", public: remote }, privateKey, 256);
  const hkdf = await subtle().importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const ids = [selfId, remoteId].sort().join("\u0000");
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(`realtic-e2e-v1\u0000${ids}`), info: new Uint8Array(0) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * @param {CryptoKey} key
 * @param {Uint8Array} additionalData
 * @param {Uint8Array} plaintext
 */
export async function encrypt(key, additionalData, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData }, key, plaintext));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return out;
}

/**
 * Throws when authentication fails.
 * @param {CryptoKey} key
 * @param {Uint8Array} additionalData
 * @param {Uint8Array} data
 */
export async function decrypt(key, additionalData, data) {
  if (data.length < OVERHEAD) throw new Error("ciphertext too short");
  const iv = data.subarray(0, IV_BYTES);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv, additionalData }, key, data.subarray(IV_BYTES)));
}
