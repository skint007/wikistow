import {
  contactsRoutes,
  groupRoutes,
  ownerRoutes,
  PageId,
  pageRoutes,
  peopleRoutes,
  publicationRoutes,
  sharingRoutes,
  structureRoutes,
  vaultRoutes,
  type ErrorCode,
} from '@wikistow/contracts';
import {
  ContentError,
  CryptoError,
  createFolder,
  createPage,
  deleteNode,
  downloadBlob,
  fetchRevisions,
  pageHistory,
  pageInfo,
  publish,
  publicationOf,
  publicationsOf,
  openPublication,
  sendPublication,
  detachPublication,
  endPublication,
  saveDraft,
  unpublish,
  uploadBlob,
  createSpace,
  createVault,
  addMember,
  addOwner,
  checkShareOwner,
  checkSpaceOwner,
  addStatement,
  directory,
  directoryAvatars,
  listOwners,
  listShares,
  listPeople,
  lookupPerson,
  makeShare,
  checkMover,
  moveNode,
  removeOwner,
  addGroupAgent,
  addGroupMember,
  checkGroupOwner,
  createGroup,
  deleteGroup,
  giveAccess,
  listGroups,
  listWaiting,
  removeDirectGrant,
  removeFromSpace,
  removeGroupMember,
  removeShareGroup,
  renameGroup,
  setShareGroup,
  rotateShare,
  scanRecords,
  sharedWithMe,
  versionEnvelopes,
  listSpaces,
  readSpaceOrder,
  saveSpaceOrder,
  listStatements,
  myEnvelopes,
  readContacts,
  writeContacts,
  loadTree,
  lookupIdentities,
  readVault,
  replaceVaultPassphrase,
  updateMetadata,
  writeTarget,
  DEFAULT_CONTENT_LIMITS,
  type BlobStore,
  type ContentFailure,
  type Database,
  type ReportUnreadable,
} from '@wikistow/server';
import type { Config } from '../config.ts';
import { ApiError } from '../http/errors.ts';
import type { Log } from '../http/logger.ts';
import type { EarlyCaller, Routes } from '../http/mount.ts';

const CONTENT_ERRORS = {
  'not-found': 'not-found',
  forbidden: 'forbidden',
  'vault-missing': 'vault-missing',
  'vault-exists': 'vault-exists',
  'vault-immutable-field': 'vault-immutable-field',
  'stale-vault-version': 'stale-vault-version',
  'invalid-vault': 'invalid-request',
  'binding-mismatch': 'binding-mismatch',
  'bad-signature': 'bad-signature',
  'recipients-mismatch': 'recipients-mismatch',
  'stale-head': 'stale-head',
  'enrollment-state': 'enrollment-state',
  'permission-version': 'permission-version',
  duplicate: 'duplicate',
  'missing-blob': 'missing-blob',
  'blob-label-mismatch': 'blob-label-mismatch',
  'too-large': 'payload-too-large',
  'storage-full': 'storage-full',
  busy: 'rate-limited',
  'contacts-invalid': 'contacts-invalid',
  'region-mismatch': 'region-mismatch',
  'key-version': 'key-version',
  'share-nesting': 'share-nesting',
  'too-deep': 'too-deep',
  'space-limit': 'space-limit',
  'folder-limit': 'folder-limit',
  'page-limit': 'page-limit',
  'draft-limit': 'draft-limit',
  'last-owner': 'last-owner',
  'invalid-plugin': 'invalid-request',
} as const satisfies Record<ContentFailure, ErrorCode>;

export function toApiError(error: unknown): never {
  if (error instanceof ContentError) {
    throw new ApiError(CONTENT_ERRORS[error.code], error.message, undefined, error.detail);
  }
  // Bytes that don't decode, found while checking a signature or hash.
  if (error instanceof CryptoError && error.code === 'malformed')
    throw new ApiError('invalid-request', 'Malformed encoded data');
  throw error;
}

// Room to attach as many files as a version may list and publish them all,
// which uploads each changed one again, within one window. The storage quota,
// not this, is what keeps a disk from filling.
const UPLOAD_LIMIT = { windowSeconds: 60, max: 2 * pageRoutes.MAX_ATTACHMENTS };
// Autosave writes about once a second while someone types.
const WRITE_LIMIT = { windowSeconds: 60, max: 120 };
// A page full of images, opened a few times a minute.
const DOWNLOAD_LIMIT = { windowSeconds: 60, max: 600 };
// Opening pages and loading the tree. Each answer carries at most a couple of
// megabytes, so this also bounds how much one account can pull a minute.
const FETCH_LIMIT = { windowSeconds: 60, max: 120 };
// Finding people by exact email, or listing them for a sharing dialog:
// enough to share with a household in a sitting.
const LOOKUP_LIMIT = { windowSeconds: 600, max: 30 };
// Making a share carries a key wrap for every record in it, and adding a
// co-owner an envelope for every owner-region record: a space share of a
// family library is a few megabytes (see the benchmark).
const BULK_BODY = 64 * 1024 * 1024;
// A rotation carries one envelope for each member and owner; an owner's
// removal, one rotation for each share in the space.
const ROTATION_BODY = 4 * 1024 * 1024;
// A move that changes no keys: the destination and a few versions.
const MOVE_BODY = 16 * 1024;
const OWNER_REMOVAL_BODY = 16 * 1024 * 1024;

export function mountContentRoutes(
  routes: Routes,
  {
    db,
    blobs,
    limits,
    contentLimits = DEFAULT_CONTENT_LIMITS,
    minKdf,
    log,
  }: {
    db: Database;
    blobs: BlobStore;
    limits: Config['limits'];
    contentLimits: Config['contentLimits'];
    minKdf: Config['minKdf'];
    log: Log;
  },
): void {
  // Owner actions with a large body check ownership before it is read.
  const spaceOwnerFirst = (params: Record<string, string>, { accountId }: EarlyCaller) =>
    checkSpaceOwner(db, accountId, params['spaceId'] ?? '').catch(toApiError);
  const shareOwnerFirst = (params: Record<string, string>, { accountId }: EarlyCaller) =>
    checkShareOwner(db, accountId, params['shareId'] ?? '').catch(toApiError);
  const groupOwnerFirst = (params: Record<string, string>, { accountId }: EarlyCaller) =>
    checkGroupOwner(db, accountId, params['groupId'] ?? '').catch(toApiError);

  // A stored row a listing left out: named by table and ID, never content.
  const report: ReportUnreadable = ({ table, id }) =>
    log({ level: 'warn', event: 'unreadable-row', table, rowId: id });

  routes.account(
    vaultRoutes.createVault,
    async ({ body }, { principal }) =>
      createVault(db, { accountId: principal.accountId, minKdf, ...body }).catch(toApiError),
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(vaultRoutes.getVault, async (_input, { principal }) =>
    readVault(db, principal.accountId).catch(toApiError),
  );

  routes.account(
    vaultRoutes.replaceVault,
    async ({ body }, { principal }) =>
      replaceVaultPassphrase(db, { accountId: principal.accountId, minKdf, ...body }).catch(
        toApiError,
      ),
    { recentAuth: true, rateLimit: WRITE_LIMIT },
  );

  // An agent reads its person's record, which is sealed to it (section 8.1).
  routes.content(contactsRoutes.getContacts, async ({ query }, { actor }) =>
    readContacts(db, { accountId: actor.accountId, after: query.after }, report).catch(toApiError),
  );

  routes.account(
    contactsRoutes.putContacts,
    async ({ body }, { principal }) =>
      writeContacts(db, {
        accountId: principal.accountId,
        storageBytes: limits.storageBytes,
        ...body,
      }).catch(toApiError),
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(vaultRoutes.lookupIdentities, async ({ query }) => ({
    identities: await lookupIdentities(db, query.ids),
  }));

  routes.content(structureRoutes.listSpaces, async (_input, { actor }) => ({
    spaces: await listSpaces(db, actor, report).catch(toApiError),
  }));

  routes.account(structureRoutes.spaceOrder, async (_input, { principal }) =>
    readSpaceOrder(db, principal.accountId).catch(toApiError),
  );

  routes.account(structureRoutes.setSpaceOrder, async ({ body }, { principal }) => ({
    spaceIds: await saveSpaceOrder(db, principal.accountId, body.spaceIds).catch(toApiError),
  }));

  routes.account(
    structureRoutes.createSpace,
    async ({ body }, { principal }) => {
      await createSpace(db, {
        maxSpaces: contentLimits.spaces,
        accountId: principal.accountId,
        storageBytes: limits.storageBytes,
        ...body,
      }).catch(toApiError);
      return { spaceId: body.spaceId };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.content(structureRoutes.tree, async ({ params }, { actor }) =>
    loadTree(db, actor, params.spaceId, report).catch(toApiError),
  );

  routes.content(structureRoutes.target, async ({ params, query }, { actor }) =>
    writeTarget(db, { actor, spaceId: params.spaceId, nodeId: query.nodeId ?? null }, report).catch(
      toApiError,
    ),
  );

  routes.account(ownerRoutes.owners, async ({ params }, { principal }) =>
    listOwners(db, principal.accountId, params.spaceId, report).catch(toApiError),
  );

  routes.account(ownerRoutes.statements, async ({ params }, { principal }) => ({
    statements: await listStatements(db, principal.accountId, params.spaceId, report).catch(
      toApiError,
    ),
  }));

  routes.content(sharingRoutes.myEnvelopes, async ({ params }, { actor }) => ({
    envelopes: await myEnvelopes(db, actor, params.spaceId, report).catch(toApiError),
  }));

  routes.account(sharingRoutes.listShares, async ({ params }, { principal }) => ({
    shares: await listShares(db, principal.accountId, params.spaceId).catch(toApiError),
  }));

  routes.account(
    sharingRoutes.records,
    async ({ params, query }, { principal }) =>
      scanRecords(
        db,
        principal.accountId,
        {
          spaceId: params.spaceId,
          scope: query.scope,
          rootId: query.rootId ?? null,
          after: query.after ?? null,
        },
        report,
      ).catch(toApiError),
    { rateLimit: FETCH_LIMIT },
  );

  routes.account(
    sharingRoutes.makeShare,
    async ({ params, body }, { principal }) => {
      await makeShare(db, {
        accountId: principal.accountId,
        spaceId: params.spaceId,
        ...body,
      }).catch(toApiError);
      return { shareId: body.shareId };
    },
    { rateLimit: WRITE_LIMIT, bodyLimit: BULK_BODY, beforeBody: spaceOwnerFirst },
  );

  // Editors move within their share too, and their agents (section 9.5),
  // so the early check is theirs. Their moves carry no keys, only a few
  // IDs, so their body is small.
  const moverFirst = async (
    params: Record<string, string>,
    { accountId, agentId = null }: EarlyCaller,
  ) => {
    const { owner } = await checkMover(
      db,
      { accountId, agentId },
      { spaceId: params['spaceId'] ?? '', nodeId: params['nodeId'] ?? '' },
    ).catch(toApiError);
    return owner ? undefined : MOVE_BODY;
  };

  routes.content(
    sharingRoutes.move,
    async ({ params, body }, { actor }) => {
      await moveNode(db, { actor, ...params, ...body }, report).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT, bodyLimit: BULK_BODY, beforeBody: moverFirst },
  );

  routes.account(
    sharingRoutes.addMember,
    async ({ params, body }, { principal }) => {
      await addMember(db, {
        accountId: principal.accountId,
        shareId: params.shareId,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    sharingRoutes.rotate,
    async ({ params, body }, { principal }) => ({
      keyVersion: await rotateShare(db, {
        accountId: principal.accountId,
        shareId: params.shareId,
        ...body,
      }).catch(toApiError),
    }),
    {
      rateLimit: WRITE_LIMIT,
      bodyLimit: ROTATION_BODY,
      bodyPool: 'rotation',
      beforeBody: shareOwnerFirst,
    },
  );

  routes.content(sharingRoutes.versionEnvelopes, async ({ params }, { actor }) => ({
    envelopes: await versionEnvelopes(db, actor, params, report).catch(toApiError),
  }));

  routes.content(sharingRoutes.sharedWithMe, async (_input, { actor }) => ({
    shares: await sharedWithMe(db, actor, report).catch(toApiError),
  }));

  // Groups (section 7.8). Changes that seal to someone in every share a
  // group has, or rotate them, carry as much as an owner's removal.
  routes.account(groupRoutes.listGroups, async ({ params }, { principal }) =>
    listGroups(db, principal.accountId, params.spaceId, report).catch(toApiError),
  );

  routes.account(
    groupRoutes.createGroup,
    async ({ params, body }, { principal }) => {
      await createGroup(db, {
        accountId: principal.accountId,
        spaceId: params.spaceId,
        storageBytes: limits.storageBytes,
        ...body,
      }).catch(toApiError);
      return { groupId: body.groupId };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    groupRoutes.renameGroup,
    async ({ params, body }, { principal }) => {
      await renameGroup(db, {
        accountId: principal.accountId,
        groupId: params.groupId,
        storageBytes: limits.storageBytes,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  const groupChange = {
    rateLimit: WRITE_LIMIT,
    bodyLimit: OWNER_REMOVAL_BODY,
    bodyPool: 'rotation',
    beforeBody: groupOwnerFirst,
  } as const;

  routes.account(
    groupRoutes.deleteGroup,
    async ({ params, body }, { principal }) => {
      await deleteGroup(db, {
        accountId: principal.accountId,
        groupId: params.groupId,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    groupChange,
  );

  routes.account(
    groupRoutes.addGroupMember,
    async ({ params, body }, { principal }) => {
      await addGroupMember(db, {
        accountId: principal.accountId,
        groupId: params.groupId,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    groupChange,
  );

  routes.account(
    groupRoutes.addGroupAgent,
    async ({ params, body }, { principal }) => {
      await addGroupAgent(db, {
        accountId: principal.accountId,
        groupId: params.groupId,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    groupChange,
  );

  routes.account(
    groupRoutes.removeGroupMember,
    async ({ params, body }, { principal }) => {
      await removeGroupMember(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    groupChange,
  );

  const shareChange = {
    rateLimit: WRITE_LIMIT,
    bodyLimit: ROTATION_BODY,
    bodyPool: 'rotation',
    beforeBody: shareOwnerFirst,
  } as const;

  routes.account(
    groupRoutes.setShareGroup,
    async ({ params, body }, { principal }) => {
      await setShareGroup(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    shareChange,
  );

  routes.account(
    groupRoutes.removeShareGroup,
    async ({ params, body }, { principal }) => {
      await removeShareGroup(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    shareChange,
  );

  routes.account(
    groupRoutes.removeDirectGrant,
    async ({ params, body }, { principal }) => {
      await removeDirectGrant(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    shareChange,
  );

  const spaceChange = {
    rateLimit: WRITE_LIMIT,
    bodyLimit: OWNER_REMOVAL_BODY,
    bodyPool: 'rotation',
    beforeBody: spaceOwnerFirst,
  } as const;

  routes.account(
    groupRoutes.removeFromSpace,
    async ({ params, body }, { principal }) => {
      await removeFromSpace(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    spaceChange,
  );

  routes.account(
    groupRoutes.giveAccess,
    async ({ params, body }, { principal }) => {
      await giveAccess(db, {
        accountId: principal.accountId,
        ...params,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    spaceChange,
  );

  routes.account(groupRoutes.waiting, async (_input, { principal }) => ({
    waiting: await listWaiting(db, principal.accountId).catch(toApiError),
  }));

  routes.account(
    ownerRoutes.addStatement,
    async ({ params, body }, { principal }) => {
      await addStatement(db, {
        accountId: principal.accountId,
        spaceId: params.spaceId,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.account(
    ownerRoutes.addOwner,
    async ({ params, body }, { principal }) => {
      await addOwner(db, {
        accountId: principal.accountId,
        spaceId: params.spaceId,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT, bodyLimit: BULK_BODY, beforeBody: spaceOwnerFirst },
  );

  routes.account(
    ownerRoutes.removeOwner,
    async ({ params, body }, { principal }) => {
      await removeOwner(db, {
        accountId: principal.accountId,
        spaceId: params.spaceId,
        identityId: params.identityId,
        ...body,
      }).catch(toApiError);
      return { ok: true as const };
    },
    {
      rateLimit: WRITE_LIMIT,
      bodyLimit: OWNER_REMOVAL_BODY,
      bodyPool: 'rotation',
      beforeBody: spaceOwnerFirst,
    },
  );

  routes.account(
    peopleRoutes.lookupPerson,
    async ({ body }, { principal }) => ({
      person: await lookupPerson(db, principal.accountId, body.email).catch(toApiError),
    }),
    { rateLimit: LOOKUP_LIMIT },
  );

  routes.account(
    peopleRoutes.listPeople,
    async (_input, { principal }) => listPeople(db, principal.accountId).catch(toApiError),
    { rateLimit: LOOKUP_LIMIT },
  );

  routes.content(
    peopleRoutes.directory,
    async ({ query }, { actor }) => directory(db, actor, query.ids).catch(toApiError),
    { rateLimit: FETCH_LIMIT },
  );

  // For the app's lists of people; agents have no use for faces.
  routes.account(
    peopleRoutes.avatars,
    async ({ query }, { principal }) => ({
      avatars: await directoryAvatars(
        db,
        { accountId: principal.accountId, agentId: null },
        query.ids,
      ).catch(toApiError),
    }),
    { rateLimit: FETCH_LIMIT },
  );

  routes.content(
    structureRoutes.createFolder,
    async ({ params, body }, { actor, once }) => {
      await createFolder(db, {
        maxFolders: contentLimits.folders,
        actor,
        spaceId: params.spaceId,
        storageBytes: limits.storageBytes,
        ...body,
        once,
      }).catch(toApiError);
      return { folderId: body.folderId };
    },
    { rateLimit: WRITE_LIMIT, idempotent: true },
  );

  routes.account(
    structureRoutes.updateMetadata,
    async ({ params, body }, { principal }) => {
      await updateMetadata(db, {
        accountId: principal.accountId,
        spaceId: params.spaceId,
        storageBytes: limits.storageBytes,
        ...body,
      }).catch(toApiError);
      return { metadataRevisionId: body.metadata.record.metadataRevisionId };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.content(
    pageRoutes.createPage,
    async ({ params, body }, { actor, once }) => {
      const { revisionId } = await createPage(db, {
        maxPages: contentLimits.pages,
        actor,
        spaceId: params.spaceId,
        storageBytes: limits.storageBytes,
        ...body,
        once,
      }).catch(toApiError);
      return { pageId: body.pageId, revisionId };
    },
    { rateLimit: WRITE_LIMIT, idempotent: true },
  );

  routes.content(pageRoutes.getPage, async ({ params }, { actor }) =>
    pageInfo(db, actor, params.pageId, report).catch(toApiError),
  );

  routes.content(
    pageRoutes.saveDraft,
    async ({ params, body }, { actor, once }) =>
      saveDraft(db, {
        actor,
        pageId: params.pageId,
        storageBytes: limits.storageBytes,
        ...body,
        once,
      }).catch(toApiError),
    { rateLimit: WRITE_LIMIT, idempotent: true },
  );

  routes.content(
    pageRoutes.publish,
    async ({ params, body }, { actor, once }) =>
      publish(db, {
        actor,
        pageId: params.pageId,
        storageBytes: limits.storageBytes,
        ...body,
        once,
      }).catch(toApiError),
    { rateLimit: WRITE_LIMIT, idempotent: true },
  );

  // An agent may unpublish where it may publish (section 9.5).
  routes.content(
    pageRoutes.unpublish,
    async ({ params, body }, { actor }) => {
      await unpublish(db, { actor, pageId: params.pageId, ...body }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  // Only someone who can publish a page publishes it into another space, or
  // ends a publication of it (section 13). Agents do where both their picks
  // and their person allow it at the source and the destination (section
  // 9.5), as they publish anywhere else.
  routes.content(publicationRoutes.lookup, async ({ params }, { actor }) => ({
    publication: await publicationOf(db, actor, {
      sourcePageId: params.pageId,
      spaceId: params.spaceId,
    }).catch(toApiError),
  }));

  routes.content(publicationRoutes.list, async ({ params }, { actor }) => ({
    publications: await publicationsOf(db, actor, params.pageId).catch(toApiError),
  }));

  routes.content(
    publicationRoutes.open,
    async ({ body }, { actor, once }) =>
      openPublication(db, { actor, maxPages: contentLimits.pages, ...body, once }).catch(
        toApiError,
      ),
    { rateLimit: WRITE_LIMIT, idempotent: true },
  );

  routes.content(
    publicationRoutes.send,
    async ({ params, body }, { actor, once }) =>
      sendPublication(db, {
        actor,
        pageId: params.pageId,
        storageBytes: limits.storageBytes,
        ...body,
        once,
      }).catch(toApiError),
    { rateLimit: WRITE_LIMIT, idempotent: true },
  );

  routes.content(
    publicationRoutes.end,
    async ({ params }, { actor }) =>
      endPublication(db, {
        actor,
        sourcePageId: params.pageId,
        spaceId: params.spaceId,
      }).catch(toApiError),
    { rateLimit: WRITE_LIMIT },
  );

  routes.content(
    publicationRoutes.detach,
    async ({ params, body }, { actor, once }) =>
      detachPublication(db, {
        actor,
        pageId: params.pageId,
        storageBytes: limits.storageBytes,
        ...body,
        once,
      }).catch(toApiError),
    { rateLimit: WRITE_LIMIT, idempotent: true },
  );

  routes.content(pageRoutes.history, async ({ params }, { actor }) => ({
    versions: (await pageHistory(db, actor, params.pageId, report).catch(toApiError)).map((v) => ({
      revisionId: v.revisionId,
      publishedSeq: v.publishedSeq ?? 0,
      publishedAt: v.publishedAt.toISOString(),
      basedOn: v.basedOn,
      publisher: {
        identityId: v.publisherIdentityId,
        name: v.publisherName,
        agentName: v.publisherAgentName,
        personId: v.publisherPersonId,
      },
      record: v.record,
      signature: v.signature,
    })),
  }));

  routes.content(
    pageRoutes.fetchRevisions,
    async ({ body }, { actor }) => {
      const { revisions, deferred } = await fetchRevisions(db, actor, body.ids, report).catch(
        toApiError,
      );
      return {
        revisions: revisions.map((r) => ({
          ...r,
          meta: { ...r.meta, createdAt: r.meta.createdAt.toISOString() },
        })),
        deferred,
      };
    },
    { rateLimit: FETCH_LIMIT },
  );

  routes.account(
    pageRoutes.deleteNode,
    async ({ params }, { principal }) => {
      await deleteNode(db, blobs, { accountId: principal.accountId, ...params }).catch(toApiError);
      return { ok: true as const };
    },
    { rateLimit: WRITE_LIMIT },
  );

  routes.binary(
    'PUT',
    pageRoutes.BLOB_UPLOAD_PATH,
    async (c, actor) => {
      const query = pageRoutes.BlobUploadQuery.safeParse(c.req.query());
      const pageId = PageId.safeParse(c.req.param('pageId'));
      if (!query.success || !pageId.success)
        throw new ApiError('invalid-request', 'Invalid upload');
      // The length is reserved against the quota before any byte is stored,
      // so uploads must state it.
      const declaredSize = Number(c.req.header('content-length'));
      if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        throw new ApiError('invalid-request', 'Uploads need a Content-Length');
      }
      const body = c.req.raw.body;
      if (!body) throw new ApiError('invalid-request', 'Upload has no body');
      const stored = await uploadBlob(db, blobs, {
        actor,
        pageId: pageId.data,
        audience: query.data.audience,
        body,
        declaredSize,
        limits,
      }).catch(toApiError);
      return c.json(pageRoutes.BlobUploadResult.parse(stored), 201);
    },
    { rateLimit: UPLOAD_LIMIT },
  );

  routes.binary(
    'GET',
    pageRoutes.BLOB_DOWNLOAD_PATH,
    async (c, actor) => {
      const stored = await downloadBlob(db, blobs, {
        actor,
        hash: c.req.param('hash') ?? '',
      }).catch(toApiError);
      // Streamed as it is read. Encrypted bytes only; still never cached by others.
      return c.body(stored.body, 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(stored.size),
        'cache-control': 'private, no-store',
      });
    },
    { rateLimit: DOWNLOAD_LIMIT },
  );
}
