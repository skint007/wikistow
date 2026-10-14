import { z } from 'zod';
import { FolderId, HumanId, NodeId, PageId, RevisionId, SpaceId } from '../records/ids.ts';
import {
  KeyEnvelope,
  KeyEnvelopeV2,
  RevisionRecord,
  RevisionRecordV2,
  SealedRevision,
  SealedRevisionV2,
} from '../records/revision.ts';
import { KeyWrap } from '../records/share.ts';
import type { RouteDef } from '../route.ts';
import { AccessRole, AgentEdit } from './structure.ts';

const BlobHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** The most attachment blobs one version may list. */
export const MAX_ATTACHMENTS = 200;

/**
 * UTF-8 bytes of Markdown one version of a page may hold, frontmatter
 * included. Reading Markdown takes longer than its size suggests (#47):
 * past this, a long but ordinary page takes seconds to read each time it
 * is shown or exported. Versions saved before the limit still open.
 */
export const MAX_MARKDOWN_BYTES = 256 * 1024;

/**
 * UTF-8 bytes of a version's whole payload as encrypted: its Markdown as
 * JSON writes it (a line break takes two bytes), title, attachment list and
 * extensions such as the link table. Twice the Markdown's limit leaves room
 * for that on most pages within it; one linking to thousands of pages, its
 * link table some 60 bytes an entry, can reach this first, and is told so.
 */
export const MAX_PAYLOAD_BYTES = 2 * MAX_MARKDOWN_BYTES;

/**
 * Characters of a version's payload ciphertext, the most the server takes:
 * `MAX_PAYLOAD_BYTES` and the 16-byte AEAD tag, as unpadded base64url. The
 * server can't read the Markdown, but it can count this.
 */
export const MAX_PAYLOAD_CIPHERTEXT = Math.ceil(((MAX_PAYLOAD_BYTES + 16) * 4) / 3);

/**
 * A new version and everything the server checks it against. Its content
 * key goes with it: in a share, one key wrap under the share's current key
 * version; otherwise, envelopes to every owner (protocol section 6.8).
 */
export const Commit = {
  revision: SealedRevisionV2,
  envelopes: z.array(KeyEnvelopeV2).max(100),
  wrap: KeyWrap.nullable(),
  blobRefs: z.array(BlobHash).max(MAX_ATTACHMENTS),
  permissionVersion: z.number().int(),
};

export const CommitResult = z.strictObject({ revisionId: RevisionId, replayed: z.boolean() });

const PageParams = z.object({ pageId: PageId });

export const PageInfo = z.strictObject({
  pageId: PageId,
  spaceId: SpaceId,
  parentId: FolderId.nullable(),
  permissionVersion: z.number().int(),
  role: AccessRole,
  canPublish: z.boolean(),
  heads: z.strictObject({
    /** Null for readers. */
    draftHead: RevisionId.nullable(),
    publishedHead: RevisionId.nullable(),
    publishedCount: z.number().int(),
    /** The draft differs from the latest published version (always false for readers). */
    draftChanges: z.boolean(),
  }),
  /**
   * The latest draft an agent saved since the latest publication, or null
   * (always null for readers).
   */
  agentEdit: AgentEdit.nullable(),
  /**
   * For editors, the oldest published version readers see now, by its
   * number: they see only what was published since the page was last
   * unpublished. Null for readers, and while the page isn't published.
   */
  readerHistoryFrom: z.number().int().nullable(),
});

export const createPage = {
  method: 'POST',
  path: '/api/spaces/:spaceId/pages',
  params: z.object({ spaceId: SpaceId }),
  body: z.object({ pageId: PageId, parentId: FolderId.nullable(), ...Commit }),
  response: z.strictObject({ pageId: PageId, revisionId: RevisionId }),
  status: 201,
} as const satisfies RouteDef;

export const getPage = {
  method: 'GET',
  path: '/api/pages/:pageId',
  params: PageParams,
  response: PageInfo,
} as const satisfies RouteDef;

/** A new draft based on the current one (`revision.record.basedOn`). */
export const saveDraft = {
  method: 'POST',
  path: '/api/pages/:pageId/drafts',
  params: PageParams,
  body: z.object({ ...Commit, restoredFrom: RevisionId.nullable().default(null) }),
  response: CommitResult,
} as const satisfies RouteDef;

/** Publish the exact current draft (`revision.record.basedOn`). */
export const publish = {
  method: 'POST',
  path: '/api/pages/:pageId/publications',
  params: PageParams,
  body: z.object({ ...Commit, expectedPublishedHead: RevisionId.nullable() }),
  response: CommitResult,
} as const satisfies RouteDef;

/**
 * Hide the page from readers (protocol section 11), for someone who can
 * publish there: its published head, if it is still `expectedPublishedHead`
 * (`stale-head` otherwise) and the page's permission version is still
 * `permissionVersion` (`permission-version`), becomes none. Asked again
 * once that is done, as after a lost answer, it is no error. Readers then get `not-found` for
 * the page and all of its history. No keys change, and editors keep the
 * whole history. The next publish starts a new reader history.
 */
export const unpublish = {
  method: 'POST',
  path: '/api/pages/:pageId/unpublish',
  params: PageParams,
  body: z.object({ expectedPublishedHead: RevisionId, permissionVersion: z.number().int() }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Published versions, newest first: for readers, only the current reader
 * history, those published since the page was last unpublished, numbered
 * from 1 there (as `fetchRevisions` numbers them for readers too). Each
 * carries its signed record, so the client can check who published it
 * without fetching its content.
 */
export const history = {
  method: 'GET',
  path: '/api/pages/:pageId/history',
  params: PageParams,
  response: z.strictObject({
    versions: z.array(
      z.strictObject({
        revisionId: RevisionId,
        publishedSeq: z.number().int(),
        publishedAt: z.iso.datetime(),
        basedOn: RevisionId.nullable(),
        /**
         * Who published it: a person, or an agent and the person it acts for
         * (`name`), with the name that person gave it (`agentName`).
         */
        publisher: z.strictObject({
          identityId: z.string(),
          name: z.string().nullable(),
          agentName: z.string().nullable(),
          /** For an agent's version: the person it published for, as the server has it. */
          personId: HumanId.nullable(),
        }),
        record: z.union([RevisionRecord, RevisionRecordV2]),
        signature: SealedRevision.shape.signature,
      }),
    ),
  }),
} as const satisfies RouteDef;

/**
 * Revisions by ID, each with its key wrap or the caller's own envelopes for
 * it. Ones the caller can't read are left out. To keep answers small,
 * readable ones that didn't fit are listed in `deferred`; ask for those
 * again.
 */
export const fetchRevisions = {
  method: 'POST',
  path: '/api/revisions/batch',
  body: z.object({ ids: z.array(RevisionId).max(200) }),
  response: z.strictObject({
    deferred: z.array(RevisionId),
    revisions: z.array(
      z.strictObject({
        revision: z.union([SealedRevision, SealedRevisionV2]),
        wrap: KeyWrap.nullable(),
        envelopes: z.array(z.union([KeyEnvelope, KeyEnvelopeV2])),
        meta: z.strictObject({
          createdAt: z.iso.datetime(),
          draftSeq: z.number().int().nullable(),
          publishedSeq: z.number().int().nullable(),
          restoredFrom: RevisionId.nullable(),
        }),
      }),
    ),
  }),
} as const satisfies RouteDef;

/** Delete a folder or page and everything beneath it (space owners). */
export const deleteNode = {
  method: 'DELETE',
  path: '/api/spaces/:spaceId/nodes/:nodeId',
  params: z.object({ spaceId: SpaceId, nodeId: NodeId }),
  response: z.strictObject({ ok: z.literal(true) }),
} as const satisfies RouteDef;

/**
 * Blob bytes aren't JSON, so these two are described here but registered
 * as binary routes: PUT `/api/pages/:pageId/blobs?audience=draft|published`
 * with the encrypted bytes, and GET `/api/blobs/:hash` for them back.
 */
export const BLOB_UPLOAD_PATH = '/api/pages/:pageId/blobs';
export const BLOB_DOWNLOAD_PATH = '/api/blobs/:hash';
export const BlobUploadQuery = z.object({ audience: z.enum(['draft', 'published']) });
export const BlobUploadResult = z.strictObject({ hash: BlobHash, size: z.number().int() });
