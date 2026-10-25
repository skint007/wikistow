import { canonical, toBase64, utf8 } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';
import { sodium } from './sodium.ts';

// What the desktop app keeps between launches (#3), sealed in the pages so
// its main process only ever holds bytes it can't read or quietly change.
// The key comes from this person's identity, so only their unlocked vault
// opens them; `ad` binds them to what they belong to, such as the server
// and the account. The bytes are a nonce, then the ciphertext.

const deviceKey = (identity: PrivateIdentity, keyDomain: string) =>
  sodium.crypto_generichash(32, canonical(keyDomain, []), identity.boxSecretKey);

/**
 * A tag for `text` under the key `keyDomain` names for this person: the same
 * text always gives the same tag, and without their unlocked vault nobody
 * can tell which text it is. So a choice kept on the device in the clear
 * can name page content, such as a property's name, without holding it.
 */
export const deviceTag = (identity: PrivateIdentity, keyDomain: string, text: string): string =>
  toBase64(sodium.crypto_generichash(16, utf8(text), deviceKey(identity, keyDomain)));

/** `plaintext` sealed under the key `keyDomain` names for this person, bound to `ad`. */
export function sealOnDevice(
  identity: PrivateIdentity,
  keyDomain: string,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    nonce,
    deviceKey(identity, keyDomain),
  );
  const sealed = new Uint8Array(nonce.length + ciphertext.length);
  sealed.set(nonce);
  sealed.set(ciphertext, nonce.length);
  return sealed;
}

/** What `sealOnDevice` sealed, or null if it was sealed for someone or something else, or is damaged. */
export function openOnDevice(
  identity: PrivateIdentity,
  keyDomain: string,
  ad: Uint8Array,
  sealed: Uint8Array,
): Uint8Array | null {
  const split = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      sealed.subarray(split),
      ad,
      sealed.subarray(0, split),
      deviceKey(identity, keyDomain),
    );
  } catch {
    return null;
  }
}
