/** Generates this group's ECDH key pair. */
export function generateKeyPair(): Promise<CryptoKeyPair>;
/** Exports a public key as JWK for `hello`. */
export function exportPublic(publicKey: any): Promise<{
    kty: string;
    crv: string;
    x: string;
    y: string;
}>;
/**
 * Derives the pair key from our private key and the remote public JWK. Both sides derive the
 * same key because the salt is built from the sorted peer ids.
 * @param {CryptoKey} privateKey
 * @param {JsonWebKey} remoteJwk
 * @param {string} selfId
 * @param {string} remoteId
 */
export function derivePairKey(privateKey: CryptoKey, remoteJwk: JsonWebKey, selfId: string, remoteId: string): Promise<CryptoKey>;
/**
 * @param {CryptoKey} key
 * @param {Uint8Array} additionalData
 * @param {Uint8Array} plaintext
 */
export function encrypt(key: CryptoKey, additionalData: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
/**
 * Throws when authentication fails.
 * @param {CryptoKey} key
 * @param {Uint8Array} additionalData
 * @param {Uint8Array} data
 */
export function decrypt(key: CryptoKey, additionalData: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>>;
export const OVERHEAD: number;
