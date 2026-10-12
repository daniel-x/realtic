import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPublic, derivePairKey, encrypt, decrypt, OVERHEAD } from "../../src/crypto/e2e.js";

test("both sides derive the same key; tampering fails", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const ka = await derivePairKey(a.privateKey, await exportPublic(b.publicKey), "A", "B");
  const kb = await derivePairKey(b.privateKey, await exportPublic(a.publicKey), "B", "A");
  const aad = new Uint8Array([1, 2, 3]);
  const ct = await encrypt(ka, aad, new TextEncoder().encode("hello"));
  assert.equal(ct.length, 5 + OVERHEAD);
  assert.equal(new TextDecoder().decode(await decrypt(kb, aad, ct)), "hello");
  await assert.rejects(decrypt(kb, new Uint8Array([1, 2, 4]), ct));
  ct[20] ^= 1;
  await assert.rejects(decrypt(kb, aad, ct));
});
