// Comments on pages (protocol section 5.9, ADR 0014): the payload, comment
// format 1.0, sealing a comment version in its page's region, and opening
// one with the checks of decision 4. A comment is a metadata record v2 with
// `subjectKind: "comment"`; its payload names its page, thread and audience,
// which the record doesn't sign.
import {
  CommentId,
  IdentityId,
  MetadataEnvelopeV2,
  PageId,
  RevisionId,
  SealedComment,
  type Audience,
  type CommentRecord,
  type InstallationId,
  type MetadataRevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import { z } from 'zod';
import {
  aeadDecrypt,
  aeadEncrypt,
  hash,
  keepParsed,
  parseJson,
  parseWith,
  sealedBytes,
  utf8,
} from './encoding.ts';
import {
  checkEnvelopeV2,
  keyCommitment,
  openAnyEnvelope,
  unsealCommitted,
  type OpensOwner,
} from './envelope.ts';
import { CryptoError } from './errors.ts';
import {
  KeyWrap,
  unwrapContentKey,
  wrapContentKey,
  type FolderKeyring,
  type WrapSubject,
} from './folder-keys.ts';
import { sign, verifySignature, type PrivateIdentity } from './identity.ts';
import {
  grantMetadataKeyV2,
  metadataAd,
  metadataEnvelopeV2Bytes,
  metadataRecordV2Bytes,
} from './metadata.ts';
import { Format } from './payload.ts';
import { OWNER_REGION, sameRegion, type Region } from './regions.ts';
import type { KeyTarget } from './revision.ts';
import { sodium } from './sodium.ts';
import type { TrustStore } from './trust.ts';

export { SealedComment };

export const COMMENT_FORMAT = { major: 1, minor: 0 } as const;

/** The longest comment, in characters (Unicode scalar values, section 3.3). */
export const MAX_COMMENT_TEXT = 10_000;
/** The longest passage a quote holds, and the context on each side of it. */
export const MAX_QUOTE = 500;
export const MAX_QUOTE_CONTEXT = 64;

// Characters as section 3.3 counts them: scalar values, not UTF-16 units.
const characters = (min: number, max: number) =>
  z.string().refine((text) => {
    const count = scalarCount(text);
    return count >= min && count <= max;
  }, `Between ${min} and ${max} characters`);

/** How many Unicode scalar values `text` holds, as section 3.3 counts characters. */
export function scalarCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/**
 * The passage a first comment is on (decision 5), as text: `exact` in the
 * page's own text, with up to 64 characters on each side to tell repeats
 * apart, chosen in version `revisionId`. Loose, as the payload is.
 */
export const CommentQuote = z.looseObject({
  revisionId: RevisionId,
  exact: characters(1, MAX_QUOTE),
  prefix: characters(0, MAX_QUOTE_CONTEXT),
  suffix: characters(0, MAX_QUOTE_CONTEXT),
});
export type CommentQuote = z.infer<typeof CommentQuote>;

/**
 * A comment version's decrypted payload, comment format 1.0 (section 5.9).
 * Loose, with an `extensions` map, so an edit keeps what a newer app wrote.
 * `thread` and `threadAuthor` are both present, and null together for a
 * first comment. Only a first comment has a `quote`, never null.
 */
export const CommentPayload = z
  .looseObject({
    format: Format.extend({ major: z.literal(COMMENT_FORMAT.major) }),
    pageId: PageId,
    thread: CommentId.nullable(),
    threadAuthor: IdentityId.nullable(),
    audience: z.enum(['draft', 'published']),
    text: characters(1, MAX_COMMENT_TEXT),
    quote: CommentQuote.optional(),
    extensions: z.record(z.string(), z.json()),
  })
  .refine((p) => (p.thread === null) === (p.threadAuthor === null), {
    message: 'A reply names its thread and the thread’s author, a first comment neither',
  })
  .refine((p) => p.thread === null || !Object.hasOwn(p, 'quote'), {
    message: 'Only a first comment has a quote',
  });
export type CommentPayload = z.infer<typeof CommentPayload>;

/** A new comment's payload: a first comment, or a reply to `reply`'s thread. */
export function newCommentPayload({
  pageId,
  audience,
  text,
  reply = null,
  quote,
}: {
  pageId: PageId;
  audience: Audience;
  text: string;
  reply?: { thread: CommentId; threadAuthor: IdentityId } | null;
  quote?: CommentQuote | undefined;
}): CommentPayload {
  return {
    format: { ...COMMENT_FORMAT },
    pageId,
    thread: reply?.thread ?? null,
    threadAuthor: reply?.threadAuthor ?? null,
    audience,
    text,
    ...(quote && !reply ? { quote } : {}),
    extensions: {},
  };
}

/**
 * An edit's payload: the version it is based on, with new text. Everything
 * else is kept as it was, page, thread, audience and quote included, and
 * fields this app doesn't know too.
 */
export const revisedComment = (previous: CommentPayload, text: string): CommentPayload => ({
  ...previous,
  text,
  format: {
    ...previous.format,
    minor: Math.max(previous.format.minor, COMMENT_FORMAT.minor),
  },
});

/**
 * A comment's wrap subject (section 5.9, **For the build**): its audience
 * is the wrap's class, so its folder key is that class's, never the
 * published key a name takes (`metadataWrapSubject`).
 */
export const commentWrapSubject = (c: {
  spaceId: SpaceId;
  audience: Audience;
  commentId: CommentId;
  versionId: string;
}): WrapSubject => ({
  spaceId: c.spaceId,
  audienceClass: c.audience,
  subjectKind: 'comment',
  subjectId: c.commentId,
  versionId: c.versionId,
});

/** The fields a writer chooses; the rest of the record is derived when sealing. */
export type CommentTarget = {
  installationId: InstallationId;
  spaceId: SpaceId;
  commentId: CommentId;
  versionId: MetadataRevisionId;
  /** Null for a first version; an edit is based on the current one. */
  basedOn: MetadataRevisionId | null;
};

/**
 * Seal one comment version under a fresh content key, in its page's region
 * (section 5.9): one key wrap under the share's key version with the folder
 * key of the payload's audience, or one v2 envelope per sealing owner. A
 * payload outside the format's rules is refused (`malformed`), as is a
 * comment for editors without the draft key (`missing-key`).
 */
export function sealComment({
  author,
  target,
  payload,
  ...to
}: {
  author: PrivateIdentity;
  target: CommentTarget;
  payload: CommentPayload;
} & KeyTarget): { metadata: SealedComment; wrap: KeyWrap | null; envelopes: MetadataEnvelopeV2[] } {
  const plaintext = utf8(JSON.stringify(keepParsed(CommentPayload, payload, 'Comment')));
  // As for revisions: never seal what the strict reader would refuse.
  readPayload(plaintext);
  const bound = {
    protocol: 2 as const,
    installationId: target.installationId,
    spaceId: target.spaceId,
    subjectKind: 'comment' as const,
    subjectId: target.commentId,
    metadataRevisionId: target.versionId,
    basedOn: target.basedOn,
    authorId: author.public.id,
    authorKeyVersion: author.public.keyVersion,
  };
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  try {
    const sealedPayload = aeadEncrypt({ key, plaintext, ad: metadataAd(bound) });
    const record: CommentRecord = {
      ...bound,
      payloadHash: hash(sealedBytes(sealedPayload)),
      keyCommitment: keyCommitment(key),
    };
    const metadata = {
      record,
      signature: sign(author, metadataRecordV2Bytes(record)),
      payload: sealedPayload,
    };
    if (to.share) {
      const folderKey = payload.audience === 'draft' ? to.share.draftKey : to.share.publishedKey;
      if (!folderKey) {
        throw new CryptoError('missing-key', 'A comment for editors needs the draft key');
      }
      const wrap = wrapContentKey({
        installationId: record.installationId,
        subject: commentWrapSubject({
          spaceId: record.spaceId,
          audience: payload.audience,
          commentId: record.subjectId,
          versionId: record.metadataRevisionId,
        }),
        shareId: to.share.shareId,
        keyVersion: to.share.keyVersion,
        folderKey,
        contentKey: key,
      });
      return { metadata, wrap, envelopes: [] };
    }
    const envelopes = to.recipients.map((recipient) =>
      grantMetadataKeyV2({ granter: author, record, contentKey: key, recipient }),
    );
    return { metadata, wrap: null, envelopes };
  } finally {
    sodium.memzero(key);
  }
}

/** What the server says of a comment: where it is, and for whom (section 5.9, **Opening**). */
export type ListedComment = {
  spaceId: SpaceId;
  pageId: PageId;
  commentId: CommentId;
  /** The thread's first comment, or null for a first comment. */
  thread: CommentId | null;
  audience: Audience;
};

/** A comment version, opened. One in a newer major format is opened only that far. */
export type OpenedComment =
  | { kind: 'current'; record: CommentRecord; payload: CommentPayload; region: Region }
  | {
      kind: 'newer-format';
      record: CommentRecord;
      format: z.infer<typeof Format>;
      region: Region;
    };

type Opening = {
  reader: PrivateIdentity;
  trust: TrustStore;
  owners: OpensOwner;
  installationId: InstallationId;
  keyring: FolderKeyring;
  /** The comment's current version as served, with this reader's key material for it. */
  sealed: { comment: unknown; wrap: unknown; envelopes: readonly unknown[] };
  listed: ListedComment;
  /**
   * The region of the page's version this app opened (decision 4), or for
   * an owner's operation, the region its scan covers.
   */
  region: Region;
};

/**
 * Verify and decrypt a comment version (section 5.9, **Opening**): its key
 * material in `region` (`region-mismatch`), the checks of a metadata record
 * v2 for this comment, a wrap opened with the AD of the audience the server
 * lists or an envelope from an accepted owner, the key commitment, and the
 * payload's page, thread and audience against what the server lists
 * (`binding-mismatch`). Its author must already be pinned (`pinAuthors`).
 * A reply's `threadAuthor` is checked against its first comment by the
 * caller, which has both. Throws a `CryptoError`.
 */
export function openComment(args: Opening): OpenedComment {
  const { opened, contentKey } = openCommentKey(args);
  sodium.memzero(contentKey);
  return opened;
}

/**
 * `openComment`, keeping the content key, for an owner who wraps or seals
 * the comment again (section 5.9, **For the build**: opened in full, never
 * by its key alone). The caller wipes the key.
 */
export function openCommentKey({
  reader,
  trust,
  owners,
  installationId,
  keyring,
  sealed,
  listed,
  region,
}: Opening): { opened: OpenedComment; contentKey: Uint8Array } {
  const wrapped = sealed.wrap !== null && sealed.wrap !== undefined;
  if (wrapped && sealed.envelopes.length > 0) {
    throw new CryptoError('region-mismatch', 'A comment came with both a key wrap and envelopes');
  }
  if (!wrapped && sealed.envelopes.length === 0) {
    throw new CryptoError('missing-key', 'A comment came with no key');
  }
  const own: Region = wrapped
    ? {
        kind: 'share',
        spaceId: listed.spaceId,
        shareId: parseWith(KeyWrap, sealed.wrap, 'Key wrap').shareId,
      }
    : OWNER_REGION;
  if (!sameRegion(own, region)) {
    throw new CryptoError('region-mismatch', 'The comment’s keys aren’t those of its page');
  }
  const { record, signature, payload } = parseWith(SealedComment, sealed.comment, 'Comment');
  if (
    record.installationId !== installationId ||
    record.spaceId !== listed.spaceId ||
    record.subjectId !== listed.commentId
  ) {
    throw new CryptoError('binding-mismatch', 'The comment isn’t the one asked for');
  }
  const author = trust.require(record.authorId, record.authorKeyVersion);
  if (!verifySignature(author, metadataRecordV2Bytes(record), signature)) {
    throw new CryptoError('bad-signature', 'Comment record signature is invalid');
  }
  if (hash(sealedBytes(payload)) !== record.payloadHash) {
    throw new CryptoError('hash-mismatch', 'Comment ciphertext does not match its signed hash');
  }
  const contentKey = wrapped
    ? unwrapContentKey({
        installationId,
        subject: commentWrapSubject({
          spaceId: record.spaceId,
          audience: listed.audience,
          commentId: record.subjectId,
          versionId: record.metadataRevisionId,
        }),
        wrap: sealed.wrap,
        keyring,
        commitment: record.keyCommitment,
      })
    : openAnyEnvelope(sealed.envelopes, (raw) => {
        const envelope = parseWith(MetadataEnvelopeV2, raw, 'Comment envelope');
        checkEnvelopeV2({
          reader,
          trust,
          owners,
          envelope,
          namesThisVersion: envelope.metadataRevisionId === record.metadataRevisionId,
          signedBytes: () => metadataEnvelopeV2Bytes(record, envelope),
        });
        return unsealCommitted(reader, envelope.sealedKey, record.keyCommitment);
      });
  try {
    const plaintext = aeadDecrypt({ key: contentKey, sealed: payload, ad: metadataAd(record) });
    const read = readPayload(plaintext);
    if (read.kind === 'newer-format') {
      return {
        opened: { kind: 'newer-format', record, format: read.format, region: own },
        contentKey,
      };
    }
    const mismatched = [
      read.payload.pageId !== listed.pageId && 'page',
      read.payload.thread !== listed.thread && 'thread',
      read.payload.audience !== listed.audience && 'audience',
    ].filter(Boolean);
    if (mismatched.length > 0) {
      throw new CryptoError(
        'binding-mismatch',
        `The comment says another ${mismatched.join(', ')} than the server lists`,
      );
    }
    return {
      opened: { kind: 'current', record, payload: read.payload, region: own },
      contentKey,
    };
  } catch (error) {
    sodium.memzero(contentKey);
    throw error;
  }
}

// A payload as a reader parses it: strictly as JSON, with well-formed
// strings, then by its format.
function readPayload(
  plaintext: Uint8Array,
):
  | { kind: 'current'; payload: CommentPayload }
  | { kind: 'newer-format'; format: z.infer<typeof Format> } {
  const json = parseJson(z.unknown(), plaintext, 'Comment');
  const format = z.object({ format: Format }).safeParse(json);
  if (!format.success) {
    throw new CryptoError('malformed', 'Comment has no format version', { cause: format.error });
  }
  if (format.data.format.major > COMMENT_FORMAT.major) {
    return { kind: 'newer-format', format: format.data.format };
  }
  return { kind: 'current', payload: keepParsed(CommentPayload, json, 'Comment') };
}
