import { z } from 'zod';

// Every pattern here is ASCII-only and anchored at both ends, with no flags:
// JavaScript's `$` without `m` never matches before a trailing newline.

/** Bytes inside JSON records: unpadded base64url. A length of 4n + 1 can't encode bytes. */
export const Base64 = z.string().regex(/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/);

// 32 bytes take 43 characters; the last one carries two unused bits, which
// must be zero so each value has exactly one text form.
const BYTES_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** A 32-byte public key (X25519 or Ed25519). */
export const PublicKey = z.string().regex(BYTES_32);

/**
 * A BLAKE2b-256 hash in its one canonical text form. Hash fields are signed,
 * stored and compared as this exact text.
 */
export const Hash32 = z.string().regex(BYTES_32);

/**
 * The output of authenticated encryption, as stored in records. The nonce
 * length is fixed, so no bytes can move between nonce and ciphertext without
 * changing the hash of `nonce ‖ ciphertext`. The ciphertext holds at least
 * the 16-byte tag.
 */
export const Sealed = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
  ciphertext: Base64.min(22),
});
export type Sealed = z.infer<typeof Sealed>;

const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;

// A real instant from the year 2000 on. Re-serializing catches what the
// pattern can't: 30 February, month 13, `24:00:00` and leap seconds all
// either fail to parse or come back as a different string.
const isRealInstant = (text: string): boolean => {
  if (text < '2000') return false;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString() === (text.length === 20 ? `${text.slice(0, 19)}.000Z` : text);
};

/** A UTC time as `Date.prototype.toISOString()` writes it, milliseconds optional. */
export const Timestamp = z.string().regex(TIMESTAMP).refine(isRealInstant, 'Not a real instant');

/** A key version, sequence number or other count that starts at 1. */
export const PositiveInt = z.number().int().positive();
