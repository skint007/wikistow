import type { Sealed } from '@wikistow/contracts';
import type { z } from 'zod';

export { Base64, Hash32, Sealed } from '@wikistow/contracts';
import { CryptoError } from './errors.ts';
import { matchesPath, parseJsonText, type JsonPathPattern } from './json.ts';
import { sodium } from './sodium.ts';

const variant = sodium.base64_variants.URLSAFE_NO_PADDING;

export const toBase64 = (bytes: Uint8Array): string => sodium.to_base64(bytes, variant);

export function fromBase64(text: string): Uint8Array {
  try {
    return sodium.from_base64(text, variant);
  } catch (cause) {
    throw new CryptoError('malformed', 'Invalid base64url data', { cause });
  }
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export type CanonicalField = string | number | Uint8Array | null;

/**
 * Unambiguous bytes for signatures and AEAD associated data. The domain names
 * the purpose and version, so bytes signed for one record type can never be
 * replayed as another. Each field is a type tag, a 4-byte big-endian length,
 * and its bytes.
 *
 *   canonical('revision-record/v1', [installationId, pageId, 3, payloadHash])
 */
export function canonical(domain: string, fields: readonly CanonicalField[]): Uint8Array {
  const parts = [encodeField(`wikistow/${domain}`), ...fields.map(encodeField)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const FIELD_TAG = { null: 0, string: 1, number: 2, bytes: 3 } as const;

// A 4-byte length can't describe a longer body, and `setUint32` would wrap it silently.
const MAX_FIELD_BYTES = 2 ** 32 - 1;

/** One canonical field: tag, 4-byte big-endian length, body. */
export function encodeField(field: CanonicalField): Uint8Array {
  const [tag, body] = fieldBody(field);
  return fieldHeader(tag, body.length, body);
}

/** A field's tag and length, then `body` if given. */
export function fieldHeader(tag: number, length: number, body?: Uint8Array): Uint8Array {
  if (length > MAX_FIELD_BYTES) {
    throw new CryptoError('malformed', 'A canonical field must be shorter than 2^32 bytes');
  }
  const out = new Uint8Array(5 + (body?.length ?? 0));
  const view = new DataView(out.buffer);
  view.setUint8(0, tag);
  view.setUint32(1, length);
  if (body) out.set(body, 5);
  return out;
}

function fieldBody(field: CanonicalField): [number, Uint8Array] {
  if (field === null) return [FIELD_TAG.null, new Uint8Array()];
  if (typeof field === 'string') return [FIELD_TAG.string, utf8(field)];
  if (typeof field === 'number') {
    if (!Number.isSafeInteger(field))
      throw new CryptoError('malformed', 'Only safe integers can be signed');
    return [FIELD_TAG.number, utf8(String(field))];
  }
  return [FIELD_TAG.bytes, field];
}

/** XChaCha20-Poly1305 with a random nonce. */
export function aeadEncrypt({
  key,
  plaintext,
  ad,
}: {
  key: Uint8Array;
  plaintext: Uint8Array;
  ad: Uint8Array;
}): Sealed {
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    nonce,
    key,
  );
  return { nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) };
}

export function aeadDecrypt({
  key,
  sealed,
  ad,
}: {
  key: Uint8Array;
  sealed: Sealed;
  ad: Uint8Array;
}): Uint8Array {
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromBase64(sealed.ciphertext),
      ad,
      fromBase64(sealed.nonce),
      key,
    );
  } catch (cause) {
    throw new CryptoError('decrypt-failed', 'Ciphertext, key, or binding does not match', {
      cause,
    });
  }
}

/** BLAKE2b-256, raw. */
export const hashBytes = (bytes: Uint8Array): Uint8Array =>
  sodium.crypto_generichash(32, bytes, null);

/** BLAKE2b-256, base64url. Used to bind ciphertext into signed records. */
export const hash = (bytes: Uint8Array): string => toBase64(hashBytes(bytes));

/** The same hash over bytes that arrive in pieces, such as a streamed upload. */
export function streamingHash() {
  const state = sodium.crypto_generichash_init(null, 32);
  return {
    update: (bytes: Uint8Array) => sodium.crypto_generichash_update(state, bytes),
    digest: () => toBase64(sodium.crypto_generichash_final(state, 32)),
  };
}

// Fatal: invalid UTF-8 is an error, never U+FFFD, and a BOM is kept so it can be refused.
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decode bytes as strict UTF-8 with no byte-order mark, or throw `malformed`. */
export function decodeUtf8(bytes: Uint8Array, what: string): string {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch (cause) {
    throw new CryptoError('malformed', `${what} is not valid UTF-8`, { cause });
  }
  if (text.startsWith('\uFEFF')) throw new CryptoError('malformed', `${what} starts with a BOM`);
  return text;
}

/** The integer fields every payload has. */
export const FORMAT_INTEGERS: readonly JsonPathPattern[] = [
  ['format', 'major'],
  ['format', 'minor'],
];

/** How `parseJson` reads one kind of payload. */
export type PayloadRules = {
  /** Fields typed as integers, which must be written as plain integer tokens. */
  integers?: readonly JsonPathPattern[];
  /**
   * Accept strings that aren't well-formed, as Milestone 1 clients did. Only
   * for the payloads of v1 records: their honest writers could seal a lone
   * surrogate (pasted or cut-off text), which `JSON.stringify` writes as a
   * `\ud800` escape. Nothing they wrote could break the other rules, so
   * those still apply.
   */
  illFormedStrings?: boolean;
};

/**
 * Decode and parse decrypted payload bytes. Refused as `malformed`: invalid
 * UTF-8, a BOM, duplicate member names, ill-formed strings, numbers that
 * aren't finite, and fields at `integers` written as anything but a plain
 * integer token (`1.0`, `1e0`). Payloads are loose, so other numbers may be
 * fractions.
 */
export function parseJson<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array,
  what: string,
  { integers = FORMAT_INTEGERS, illFormedStrings = false }: PayloadRules = {},
): T {
  const { value, defects } = parseJsonText(decodeUtf8(bytes, what));
  const defect = defects.find(({ path, problem }) => {
    if (problem === 'number-token') return integers.some((pattern) => matchesPath(path, pattern));
    return problem !== 'ill-formed-string' || !illFormedStrings;
  });
  if (defect) {
    throw new CryptoError(
      'malformed',
      `${what} has ${defect.problem} at ${JSON.stringify(defect.path)}`,
    );
  }
  return parseWith(schema, value, what);
}

/**
 * Check `json` against a loose payload schema, but return `json` itself
 * rather than Zod's copy. Zod rebuilds loose objects by assignment, which
 * turns a member named `__proto__` into a prototype change and drops it;
 * spreads and `JSON.stringify` keep it, so the next version does too.
 */
export function keepParsed<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
  if (matches(schema, json)) return json;
  throw new CryptoError('malformed', `${what} has an invalid shape`, {
    cause: schema.safeParse(json).error,
  });
}

const matches = <T>(schema: z.ZodType<T>, json: unknown): json is T =>
  schema.safeParse(json).success;

/** Nonce then ciphertext: the bytes a record's `payloadHash` covers, and an attachment blob's layout. */
export function sealedBytes(sealed: Sealed): Uint8Array {
  const nonce = fromBase64(sealed.nonce);
  const ciphertext = fromBase64(sealed.ciphertext);
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, nonce.length);
  return out;
}

/** Parse server data at the boundary, failing with `malformed`. */
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new CryptoError('malformed', `${what} has an invalid shape`, { cause: result.error });
  }
  return result.data;
}
