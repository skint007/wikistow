import {
  Base64,
  MetadataEnvelope,
  MetadataEnvelopeV2,
  MetadataRecord,
  MetadataRecordV2,
  SealedMetadata,
  SealedMetadataV2,
  type PublicIdentity,
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
  metadataWrapSubject,
  openThroughWrap,
  wrapContentKey,
  type KeyMaterial,
  type KeyWrap,
} from './folder-keys.ts';
import { CryptoError } from './errors.ts';
import { sign, verifySignature, type PrivateIdentity } from './identity.ts';
import { Format } from './payload.ts';
import { OWNER_REGION, type Region } from './regions.ts';
import type { KeyTarget } from './revision.ts';
import { sodium } from './sodium.ts';
import type { TrustStore } from './trust.ts';

export {
  MetadataEnvelope,
  MetadataEnvelopeV2,
  MetadataRecord,
  MetadataRecordV2,
  SealedMetadata,
  SealedMetadataV2,
};

export const METADATA_FORMAT = { major: 1, minor: 0 } as const;

/** Folder tints in the design. Stored as plain strings so newer tints survive older clients. */
export const FOLDER_TINTS = ['green', 'orange', 'blue', 'pink', 'purple'] as const;

/**
 * The decrypted metadata of a space or folder. Names are content, so they
 * are encrypted like pages; the server only sees IDs and structure. Loose,
 * with an `extensions` map, so data from newer clients survives a rename.
 */
export const NodeMetadata = z.looseObject({
  format: Format.extend({ major: z.literal(METADATA_FORMAT.major) }),
  name: z.string().min(1).max(200),
  emoji: z.string().max(32).optional(),
  tint: z.string().max(32).optional(),
  extensions: z.record(z.string(), z.json()),
});
export type NodeMetadata = z.infer<typeof NodeMetadata>;

export type OpenedMetadata =
  | { kind: 'current'; metadata: NodeMetadata }
  | { kind: 'newer-format'; format: z.infer<typeof Format> };

/** A folder's emoji and tint. */
export type FolderLook = { emoji: string; tint: string };

/**
 * ⭐ on blue: how a new folder starts, so nobody has to choose when creating
 * one, and how a folder whose metadata names neither shows.
 */
export const DEFAULT_FOLDER_LOOK: FolderLook = { emoji: '⭐', tint: 'blue' };

/** The extension holding a folder's image, inside its encrypted metadata (section 5.5). */
export const ICON_NAMESPACE = 'wikistow.icon';

/** The formats an icon image is stored in. */
export const ICON_MEDIA_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;
export type IconMediaType = (typeof ICON_MEDIA_TYPES)[number];

/** The largest icon image kept, encoded: every tree load carries each folder's. */
export const ICON_MAX_BYTES = 16 * 1024;

/** An icon image, already resized and encoded. */
export type FolderIcon = { mediaType: IconMediaType; bytes: Uint8Array };

const StoredIcon = z.looseObject({
  format: z.literal(1),
  mediaType: z.enum(ICON_MEDIA_TYPES),
  data: Base64,
});

/**
 * A folder's image, or null for none: anything other than an image of an
 * accepted type and size counts as none, so the folder shows its emoji.
 */
export function folderIconOf({ extensions }: NodeMetadata): FolderIcon | null {
  const stored = StoredIcon.safeParse(extensions[ICON_NAMESPACE]);
  if (!stored.success) return null;
  try {
    const bytes = fromBase64(stored.data.data);
    return bytes.length > 0 && bytes.length <= ICON_MAX_BYTES
      ? { mediaType: stored.data.mediaType, bytes }
      : null;
  } catch {
    return null;
  }
}

/**
 * The `extensions` change that sets a folder's image, or removes it with
 * null: extensions are merged, so a removed one is written as null.
 */
export function folderIconChange(icon: FolderIcon | null): NodeMetadata['extensions'] {
  const size = icon?.bytes.length ?? 0;
  if (icon && (!ICON_MEDIA_TYPES.includes(icon.mediaType) || size === 0 || size > ICON_MAX_BYTES)) {
    throw new CryptoError('malformed', 'An icon must be a WebP, JPEG or PNG of at most 16 KB');
  }
  return {
    [ICON_NAMESPACE]: icon && { format: 1, mediaType: icon.mediaType, data: toBase64(icon.bytes) },
  };
}

export const newFolderMetadata = (
  name: string,
  { emoji, tint }: FolderLook = DEFAULT_FOLDER_LOOK,
  icon: FolderIcon | null = null,
): NodeMetadata => ({
  format: { ...METADATA_FORMAT },
  name,
  emoji,
  tint,
  extensions: icon ? folderIconChange(icon) : {},
});

export const newSpaceMetadata = (name: string, emoji?: string): NodeMetadata => ({
  format: { ...METADATA_FORMAT },
  name,
  ...(emoji === undefined ? {} : { emoji }),
  extensions: {},
});

// As with page payloads: validate, but keep the caller's object, because Zod
// rebuilds loose objects by assignment and would drop a "__proto__" data key.
const isNodeMetadata = (json: unknown): json is NodeMetadata =>
  NodeMetadata.safeParse(json).success;

export function parseMetadata(json: unknown): OpenedMetadata {
  const format = z.object({ format: Format }).safeParse(json);
  if (!format.success) {
    throw new CryptoError('malformed', 'Metadata has no format version', { cause: format.error });
  }
  if (format.data.format.major > METADATA_FORMAT.major) {
    return { kind: 'newer-format', format: format.data.format };
  }
  if (!isNodeMetadata(json)) {
    const { error } = NodeMetadata.safeParse(json);
    throw new CryptoError('malformed', 'Metadata has an invalid shape', { cause: error });
  }
  return { kind: 'current', metadata: json };
}

export type MetadataChanges = Partial<Pick<NodeMetadata, 'name' | 'emoji' | 'tint' | 'extensions'>>;

/** The next version: everything this client doesn't change is carried over unchanged. */
export function reviseMetadata(previous: OpenedMetadata, changes: MetadataChanges): NodeMetadata {
  if (previous.kind === 'newer-format') {
    const { major, minor } = previous.format;
    throw new CryptoError(
      'unsupported-format',
      `Metadata format ${major}.${minor} is newer than this client; update to save`,
    );
  }
  const { metadata } = previous;
  return {
    ...metadata,
    ...changes,
    format: {
      ...metadata.format,
      major: METADATA_FORMAT.major,
      minor: Math.max(metadata.format.minor, METADATA_FORMAT.minor),
    },
    extensions: { ...metadata.extensions, ...changes.extensions },
  };
}

/** The fields a writer chooses; the rest of the record is derived when sealing. */
export type MetadataTarget = Pick<
  MetadataRecord,
  'installationId' | 'spaceId' | 'subjectKind' | 'subjectId' | 'metadataRevisionId' | 'basedOn'
>;

/** The bytes an author signs. The server verifies them too. */
export const metadataRecordBytes = (r: MetadataRecord) =>
  canonical('metadata-record/v1', [
    r.protocol,
    r.installationId,
    r.spaceId,
    r.subjectKind,
    r.subjectId,
    r.metadataRevisionId,
    r.basedOn,
    r.authorId,
    r.authorKeyVersion,
    r.payloadHash,
  ]);

// Binds the ciphertext to its subject, version, and author, like page payloads.
const metadataAd = (r: Omit<MetadataRecord, 'protocol' | 'basedOn' | 'payloadHash'>) =>
  canonical('metadata-payload/v1', [
    r.installationId,
    r.spaceId,
    r.subjectKind,
    r.subjectId,
    r.metadataRevisionId,
    r.authorId,
    r.authorKeyVersion,
  ]);

/** The bytes a granter signs for a metadata key envelope. The server verifies them too. */
export const metadataEnvelopeBytes = (
  record: Pick<MetadataRecord, 'installationId' | 'payloadHash'>,
  e: Omit<MetadataEnvelope, 'signature'>,
) =>
  canonical('metadata-envelope/v1', [
    record.installationId,
    record.payloadHash,
    e.metadataRevisionId,
    e.recipientId,
    e.recipientKeyVersion,
    fromBase64(e.sealedKey),
    e.granterId,
    e.granterKeyVersion,
  ]);

/** The bytes an author signs for a v2 metadata record. */
export const metadataRecordV2Bytes = (r: MetadataRecordV2) =>
  canonical('metadata-record/v2', [
    r.protocol,
    r.installationId,
    r.spaceId,
    r.subjectKind,
    r.subjectId,
    r.metadataRevisionId,
    r.basedOn,
    r.authorId,
    r.authorKeyVersion,
    r.payloadHash,
    r.keyCommitment,
  ]);

/** The bytes a granter signs for a v2 metadata envelope, with the record's space and hash. */
export const metadataEnvelopeV2Bytes = (
  record: Pick<MetadataRecordV2, 'installationId' | 'spaceId' | 'payloadHash'>,
  e: Omit<MetadataEnvelopeV2, 'signature'>,
) =>
  canonical('metadata-envelope/v2', [
    record.installationId,
    record.spaceId,
    record.payloadHash,
    e.metadataRevisionId,
    e.recipientId,
    e.recipientKeyVersion,
    fromBase64(e.sealedKey),
    e.granterId,
    e.granterKeyVersion,
  ]);

/**
 * Encrypt one metadata version under a fresh key sealed to each recipient.
 * `recipients` must come from `TrustStore.recipients`, never the directory.
 */
export function sealMetadata({
  author,
  target,
  metadata,
  recipients,
}: {
  author: PrivateIdentity;
  target: MetadataTarget;
  metadata: NodeMetadata;
  recipients: readonly PublicIdentity[];
}): { metadata: SealedMetadata; envelopes: MetadataEnvelope[] } {
  const { binding, payload, key } = encryptMetadata({ author, target, metadata });
  const record: MetadataRecord = {
    protocol: 1,
    ...binding,
    payloadHash: hash(sealedBytes(payload)),
  };
  const envelopes = recipients.map((recipient) => {
    const unsigned = {
      metadataRevisionId: record.metadataRevisionId,
      recipientId: recipient.id,
      recipientKeyVersion: recipient.keyVersion,
      sealedKey: sealKeyTo(key, recipient),
      granterId: author.public.id,
      granterKeyVersion: author.public.keyVersion,
    };
    return { ...unsigned, signature: sign(author, metadataEnvelopeBytes(record, unsigned)) };
  });
  sodium.memzero(key);
  return {
    metadata: { record, signature: sign(author, metadataRecordBytes(record)), payload },
    envelopes,
  };
}

// Anything that wouldn't open again (say, an empty or 300-character name) is
// refused here; once stored, no client could open it to fix it. The caller
// wipes the key.
function encryptMetadata({
  author,
  target,
  metadata,
}: {
  author: PrivateIdentity;
  target: MetadataTarget;
  metadata: NodeMetadata;
}) {
  if (!isNodeMetadata(metadata)) {
    throw new CryptoError('malformed', 'Metadata is not valid', {
      cause: NodeMetadata.safeParse(metadata).error,
    });
  }
  const plaintext = utf8(JSON.stringify(metadata));
  // As for revisions: never seal what the strict reader would refuse.
  parseJson(NodeMetadata, plaintext, 'Metadata');
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  const binding = {
    ...target,
    authorId: author.public.id,
    authorKeyVersion: author.public.keyVersion,
  };
  const payload = aeadEncrypt({ key, plaintext, ad: metadataAd(binding) });
  return { binding, payload, key };
}

/**
 * Seal a v2 metadata version, committing to its key, with one v2 envelope
 * per sealing owner in the owner region, or one key wrap under a share's
 * published key (section 6.2: names are read by readers too).
 */
export function sealMetadataV2({
  author,
  target,
  metadata,
  ...to
}: {
  author: PrivateIdentity;
  target: MetadataTarget;
  metadata: NodeMetadata;
} & KeyTarget): {
  metadata: SealedMetadataV2;
  envelopes: MetadataEnvelopeV2[];
  wrap: KeyWrap | null;
} {
  const { binding, payload, key } = encryptMetadata({ author, target, metadata });
  try {
    const record: MetadataRecordV2 = {
      protocol: 2,
      ...binding,
      payloadHash: hash(sealedBytes(payload)),
      keyCommitment: keyCommitment(key),
    };
    const sealed = { record, signature: sign(author, metadataRecordV2Bytes(record)), payload };
    if (to.share) {
      const wrap = wrapContentKey({
        installationId: record.installationId,
        subject: metadataWrapSubject(record),
        shareId: to.share.shareId,
        keyVersion: to.share.keyVersion,
        folderKey: to.share.publishedKey,
        contentKey: key,
      });
      return { metadata: sealed, envelopes: [], wrap };
    }
    const envelopes = (to.recipients ?? []).map((recipient) =>
      grantMetadataKeyV2({ granter: author, record, contentKey: key, recipient }),
    );
    return { metadata: sealed, envelopes, wrap: null };
  } finally {
    sodium.memzero(key);
  }
}

/** Seal a v2 metadata version's key to one recipient, as a write or a new co-owner needs. */
export function grantMetadataKeyV2({
  granter,
  record,
  contentKey,
  recipient,
}: {
  granter: PrivateIdentity;
  /** A v1 record too: an owner seals Milestone 1 names to a new co-owner in v2 envelopes. */
  record: Pick<
    MetadataRecordV2,
    'installationId' | 'spaceId' | 'payloadHash' | 'metadataRevisionId'
  >;
  contentKey: Uint8Array;
  recipient: PublicIdentity;
}): MetadataEnvelopeV2 {
  const unsigned = {
    version: 2 as const,
    metadataRevisionId: record.metadataRevisionId,
    recipientId: recipient.id,
    recipientKeyVersion: recipient.keyVersion,
    sealedKey: sealKeyTo(contentKey, recipient),
    granterId: granter.public.id,
    granterKeyVersion: granter.public.keyVersion,
  };
  return { ...unsigned, signature: sign(granter, metadataEnvelopeV2Bytes(record, unsigned)) };
}

export type ExpectedMetadata = Pick<
  MetadataRecord,
  'installationId' | 'spaceId' | 'subjectKind' | 'subjectId' | 'metadataRevisionId'
>;

/**
 * Verify and decrypt a v1 metadata version fetched from the server, with the
 * same checks as `openRevision`: the exact version asked for, signed by a
 * pinned author whom `owners` accepts, and ciphertext matching its signed
 * hash. Its key comes through a v1 envelope granted by the author, a v2
 * envelope from an accepted owner, or a key wrap, which fixes its region.
 */
export function openMetadata({
  reader,
  trust,
  owners,
  metadata: raw,
  expect,
  ...material
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  metadata: unknown;
  expect: ExpectedMetadata;
} & KeyMaterial): { record: MetadataRecord; opened: OpenedMetadata; region: Region } {
  const { record, signature, payload } = parseWith(SealedMetadata, raw, 'Metadata');
  checkMetadataRecord({
    trust,
    owners,
    record,
    signature,
    expect,
    bytes: metadataRecordBytes(record),
  });
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Metadata ciphertext does not match its signed hash');
  }
  const { contentKey: key, region } = material.keyring
    ? openThroughWrap({
        installationId: record.installationId,
        subject: metadataWrapSubject(record),
        wrap: material.wrap,
        keyring: material.keyring,
        commitment: null,
      })
    : {
        contentKey: openAnyEnvelope(material.envelopes, (raw) =>
          openV1MetadataEnvelope({ reader, trust, owners, record, raw }),
        ),
        region: OWNER_REGION,
      };
  try {
    const plaintext = aeadDecrypt({ key, sealed: payload, ad: metadataAd(record) });
    // A v1 name may hold a lone surrogate, as Milestone 1 clients could write.
    const json = parseJson(z.unknown(), plaintext, 'Metadata', { illFormedStrings: true });
    return { record, opened: parseMetadata(json), region };
  } finally {
    sodium.memzero(key);
  }
}

// A v1 record's key from a v1 envelope granted by its author, or a v2
// envelope granted by an accepted owner since.
function openV1MetadataEnvelope({
  reader,
  trust,
  owners,
  record,
  raw,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  record: MetadataRecord;
  raw: unknown;
}): Uint8Array {
  if (envelopeVersion(raw) === 1) {
    const envelope = parseWith(MetadataEnvelope, raw, 'Metadata envelope');
    return openEnvelope({
      reader,
      trust,
      envelope,
      namesThisVersion: envelope.metadataRevisionId === record.metadataRevisionId,
      author: { id: record.authorId, keyVersion: record.authorKeyVersion },
      signedBytes: () => metadataEnvelopeBytes(record, envelope),
    });
  }
  const envelope = parseWith(MetadataEnvelopeV2, raw, 'Metadata envelope');
  checkEnvelopeV2({
    reader,
    trust,
    owners,
    envelope,
    namesThisVersion: envelope.metadataRevisionId === record.metadataRevisionId,
    signedBytes: () => metadataEnvelopeV2Bytes(record, envelope),
  });
  return openSealedKey(reader, envelope.sealedKey);
}

// `owners` is given for v1 records, which only an accepted owner may author.
function checkMetadataRecord({
  trust,
  owners,
  record,
  signature,
  expect,
  bytes,
}: {
  trust: TrustStore;
  owners?: OpensOwner;
  record: MetadataRecord | MetadataRecordV2;
  signature: string;
  expect: ExpectedMetadata;
  bytes: Uint8Array;
}): void {
  const fields = [
    'installationId',
    'spaceId',
    'subjectKind',
    'subjectId',
    'metadataRevisionId',
  ] as const;
  const mismatched = fields.filter((field) => expect[field] !== record[field]);
  if (mismatched.length > 0) {
    throw new CryptoError(
      'binding-mismatch',
      `Metadata does not match the requested ${mismatched.join(', ')}`,
    );
  }
  const author = trust.require(record.authorId, record.authorKeyVersion);
  if (!verifySignature(author, bytes, signature)) {
    throw new CryptoError('bad-signature', 'Metadata record signature is invalid');
  }
  if (owners) requireAcceptedOwner(owners, author, 'author of a v1 record');
}

/**
 * Verify and decrypt a v2 metadata version: `openMetadata`'s checks with v2
 * bytes, a key through a key wrap or a v2 envelope from an owner `owners`
 * accepts, then the key commitment. Returns the record's region.
 */
export function openMetadataV2({
  reader,
  trust,
  owners,
  metadata: raw,
  expect,
  ...material
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  metadata: unknown;
  expect: ExpectedMetadata;
} & KeyMaterial): { record: MetadataRecordV2; opened: OpenedMetadata; region: Region } {
  const { record, signature, payload } = parseWith(SealedMetadataV2, raw, 'Metadata');
  checkMetadataRecord({ trust, record, signature, expect, bytes: metadataRecordV2Bytes(record) });
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Metadata ciphertext does not match its signed hash');
  }
  const { contentKey: key, region } = material.keyring
    ? openThroughWrap({
        installationId: record.installationId,
        subject: metadataWrapSubject(record),
        wrap: material.wrap,
        keyring: material.keyring,
        commitment: record.keyCommitment,
      })
    : {
        contentKey: openAnyEnvelope(material.envelopes, (raw) =>
          openV2MetadataEnvelope({ reader, trust, owners, record, raw }),
        ),
        region: OWNER_REGION,
      };
  try {
    const plaintext = aeadDecrypt({ key, sealed: payload, ad: metadataAd(record) });
    return { record, opened: parseMetadata(parseJson(z.unknown(), plaintext, 'Metadata')), region };
  } finally {
    sodium.memzero(key);
  }
}

function openV2MetadataEnvelope({
  reader,
  trust,
  owners,
  record,
  raw,
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  record: MetadataRecordV2;
  raw: unknown;
}): Uint8Array {
  const envelope = parseWith(MetadataEnvelopeV2, raw, 'Metadata envelope');
  checkEnvelopeV2({
    reader,
    trust,
    owners,
    envelope,
    namesThisVersion: envelope.metadataRevisionId === record.metadataRevisionId,
    signedBytes: () => metadataEnvelopeV2Bytes(record, envelope),
  });
  return unsealCommitted(reader, envelope.sealedKey, record.keyCommitment);
}

const SignedMetadataV2 = SealedMetadataV2.pick({ record: true, signature: true });

/**
 * A metadata version's content key, for an owner wrapping it into a new
 * share, sealing it to a new co-owner, or moving it to another region
 * (sections 6.7, 7.6 and 10): through this reader's own envelopes, or
 * through its key wrap and the folder keys held, which fixes its region.
 * The record checks of `openMetadata` or `openMetadataV2`, then the key,
 * checked against the record: by its key commitment, or for a v1 record,
 * which has none, by decrypting its payload, so a v1 record must come with
 * it. The caller wipes the key.
 */
export function unsealMetadataKey({
  reader,
  trust,
  owners,
  metadata: raw,
  expect,
  ...material
}: {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  metadata: unknown;
  expect: ExpectedMetadata;
} & KeyMaterial): {
  record: MetadataRecord | MetadataRecordV2;
  contentKey: Uint8Array;
  region: Region;
} {
  if (recordProtocol(raw, 'Metadata') === 2) {
    const { record, signature } = parseWith(SignedMetadataV2, raw, 'Metadata');
    checkMetadataRecord({ trust, record, signature, expect, bytes: metadataRecordV2Bytes(record) });
    const opened = material.keyring
      ? openThroughWrap({
          installationId: record.installationId,
          subject: metadataWrapSubject(record),
          wrap: material.wrap,
          keyring: material.keyring,
          commitment: record.keyCommitment,
        })
      : {
          contentKey: openAnyEnvelope(material.envelopes, (envelope) =>
            openV2MetadataEnvelope({ reader, trust, owners, record, raw: envelope }),
          ),
          region: OWNER_REGION,
        };
    return { record, ...opened };
  }
  const { record, signature, payload } = parseWith(SealedMetadata, raw, 'Metadata');
  checkMetadataRecord({
    trust,
    owners,
    record,
    signature,
    expect,
    bytes: metadataRecordBytes(record),
  });
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Metadata ciphertext does not match its signed hash');
  }
  const { contentKey, region } = material.keyring
    ? openThroughWrap({
        installationId: record.installationId,
        subject: metadataWrapSubject(record),
        wrap: material.wrap,
        keyring: material.keyring,
        commitment: null,
      })
    : {
        contentKey: openAnyEnvelope(material.envelopes, (envelope) =>
          openV1MetadataEnvelope({ reader, trust, owners, record, raw: envelope }),
        ),
        region: OWNER_REGION,
      };
  try {
    sodium.memzero(aeadDecrypt({ key: contentKey, sealed: payload, ad: metadataAd(record) }));
  } catch (error) {
    sodium.memzero(contentKey);
    throw error;
  }
  return { record, contentKey, region };
}
