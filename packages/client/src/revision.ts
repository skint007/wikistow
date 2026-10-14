import {
  Audience,
  KeyEnvelope,
  KeyEnvelopeV2,
  RevisionRecord,
  RevisionRecordV2,
  SealedRevision,
  SealedRevisionV2,
} from '@wikistow/contracts';
import { z } from 'zod';
import {
  aeadDecrypt,
  aeadEncrypt,
  canonical,
  fromBase64,
  hash,
  parseJson,
  parseWith,
  sealedBytes,
  toBase64,
  utf8,
} from './encoding.ts';
import {
  checkEnvelopeV2,
  envelopeVersion,
  keyCommitment,
  openAnyEnvelope,
  openEnvelope,
  openSealedKey,
  recordProtocol,
  requireAcceptedOwner,
  sealKeyTo,
  unsealCommitted,
  type OpensOwner,
} from './envelope.ts';
import {
  folderKeyOf,
  openThroughWrap,
  revisionWrapSubject,
  wrapContentKey,
  type HeldKeyVersion,
  type KeyMaterial,
  type KeyWrap,
} from './folder-keys.ts';
import { CryptoError } from './errors.ts';
import { sign, verifySignature, type PrivateIdentity, type PublicIdentity } from './identity.ts';
import { AttachmentId, newId } from './ids.ts';
import {
  AttachmentRef,
  isPagePayload,
  PAYLOAD_INTEGERS,
  PagePayload,
  parsePayload,
  type OpenedPayload,
} from './payload.ts';
import { OWNER_REGION, type Region } from './regions.ts';
import { sodium } from './sodium.ts';
import type { TrustStore } from './trust.ts';

export {
  Audience,
  KeyEnvelope,
  KeyEnvelopeV2,
  RevisionRecord,
  RevisionRecordV2,
  SealedRevision,
  SealedRevisionV2,
};

/** The fields a writer chooses. The rest of the record is derived when sealing. */
export type RevisionTarget = Pick<
  RevisionRecord,
  'installationId' | 'spaceId' | 'pageId' | 'revisionId' | 'audience' | 'basedOn'
>;

/** Where an attachment belongs. Not tied to a revision, so drafts can reuse unchanged blobs. */
export type AttachmentTarget = Pick<
  RevisionRecord,
  'installationId' | 'spaceId' | 'pageId' | 'audience'
>;

/** The bytes an author signs. The server verifies them too, so both use this. */
export const revisionRecordBytes = (r: RevisionRecord) =>
  canonical('revision-record/v1', [
    r.protocol,
    r.installationId,
    r.spaceId,
    r.pageId,
    r.revisionId,
    r.audience,
    r.basedOn,
    r.authorId,
    r.authorKeyVersion,
    r.payloadHash,
  ]);

type PayloadBinding = Omit<RevisionRecord, 'protocol' | 'basedOn' | 'payloadHash'>;

// The author is bound in too, so nobody can re-sign someone else's
// ciphertext as their own and still have it decrypt.
const payloadAd = (r: PayloadBinding) =>
  canonical('revision-payload/v1', [
    r.installationId,
    r.spaceId,
    r.pageId,
    r.revisionId,
    r.audience,
    r.authorId,
    r.authorKeyVersion,
  ]);

/** The bytes a granter signs for a key envelope. The server verifies them too. */
export const keyEnvelopeBytes = (
  record: Pick<RevisionRecord, 'installationId' | 'payloadHash'>,
  e: Omit<KeyEnvelope, 'signature'>,
) =>
  canonical('key-envelope/v1', [
    record.installationId,
    record.payloadHash,
    e.revisionId,
    e.recipientId,
    e.recipientKeyVersion,
    fromBase64(e.sealedKey),
    e.granterId,
    e.granterKeyVersion,
  ]);

/** The bytes an author signs for a v2 record: v1's fields, then the key commitment. */
export const revisionRecordV2Bytes = (r: RevisionRecordV2) =>
  canonical('revision-record/v2', [
    r.protocol,
    r.installationId,
    r.spaceId,
    r.pageId,
    r.revisionId,
    r.audience,
    r.basedOn,
    r.authorId,
    r.authorKeyVersion,
    r.payloadHash,
    r.keyCommitment,
  ]);

/**
 * The bytes a granter signs for a v2 key envelope. `spaceId` and
 * `payloadHash` come from the record it unlocks, not from the envelope.
 */
export const keyEnvelopeV2Bytes = (
  record: Pick<RevisionRecordV2, 'installationId' | 'spaceId' | 'payloadHash'>,
  e: Omit<KeyEnvelopeV2, 'signature'>,
) =>
  canonical('key-envelope/v2', [
    record.installationId,
    record.spaceId,
    record.payloadHash,
    e.revisionId,
    e.recipientId,
    e.recipientKeyVersion,
    fromBase64(e.sealedKey),
    e.granterId,
    e.granterKeyVersion,
  ]);

const attachmentAd = (t: AttachmentTarget, id: AttachmentId) =>
  canonical('attachment/v1', [t.installationId, t.spaceId, t.pageId, t.audience, id]);

/**
 * Encrypt a revision under a fresh content key and seal that key to each
 * recipient. `recipients` must come from `TrustStore.recipients`, never
 * straight from the directory.
 */
export function sealRevision({
  author,
  target,
  payload,
  recipients,
}: {
  author: PrivateIdentity;
  target: RevisionTarget;
  payload: PagePayload;
  recipients: readonly PublicIdentity[];
}): { revision: SealedRevision; envelopes: KeyEnvelope[] } {
  const { binding, sealed, contentKey } = encryptRevision({ author, target, payload });
  const record: RevisionRecord = {
    protocol: 1,
    ...binding,
    payloadHash: hash(sealedBytes(sealed)),
  };
  const envelopes = recipients.map((recipient) =>
    grantKeyV1({ granter: author, record, contentKey, recipient }),
  );
  sodium.memzero(contentKey);
  return {
    revision: { record, signature: sign(author, revisionRecordBytes(record)), payload: sealed },
    envelopes,
  };
}

// Refuses to seal what no client could open again. The caller wipes the key.
function encryptRevision({
  author,
  target,
  payload,
}: {
  author: PrivateIdentity;
  target: RevisionTarget;
  payload: PagePayload;
}) {
  if (!isPagePayload(payload)) {
    throw new CryptoError('malformed', 'Payload is not valid', {
      cause: PagePayload.safeParse(payload).error,
    });
  }
  const plaintext = utf8(JSON.stringify(payload));
  // Round-trip through the strict reader, so nothing is sealed that a reader
  // would refuse, such as a lone surrogate or nesting deeper than it reads.
  // That holds for v1 records too, which are read more leniently.
  parseJson(PagePayload, plaintext, 'Payload', { integers: PAYLOAD_INTEGERS });
  const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const binding = {
    ...target,
    authorId: author.public.id,
    authorKeyVersion: author.public.keyVersion,
  };
  const sealed = aeadEncrypt({ key: contentKey, plaintext, ad: payloadAd(binding) });
  return { binding, sealed, contentKey };
}

/**
 * Where a v2 write's content key goes (section 6.8): sealed to each of the
 * space's sealing owners in the owner region (section 6.6), never to a list
 * the server gave, or wrapped under a share's key version, normally the one
 * `writeKeyVersion` chooses.
 */
export type KeyTarget =
  | { recipients: readonly PublicIdentity[]; share?: undefined }
  | {
      share: Pick<HeldKeyVersion, 'shareId' | 'keyVersion' | 'draftKey' | 'publishedKey'>;
      recipients?: undefined;
    };

/**
 * Seal a v2 revision: v1's sealing, plus a commitment to the content key,
 * with either one v2 envelope per owner or one key wrap. A draft needs the
 * share's draft key, which a reader's version lacks (`missing-key`).
 */
export function sealRevisionV2({
  author,
  target,
  payload,
  ...to
}: {
  author: PrivateIdentity;
  target: RevisionTarget;
  payload: PagePayload;
} & KeyTarget): { revision: SealedRevisionV2; envelopes: KeyEnvelopeV2[]; wrap: KeyWrap | null } {
  const folderKey = to.share ? requireFolderKey(to.share, target.audience) : null;
  const { binding, sealed, contentKey } = encryptRevision({ author, target, payload });
  try {
    const record: RevisionRecordV2 = {
      protocol: 2,
      ...binding,
      payloadHash: hash(sealedBytes(sealed)),
      keyCommitment: keyCommitment(contentKey),
    };
    const revision = {
      record,
      signature: sign(author, revisionRecordV2Bytes(record)),
      payload: sealed,
    };
    if (to.share && folderKey) {
      const wrap = wrapContentKey({
        installationId: record.installationId,
        subject: revisionWrapSubject(record),
        shareId: to.share.shareId,
        keyVersion: to.share.keyVersion,
        folderKey,
        contentKey,
      });
      return { revision, envelopes: [], wrap };
    }
    const envelopes = (to.recipients ?? []).map((recipient) =>
      grantRevisionKeyV2({ granter: author, record, contentKey, recipient }),
    );
    return { revision, envelopes, wrap: null };
  } finally {
    sodium.memzero(contentKey);
  }
}

// The folder key a write of `audience` wraps under: a draft's needs the draft key.
function requireFolderKey(
  share: Pick<HeldKeyVersion, 'shareId' | 'keyVersion' | 'draftKey' | 'publishedKey'>,
  audience: Audience,
): Uint8Array {
  const key = folderKeyOf(share, audience);
  if (!key) {
    throw new CryptoError(
      'missing-key',
      `No draft key for version ${share.keyVersion} of share ${share.shareId}`,
    );
  }
  return key;
}

/**
 * Seal a v2 revision's content key to one recipient. The granter is the
 * author in a write, and an owner when it seals existing content to a new
 * co-owner (section 7.6).
 */
export function grantRevisionKeyV2({
  granter,
  record,
  contentKey,
  recipient,
}: {
  granter: PrivateIdentity;
  /** A v1 record too: an owner seals Milestone 1 content to a new co-owner in v2 envelopes. */
  record: Pick<RevisionRecordV2, 'installationId' | 'spaceId' | 'payloadHash' | 'revisionId'>;
  contentKey: Uint8Array;
  recipient: PublicIdentity;
}): KeyEnvelopeV2 {
  const unsigned = {
    version: 2 as const,
    revisionId: record.revisionId,
    recipientId: recipient.id,
    recipientKeyVersion: recipient.keyVersion,
    sealedKey: sealKeyTo(contentKey, recipient),
    granterId: granter.public.id,
    granterKeyVersion: granter.public.keyVersion,
  };
  return { ...unsigned, signature: sign(granter, keyEnvelopeV2Bytes(record, unsigned)) };
}

function grantKeyV1({
  granter,
  record,
  contentKey,
  recipient,
}: {
  granter: PrivateIdentity;
  record: RevisionRecord;
  contentKey: Uint8Array;
  recipient: PublicIdentity;
}): KeyEnvelope {
  const unsigned = {
    revisionId: record.revisionId,
    recipientId: recipient.id,
    recipientKeyVersion: recipient.keyVersion,
    sealedKey: sealKeyTo(contentKey, recipient),
    granterId: granter.public.id,
    granterKeyVersion: granter.public.keyVersion,
  };
  return { ...unsigned, signature: sign(granter, keyEnvelopeBytes(record, unsigned)) };
}

/**
 * What the caller asked the server for. Naming the exact revision stops a
 * server from answering with another revision of the same page, such as an
 * older private draft or a rolled-back publication.
 */
export type ExpectedRevision = Pick<
  RevisionRecord,
  'installationId' | 'spaceId' | 'pageId' | 'revisionId'
> & {
  audience?: Audience;
};

/**
 * Verify and decrypt a v1 revision fetched from the server. Checks, in order:
 * the record is the exact revision the caller asked for, it is signed by a
 * pinned author whom `owners` accepts (v1 records don't commit to their key,
 * so only accepted owners' count, section 5.7), and the ciphertext matches
 * its signed hash. Its key then comes through a v1 envelope granted by the
 * author, a v2 envelope from an accepted owner, or a key wrap (section 14.4),
 * which fixes its region. Any failure throws a `CryptoError`.
 */
export function openRevision({
  reader,
  trust,
  owners,
  revision: rawRevision,
  expect,
  ...material
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  revision: unknown;
  expect: ExpectedRevision;
} & KeyMaterial): { record: RevisionRecord; opened: OpenedPayload; region: Region } {
  const { record, signature, payload } = parseWith(SealedRevision, rawRevision, 'Revision');
  checkRecord({ trust, owners, record, signature, expect, bytes: revisionRecordBytes(record) });
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Revision ciphertext does not match its signed hash');
  }
  const { contentKey, region } = material.keyring
    ? openThroughWrap({
        installationId: record.installationId,
        subject: revisionWrapSubject(record),
        wrap: material.wrap,
        keyring: material.keyring,
        commitment: null,
      })
    : {
        contentKey: openAnyEnvelope(material.envelopes, (raw) =>
          openV1RecordEnvelope({ reader, trust, owners, record, raw }),
        ),
        region: OWNER_REGION,
      };
  try {
    return { record, opened: decryptRevisionPayload({ record, payload, contentKey }), region };
  } finally {
    sodium.memzero(contentKey);
  }
}

// A v1 record's key from either envelope version: v1 granted by its author,
// as Milestone 1 sealed it, or v2 granted by an accepted owner since.
function openV1RecordEnvelope({
  reader,
  trust,
  owners,
  record,
  raw,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  record: RevisionRecord;
  raw: unknown;
}): Uint8Array {
  if (envelopeVersion(raw) === 1) {
    const envelope = parseWith(KeyEnvelope, raw, 'Key envelope');
    return openEnvelope({
      reader,
      trust,
      envelope,
      namesThisVersion: envelope.revisionId === record.revisionId,
      author: { id: record.authorId, keyVersion: record.authorKeyVersion },
      signedBytes: () => keyEnvelopeBytes(record, envelope),
    });
  }
  const envelope = parseWith(KeyEnvelopeV2, raw, 'Key envelope');
  checkEnvelopeV2({
    reader,
    trust,
    owners,
    envelope,
    namesThisVersion: envelope.revisionId === record.revisionId,
    signedBytes: () => keyEnvelopeV2Bytes(record, envelope),
  });
  return openSealedKey(reader, envelope.sealedKey);
}

const SignedRecord = SealedRevision.pick({ record: true, signature: true });

/**
 * Verify a v1 revision's signed record alone, for lists such as page history
 * that describe versions without their content: it is the exact revision the
 * caller expected, signed by a pinned author whom `owners` accepts. Throws a
 * `CryptoError`.
 */
export function verifyRevisionRecord({
  trust,
  owners,
  signed,
  expect,
}: {
  trust: TrustStore;
  owners: OpensOwner;
  signed: unknown;
  expect: ExpectedRevision;
}): RevisionRecord {
  const { record, signature } = parseWith(SignedRecord, signed, 'Revision record');
  checkRecord({ trust, owners, record, signature, expect, bytes: revisionRecordBytes(record) });
  return record;
}

// `owners` is given for v1 records, which only an accepted owner may author.
function checkRecord({
  trust,
  owners,
  record,
  signature,
  expect,
  bytes,
}: {
  trust: TrustStore;
  owners?: OpensOwner;
  record: RevisionRecord | RevisionRecordV2;
  signature: string;
  expect: ExpectedRevision;
  bytes: Uint8Array;
}): void {
  const mismatched = (
    ['installationId', 'spaceId', 'pageId', 'revisionId', 'audience'] as const
  ).filter((field) => expect[field] !== undefined && expect[field] !== record[field]);
  if (mismatched.length > 0) {
    throw new CryptoError(
      'binding-mismatch',
      `Revision does not match the requested ${mismatched.join(', ')}`,
    );
  }
  const author = trust.require(record.authorId, record.authorKeyVersion);
  if (!verifySignature(author, bytes, signature)) {
    throw new CryptoError('bad-signature', 'Revision record signature is invalid');
  }
  if (owners) requireAcceptedOwner(owners, author, 'author of a v1 record');
}

/**
 * Verify and decrypt a v2 revision. Runs `openRevision`'s record checks with
 * v2 bytes, takes its key through a key wrap or a v2 envelope from an owner
 * `owners` accepts, never a v1 envelope, and requires the key to match the
 * record's `keyCommitment` before decrypting. Returns the record's region.
 */
export function openRevisionV2({
  reader,
  trust,
  owners,
  revision: rawRevision,
  expect,
  ...material
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  revision: unknown;
  expect: ExpectedRevision;
} & KeyMaterial): { record: RevisionRecordV2; opened: OpenedPayload; region: Region } {
  const { record, signature, payload } = parseWith(SealedRevisionV2, rawRevision, 'Revision');
  checkRecord({ trust, record, signature, expect, bytes: revisionRecordV2Bytes(record) });
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Revision ciphertext does not match its signed hash');
  }
  const { contentKey, region } = material.keyring
    ? openThroughWrap({
        installationId: record.installationId,
        subject: revisionWrapSubject(record),
        wrap: material.wrap,
        keyring: material.keyring,
        commitment: record.keyCommitment,
      })
    : {
        contentKey: openAnyEnvelope(material.envelopes, (raw) =>
          openV2Envelope({ reader, trust, owners, record, raw }),
        ),
        region: OWNER_REGION,
      };
  try {
    return { record, opened: decryptRevisionPayload({ record, payload, contentKey }), region };
  } finally {
    sodium.memzero(contentKey);
  }
}

function openV2Envelope({
  reader,
  trust,
  owners,
  record,
  raw,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  record: RevisionRecordV2;
  raw: unknown;
}): Uint8Array {
  const envelope = parseWith(KeyEnvelopeV2, raw, 'Key envelope');
  checkEnvelopeV2({
    reader,
    trust,
    owners,
    envelope,
    namesThisVersion: envelope.revisionId === record.revisionId,
    signedBytes: () => keyEnvelopeV2Bytes(record, envelope),
  });
  return unsealCommitted(reader, envelope.sealedKey, record.keyCommitment);
}

const SignedRecordV2 = SealedRevisionV2.pick({ record: true, signature: true });

/** `verifyRevisionRecord` for a v2 record: the exact revision asked for, signed by a pinned author. */
export function verifyRevisionRecordV2({
  trust,
  signed,
  expect,
}: {
  trust: TrustStore;
  signed: unknown;
  expect: ExpectedRevision;
}): RevisionRecordV2 {
  const { record, signature } = parseWith(SignedRecordV2, signed, 'Revision record');
  checkRecord({ trust, record, signature, expect, bytes: revisionRecordV2Bytes(record) });
  return record;
}

/**
 * Decrypt a payload with a content key already in hand. Performs no signature
 * or trust checks; use `openRevision` for anything fetched from the server.
 * A v1 record's payload may hold ill-formed strings, which Milestone 1
 * clients could write (`PayloadRules.illFormedStrings`); a v2 payload may not.
 */
export function decryptRevisionPayload({
  record,
  payload,
  contentKey,
}: {
  record: PayloadBinding & Pick<RevisionRecord | RevisionRecordV2, 'protocol'>;
  payload: SealedRevision['payload'];
  contentKey: Uint8Array;
}): OpenedPayload {
  const plaintext = aeadDecrypt({ key: contentKey, sealed: payload, ad: payloadAd(record) });
  return parsePayload(
    parseJson(z.unknown(), plaintext, 'Payload', {
      integers: PAYLOAD_INTEGERS,
      illFormedStrings: record.protocol === 1,
    }),
  );
}

/**
 * Encrypt an attachment under its own fresh key. The returned blob is stored
 * opaquely; the ref goes into the payload of the revision that lists it.
 */
export function sealAttachment({
  target,
  name,
  mediaType,
  bytes,
}: {
  target: AttachmentTarget;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}): { ref: AttachmentRef; blob: Uint8Array } {
  const id = newId(AttachmentId);
  const { blob, ...sealed } = encryptAttachment({ target, id, bytes });
  return { ref: { id, name, mediaType, ...sealed }, blob };
}

function encryptAttachment({
  target,
  id,
  bytes,
}: {
  target: AttachmentTarget;
  id: AttachmentId;
  bytes: Uint8Array;
}): Pick<AttachmentRef, 'size' | 'key' | 'blobHash' | 'plainHash'> & { blob: Uint8Array } {
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const blob = sealedBytes(aeadEncrypt({ key, plaintext: bytes, ad: attachmentAd(target, id) }));
  return {
    size: bytes.length,
    key: toBase64(key),
    blobHash: hash(blob),
    plainHash: plainHash(target, bytes),
    blob,
  };
}

type PlainHashScope = Pick<AttachmentTarget, 'installationId' | 'spaceId' | 'pageId'>;

/**
 * A hash of an attachment's plaintext, scoped to its page but not its
 * audience, so a page's draft and published copies of one file compare
 * equal. It lives only inside the encrypted payload, and decides when an
 * earlier copy may be reused.
 */
export const plainHash = (scope: PlainHashScope, plaintext: Uint8Array): string =>
  hash(
    canonical('attachment-plain-hash/v1', [
      scope.installationId,
      scope.spaceId,
      scope.pageId,
      plaintext,
    ]),
  );

export function openAttachment({
  target,
  ref,
  blob,
}: {
  target: AttachmentTarget;
  ref: AttachmentRef;
  blob: Uint8Array;
}): Uint8Array {
  if (hash(blob) !== ref.blobHash)
    throw new CryptoError('hash-mismatch', 'Attachment blob does not match its ref');
  const nonceBytes = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const plaintext = aeadDecrypt({
    key: fromBase64(ref.key),
    sealed: {
      nonce: toBase64(blob.subarray(0, nonceBytes)),
      ciphertext: toBase64(blob.subarray(nonceBytes)),
    },
    ad: attachmentAd(target, ref.id),
  });
  // Every decryption checks it, so a writer can't attach one file and claim another's hash.
  if (ref.plainHash !== undefined && plainHash(target, plaintext) !== ref.plainHash) {
    throw new CryptoError('hash-mismatch', 'Attachment plaintext does not match its plainHash');
  }
  return plaintext;
}

/**
 * Re-encrypt an attachment for a different audience under a fresh key.
 * Publishing uses this so readers never get a key that opens a draft blob.
 * The ID and any fields this client doesn't know are kept, so references to
 * the attachment by ID still resolve in the published version. `plainHash`
 * is recomputed for the target page.
 */
export function resealAttachment({
  from,
  to,
  ref,
  blob,
}: {
  from: AttachmentTarget;
  to: AttachmentTarget;
  ref: AttachmentRef;
  blob: Uint8Array;
}): { ref: AttachmentRef; blob: Uint8Array } {
  const bytes = openAttachment({ target: from, ref, blob });
  const { blob: resealed, ...sealed } = encryptAttachment({ target: to, id: ref.id, bytes });
  return { ref: { ...ref, ...sealed }, blob: resealed };
}

/**
 * A revision's content key, for an owner wrapping it into a new share,
 * sealing it to a new co-owner, or moving it to another region (sections
 * 6.7, 7.6 and 10): through this reader's own envelopes, or through its key
 * wrap and the folder keys held, which fixes its region as opening does.
 * The record checks of `openRevision` or `openRevisionV2`, then the key,
 * checked against the record: by its key commitment, or for a v1 record,
 * which has none, by decrypting its payload, so a v1 record must come with
 * it. The caller wipes the key.
 */
export function unsealRevisionKey({
  reader,
  trust,
  owners,
  revision: raw,
  expect,
  ...material
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  revision: unknown;
  expect: ExpectedRevision;
} & KeyMaterial): {
  record: RevisionRecord | RevisionRecordV2;
  contentKey: Uint8Array;
  region: Region;
} {
  if (recordProtocol(raw, 'Revision') === 2) {
    const { record, signature } = parseWith(SignedRecordV2, raw, 'Revision');
    checkRecord({ trust, record, signature, expect, bytes: revisionRecordV2Bytes(record) });
    const opened = material.keyring
      ? openThroughWrap({
          installationId: record.installationId,
          subject: revisionWrapSubject(record),
          wrap: material.wrap,
          keyring: material.keyring,
          commitment: record.keyCommitment,
        })
      : {
          contentKey: openAnyEnvelope(material.envelopes, (envelope) =>
            openV2Envelope({ reader, trust, owners, record, raw: envelope }),
          ),
          region: OWNER_REGION,
        };
    return { record, ...opened };
  }
  const { record, signature, payload } = parseWith(SealedRevision, raw, 'Revision');
  checkRecord({ trust, owners, record, signature, expect, bytes: revisionRecordBytes(record) });
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Revision ciphertext does not match its signed hash');
  }
  const { contentKey, region } = material.keyring
    ? openThroughWrap({
        installationId: record.installationId,
        subject: revisionWrapSubject(record),
        wrap: material.wrap,
        keyring: material.keyring,
        commitment: null,
      })
    : {
        contentKey: openAnyEnvelope(material.envelopes, (envelope) =>
          openV1RecordEnvelope({ reader, trust, owners, record, raw: envelope }),
        ),
        region: OWNER_REGION,
      };
  try {
    decryptRevisionPayload({ record, payload, contentKey });
  } catch (error) {
    sodium.memzero(contentKey);
    throw error;
  }
  return { record, contentKey, region };
}
