// A copy or move between spaces as an app makes one (protocol section 10),
// reduced to what the server checks: each source node's current name, or
// draft and published version, sealed again for a new node, with every
// attachment sealed again. No links are worked out and no preview is shown;
// tests of the server send, break and finish copies with it step by step.
import {
  FolderId as FolderIdSchema,
  LINKS_NAMESPACE,
  MetadataRevisionId,
  newId,
  PageId as PageIdSchema,
  pageOperations as pages,
  resealAttachment,
  revisePayload,
  RevisionId as RevisionIdSchema,
  sealMetadataV2,
  sealRevisionV2,
  spaceKeys,
  spaceOperations,
  writeKeyVersion,
  type ClientContext,
  type FolderId,
  type KeyTarget,
  type PagePayload,
  type RevisionId,
  type SpaceId,
} from '@wikistow/client';
import { copyRoutes, structureRoutes } from '@wikistow/contracts';
import type { z } from 'zod';

type Entry = z.input<typeof copyRoutes.CopiedRecords>;
type Listed = Awaited<ReturnType<typeof listed>>;

const listed = async (ctx: ClientContext, spaceId: SpaceId) =>
  ctx.api.call(structureRoutes.tree, { params: { spaceId } });

/** Where a new node under `parentId` writes its keys, as the server's tree places it. */
async function keyTarget(
  ctx: ClientContext,
  spaceId: SpaceId,
  parentId: FolderId | null,
): Promise<KeyTarget> {
  const target = await ctx.api.call(structureRoutes.target, {
    params: { spaceId },
    query: parentId === null ? {} : { nodeId: parentId },
  });
  const keys = await spaceKeys(ctx, spaceId, { refresh: true });
  if (!target.share) return { recipients: keys.owners.sealingOwners() };
  return {
    share: writeKeyVersion({
      keyring: ctx.keyring,
      marks: ctx.marks,
      spaceId,
      shareId: target.share.shareId,
      writes: keys.owners.writes,
      currentKeyVersion: target.share.currentKeyVersion,
    }),
  };
}

/** The source subtree as the person's tree lists it, top first, each parent before its children. */
function subtree(tree: Listed, nodeId: string) {
  const all = [
    ...tree.folders.map((f) => ({ ...f, kind: 'folder' as const })),
    ...tree.pages.map((p) => ({ ...p, kind: 'page' as const })),
  ];
  const top = all.find((node) => node.id === nodeId);
  if (!top) throw new Error(`no node ${nodeId} in the tree`);
  const out = [top];
  for (let i = 0; i < out.length; i++) {
    const at = out[i]?.id;
    out.push(...all.filter((node) => node.parentId === at && node.id !== nodeId));
  }
  return out;
}

/**
 * Open a copy of `nodeId` in `from` under `parentId` in `to` (`kind`
 * `move` for a move), as the person's tree has it now. `send` seals and
 * sends the named source nodes' records (all by default), `finish` and
 * `cancel` end it, and `newIdOf` names each source node's copy.
 */
export async function openCopy(
  ctx: ClientContext,
  {
    kind = 'copy',
    from,
    nodeId,
    to,
    parentId,
    published = true,
  }: {
    kind?: 'copy' | 'move';
    from: SpaceId;
    nodeId: string;
    to: SpaceId;
    parentId: FolderId | null;
    /** Whether published versions come along. */
    published?: boolean;
  },
) {
  const tree = await listed(ctx, from);
  const nodes = subtree(tree, nodeId);
  const destination = await ctx.api.call(structureRoutes.target, {
    params: { spaceId: to },
    query: parentId === null ? {} : { nodeId: parentId },
  });
  const ids = new Map<string, string>(
    nodes.map((node) => [
      node.id,
      node.kind === 'folder' ? newId(FolderIdSchema) : newId(PageIdSchema),
    ]),
  );
  const newIdOf = (sourceId: string) => {
    const id = ids.get(sourceId);
    if (!id) throw new Error(`${sourceId} isn’t copied`);
    return id;
  };
  const copyId = newId(PageIdSchema) as string;
  const opening = {
    copyId,
    kind,
    bringsPublished: published,
    sourceSpaceId: from,
    sourceNodeId: nodeId,
    sourcePermissionVersion: nodes[0]?.permissionVersion ?? 0,
    destinationSpaceId: to,
    parentId,
    permissionVersion: destination.permissionVersion,
    nodes: nodes.map((node) => ({
      nodeId: newIdOf(node.id),
      sourceId: node.id,
      kind: node.kind,
      parentId: node.id === nodeId ? parentId : newIdOf(node.parentId ?? ''),
    })),
  };

  /**
   * Seal one source node's records again for its copy, from the source as
   * it is now; its published version when the copy brings them, or
   * `withPublished` says so. A folder's name is a first version unless
   * `nameBasedOn` says it is based on another.
   */
  async function seal(
    sourceId: string,
    {
      withPublished = published,
      nameBasedOn = null,
    }: { withPublished?: boolean; nameBasedOn?: MetadataRevisionId | null } = {},
  ): Promise<Entry> {
    const node = nodes.find((n) => n.id === sourceId);
    if (!node) throw new Error(`${sourceId} isn’t copied`);
    const target = await keyTarget(ctx, to, parentId);
    if (node.kind === 'folder') {
      const structure = await spaceOperations.loadStructure(ctx, from);
      const name = structure.folders.find((f) => f.id === sourceId)?.metadata;
      if (name?.opened.kind !== 'current') throw new Error('expected a folder name');
      const { metadata, envelopes, wrap } = sealMetadataV2({
        author: ctx.identity,
        target: {
          installationId: ctx.installationId,
          spaceId: to,
          subjectKind: 'folder',
          subjectId: newIdOf(sourceId),
          metadataRevisionId: newId(MetadataRevisionId),
          basedOn: nameBasedOn,
        },
        metadata: name.opened.metadata,
        ...target,
      });
      return {
        kind: 'folder',
        nodeId: newIdOf(sourceId),
        metadata,
        envelopes,
        wrap,
        sourceMetadataRevisionId: name.head,
      };
    }
    const source = { spaceId: from, pageId: PageIdSchema.parse(sourceId) };
    const page = { spaceId: to, pageId: PageIdSchema.parse(newIdOf(sourceId)) };
    const info = await pages.loadPage(ctx, source.pageId);
    const version = async (
      audience: 'draft' | 'published',
      revisionId: RevisionId,
      from: 'draft' | 'published' = audience,
      basedOn: RevisionId | null = null,
    ) => {
      const opened = await pages.openRevisionOf(ctx, source, from, revisionId, {
        fresh: true,
      });
      const payload: PagePayload = revisePayload(opened.opened, {});
      const attachments = [];
      for (const ref of payload.attachments) {
        const resealed = resealAttachment({
          from: pages.attachmentTarget(ctx, source, from),
          to: pages.attachmentTarget(ctx, page, audience),
          ref,
          blob: await pages.downloadBlob(ctx, ref.blobHash),
        });
        await pages.uploadBlob(ctx, page, audience, resealed.blob);
        attachments.push(resealed.ref);
      }
      const {
        [LINKS_NAMESPACE]: _links,
        'wikistow.publication': _source,
        ...extensions
      } = payload.extensions;
      const sealed = sealRevisionV2({
        author: ctx.identity,
        target: {
          installationId: ctx.installationId,
          ...page,
          revisionId: newId(RevisionIdSchema),
          audience,
          basedOn,
        },
        payload: { ...payload, attachments, extensions },
        ...target,
      });
      return {
        ...sealed,
        blobRefs: attachments.map((ref) => ref.blobHash),
        sourceRevisionId: revisionId,
      };
    };
    // The copy's publication names its draft when the source's was made
    // from its current draft, or it had none.
    const baseOf = async (draft: { revision: { record: { revisionId: RevisionId } } }) => {
      if (!publishedHead) return null;
      if (!draftHead) return draft.revision.record.revisionId;
      const opened = await pages.openRevisionOf(ctx, source, 'published', publishedHead);
      return opened.record.basedOn === draftHead ? draft.revision.record.revisionId : null;
    };
    // A page with no draft gets its publication as its draft too.
    const { draftHead, publishedHead } = info.heads;
    const draft = draftHead
      ? await version('draft', draftHead)
      : publishedHead && (await version('draft', publishedHead, 'published'));
    if (!draft) throw new Error('expected a version');
    return {
      kind: 'page',
      nodeId: page.pageId,
      draft,
      published:
        withPublished && publishedHead
          ? await version('published', publishedHead, 'published', await baseOf(draft))
          : null,
    };
  }

  const params = { copyId };
  return {
    copyId,
    opening,
    newIdOf,
    sourceIds: nodes.map((node) => node.id),
    seal,
    open: () => ctx.api.call(copyRoutes.open, { body: opening }),
    /** Seal and send the records of `sourceIds`, every node by default, one request each `batch`. */
    async send(sourceIds = nodes.map((node) => node.id), batch = 50) {
      for (let i = 0; i < sourceIds.length; i += batch) {
        const entries = [];
        for (const id of sourceIds.slice(i, i + batch)) entries.push(await seal(id));
        await ctx.api.call(copyRoutes.records, { params, body: { nodes: entries } });
      }
    },
    finish: () => ctx.api.call(copyRoutes.finish, { params }),
    cancel: () => ctx.api.call(copyRoutes.cancel, { params }),
  };
}

/** Open, send every node, and finish a copy (`openCopy`). */
export async function copyAll(ctx: ClientContext, options: Parameters<typeof openCopy>[1]) {
  const copy = await openCopy(ctx, options);
  await copy.open();
  await copy.send();
  await copy.finish();
  return copy;
}
