import type { IdentityId, PublicIdentity } from '@wikistow/contracts';
import { verifySignature } from '@wikistow/client';
import { ContentError } from './errors.ts';

/** The parts of a key envelope, v1 or v2, the server checks. */
export type Envelope = {
  recipientId: IdentityId;
  recipientKeyVersion: number;
  granterId: IdentityId;
  granterKeyVersion: number;
  signature: string;
};

/**
 * The server can't read content, but it checks everything it can see before
 * storing a new version: keys go to exactly the expected recipients at their
 * current key versions, each envelope names this version, and the author
 * signed every one. Envelopes another owner grants later are checked by the
 * co-owner routes instead.
 */
export function checkEnvelopes<E extends Envelope>({
  envelopes,
  namesVersion,
  author,
  recipients,
  signedBytes,
}: {
  envelopes: readonly E[];
  namesVersion: (envelope: E) => boolean;
  author: PublicIdentity;
  recipients: readonly PublicIdentity[];
  signedBytes: (envelope: E) => Uint8Array;
}): void {
  if (!envelopes.every(namesVersion))
    throw new ContentError('binding-mismatch', 'An envelope names another version');
  const key = (id: string, version: number) => `${id}@${version}`;
  const expected = recipients.map((r) => key(r.id, r.keyVersion)).sort();
  const given = envelopes.map((e) => key(e.recipientId, e.recipientKeyVersion)).sort();
  if (expected.join('\n') !== given.join('\n')) {
    throw new ContentError('recipients-mismatch', 'Keys must go to exactly the current audience');
  }
  const signedByAuthor = envelopes.every(
    (e) =>
      e.granterId === author.id &&
      e.granterKeyVersion === author.keyVersion &&
      verifySignature(author, signedBytes(e), e.signature),
  );
  if (!signedByAuthor)
    throw new ContentError('bad-signature', 'Every envelope must be signed by the author');
}
