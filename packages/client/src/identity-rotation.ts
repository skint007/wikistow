// Replacing a person's identity keys (protocol section 4.6, #327): the
// rotation statement that both the old key and the new one sign, and the
// chain of statements from an earlier key of a person to a later one. Nothing
// here raises a key version on the server; this is the format and its checks.
import { IdentityRotation } from '@wikistow/contracts';
import { canonical, fromBase64, toBase64 } from './encoding.ts';
import { CryptoError } from './errors.ts';
import {
  keyHash,
  requireUsableKeys,
  sameKeys,
  sign,
  verifySignature,
  type PrivateIdentity,
  type PublicIdentity,
} from './identity.ts';
import type { InstallationId } from './ids.ts';

export { IdentityRotation };

type Unsigned = Omit<IdentityRotation, 'fromSignature' | 'toSignature'>;

/** The bytes both keys sign for a rotation statement. */
export const identityRotationBytes = (s: Unsigned) =>
  canonical('identity-key-rotation/v1', [
    s.installationId,
    s.id,
    s.from.keyVersion,
    s.from.keyHash,
    s.to.keyVersion,
    fromBase64(s.to.boxPublicKey),
    fromBase64(s.to.signPublicKey),
    s.contacts?.version ?? null,
    s.contacts?.contactsHash ?? null,
  ]);

/** The person's own contacts record as it was when they rotated: its latest version and that version's `contactsHash`. */
export type RotationContacts = { version: number; contactsHash: string } | null;

/**
 * Sign the statement that `to` replaces `from` (section 4.6), with both
 * keys. `to` is the next key version of the same person, with new keys of
 * both kinds. `contacts` is the person's latest contacts version, signed with
 * `from`, or `null` if they have none.
 */
export function signIdentityRotation({
  installationId,
  from,
  to,
  contacts,
}: {
  installationId: InstallationId;
  from: PrivateIdentity;
  to: PrivateIdentity;
  contacts: RotationContacts;
}): IdentityRotation {
  if (to.public.id !== from.public.id || to.public.kind !== 'human') {
    throw new CryptoError('malformed', 'A rotation is to a new key of the same person');
  }
  const unsigned: Unsigned = {
    installationId,
    id: from.public.id,
    from: { keyVersion: from.public.keyVersion, keyHash: keyHash(from.public) },
    to: {
      keyVersion: to.public.keyVersion,
      boxPublicKey: to.public.boxPublicKey,
      signPublicKey: to.public.signPublicKey,
    },
    contacts,
  };
  const bytes = identityRotationBytes(unsigned);
  const statement = {
    ...unsigned,
    fromSignature: sign(from, bytes),
    toSignature: sign(to, bytes),
  };
  // What a verifier would refuse is never sent.
  verifyIdentityRotation({
    installationId,
    from: from.public,
    statement: parseIdentityRotation(statement),
  });
  return statement;
}

/**
 * Parse a rotation statement the server served (section 4.6): strictly, with
 * no `version` property, since an object with one is a later format, which
 * fails closed as `unsupported-format`. Its new keys must pass section 4.1
 * (`bad-key`). Anything else wrong is `malformed`.
 */
export function parseIdentityRotation(raw: unknown): IdentityRotation {
  if (typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'version')) {
    throw new CryptoError('unsupported-format', 'A rotation statement in a newer format');
  }
  const parsed = IdentityRotation.safeParse(raw);
  if (!parsed.success) {
    throw new CryptoError('malformed', 'A rotation statement has an invalid shape', {
      cause: parsed.error,
    });
  }
  requireUsableKeys(parsed.data.to);
  return parsed.data;
}

/** The key a statement moves to, as the statement gives it, never as the directory does. */
export const rotatedKey = (statement: IdentityRotation): PublicIdentity => ({
  id: statement.id,
  kind: 'human',
  keyVersion: statement.to.keyVersion,
  boxPublicKey: statement.to.boxPublicKey,
  signPublicKey: statement.to.signPublicKey,
});

/**
 * Check one parsed statement against the key it replaces, `from` (section
 * 4.6), and return the new key. `from` must be a person's key at exactly the
 * statement's `from`, by key hash (`binding-mismatch`), for this
 * installation (`binding-mismatch`). Each new key must differ from the old
 * key of its kind, and `fromSignature` must verify under `from` and
 * `toSignature` under the new signing key, over the same bytes
 * (`bad-signature`).
 */
export function verifyIdentityRotation({
  installationId,
  from,
  statement,
}: {
  installationId: InstallationId;
  from: PublicIdentity;
  statement: IdentityRotation;
}): PublicIdentity {
  if (statement.installationId !== installationId) {
    throw new CryptoError('binding-mismatch', 'The rotation is for another installation');
  }
  if (from.kind !== 'human') throw new CryptoError('malformed', 'Only people replace their keys');
  if (
    statement.id !== from.id ||
    statement.from.keyVersion !== from.keyVersion ||
    statement.from.keyHash !== keyHash(from)
  ) {
    throw new CryptoError('binding-mismatch', 'The rotation names another key');
  }
  const to = rotatedKey(statement);
  // Neither signature stands in for the other: each is checked under a
  // different key, and the keys must differ.
  if (to.boxPublicKey === from.boxPublicKey || to.signPublicKey === from.signPublicKey) {
    throw new CryptoError('bad-signature', 'The rotation keeps a key it replaces');
  }
  const bytes = identityRotationBytes(statement);
  if (
    !verifySignature(from, bytes, statement.fromSignature) ||
    !verifySignature(to, bytes, statement.toSignature)
  ) {
    throw new CryptoError('bad-signature', `The rotation of ${from.id} is not signed by both keys`);
  }
  return to;
}

// Only this module holds it, so only `verifyRotationChain` makes a chain.
const minted = Symbol('RotationChain');

/**
 * A valid chain of a person's keys (section 4.6), from `keys[0]` to the last,
 * one key version apart, each statement checked. Only `verifyRotationChain`
 * makes one, so holding one means it was checked.
 */
export class RotationChain {
  /** The keys along the chain, in ascending key version: where it starts, and each one a statement moved to. */
  readonly keys: readonly Readonly<PublicIdentity>[];
  /** The statements, one per key version from the first key's. */
  readonly statements: readonly IdentityRotation[];

  constructor(
    token: typeof minted,
    keys: readonly PublicIdentity[],
    statements: readonly IdentityRotation[],
  ) {
    if (token !== minted)
      throw new CryptoError('malformed', 'Only verifyRotationChain makes chains');
    this.keys = Object.freeze(keys.map((key) => Object.freeze({ ...key })));
    this.statements = Object.freeze([...statements]);
    Object.freeze(this);
  }

  /** The key the chain ends at. */
  get last(): Readonly<PublicIdentity> {
    const last = this.keys.at(-1);
    if (!last) throw new CryptoError('malformed', 'A chain has a key');
    return last;
  }
}

/**
 * Check the chain from `start` to `end` (section 4.6): `statements` as the
 * server served them, with the person's current key, `end`, from the same
 * read. The statements must be exactly one per key version from `start`'s up
 * to `end`'s, in order, the first naming `start` by key hash and each next
 * one starting where the last ended; the last must end at exactly `end`'s
 * keys; and no box or signing key may appear twice along the chain, so it
 * never comes back to a key it left. A served statement that appears twice
 * counts once only when its signed bytes are the same.
 *
 * A gap, two different statements for one key version, statements out of
 * order or beyond `end`, an end at other keys, or a key that comes back, is
 * no chain: `identity-key-changed`, a possible attack. A statement that
 * doesn't parse or verify keeps its own code (`malformed`,
 * `unsupported-format`, `bad-key`, `binding-mismatch` or `bad-signature`).
 * Callers treat every failure as a key change.
 */
export function verifyRotationChain({
  installationId,
  start,
  end,
  statements: served,
}: {
  installationId: InstallationId;
  start: PublicIdentity;
  end: PublicIdentity;
  statements: readonly unknown[];
}): RotationChain {
  const notAChain = (why: string) =>
    new CryptoError('identity-key-changed', `No chain of ${start.id}’s keys: ${why}`);
  if (start.kind !== 'human' || end.kind !== 'human') {
    throw new CryptoError('malformed', 'Only people replace their keys');
  }
  if (start.id !== end.id) throw notAChain('two people');
  if (end.keyVersion < start.keyVersion) throw notAChain('the current key is older');
  requireUsableKeys(start);
  requireUsableKeys(end);

  const statements: IdentityRotation[] = [];
  let previousBytes: string | null = null;
  for (const raw of served) {
    const statement = parseIdentityRotation(raw);
    const bytes = toBase64(identityRotationBytes(statement));
    const last = statements.at(-1);
    if (last && statement.from.keyVersion === last.from.keyVersion) {
      if (bytes !== previousBytes) throw notAChain('two statements for one key version');
      continue;
    }
    if (last && statement.from.keyVersion < last.from.keyVersion) throw notAChain('out of order');
    statements.push(statement);
    previousBytes = bytes;
  }
  if (statements.length !== end.keyVersion - start.keyVersion) {
    throw notAChain('a statement is missing, or one goes past the current key');
  }

  const keys: PublicIdentity[] = [start];
  for (const [index, statement] of statements.entries()) {
    if (statement.from.keyVersion !== start.keyVersion + index) throw notAChain('a gap');
    if (statement.id !== start.id) throw notAChain('a statement for someone else');
    const from = keys[index];
    if (!from) throw notAChain('a gap');
    if (statement.from.keyHash !== keyHash(from)) throw notAChain('a key that doesn’t match');
    keys.push(verifyIdentityRotation({ installationId, from, statement }));
  }

  const ended = keys.at(-1);
  if (!ended || !sameKeys(ended, end)) throw notAChain('it ends at other keys');
  const box = new Set(keys.map((key) => key.boxPublicKey));
  const signing = new Set(keys.map((key) => key.signPublicKey));
  if (box.size !== keys.length || signing.size !== keys.length) {
    throw notAChain('a key comes back');
  }
  return new RotationChain(minted, keys, statements);
}
