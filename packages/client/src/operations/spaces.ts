import { structureRoutes, type FolderId, type ShareId, type SpaceId } from '@wikistow/contracts';
import {
  FolderId as FolderIdSchema,
  MetadataRevisionId,
  newId,
  SpaceId as SpaceIdSchema,
} from '../ids.ts';
import {
  newFolderMetadata,
  newSpaceMetadata,
  reviseMetadata,
  sealMetadataV2,
  type FolderLook,
  type MetadataChanges,
} from '../metadata.ts';
import { CryptoError } from '../errors.ts';
import { repairText } from '../json.ts';
import { regionInTree, sameRegion, writeRegion, type Region } from '../regions.ts';
import { pageLabels, type PageLabel } from './pages.ts';
import {
  keyTargetFor,
  newNodeTarget,
  openName,
  treeTarget,
  withFreshKeys,
  type LoadedMetadata,
} from './records.ts';
import type { ClientContext } from './session.ts';

export type { LoadedMetadata };

/**
 * A new space owned by this person. Its name is the space's first name
 * record, the only `basedOn: null` name record an app ever writes, sealed to
 * this person alone: an app accepts itself as an owner by it (section 6.5).
 */
export async function createSpace(
  ctx: ClientContext,
  {
    name,
    emoji,
    kind = 'personal',
  }: { name: string; emoji?: string; kind?: 'personal' | 'shared' },
): Promise<SpaceId> {
  const spaceId = newId(SpaceIdSchema);
  const { metadata, envelopes } = sealMetadataV2({
    author: ctx.identity,
    target: {
      installationId: ctx.installationId,
      spaceId,
      subjectKind: 'space',
      subjectId: spaceId,
      metadataRevisionId: newId(MetadataRevisionId),
      basedOn: null,
    },
    metadata: newSpaceMetadata(name, emoji),
    recipients: [ctx.identity.public],
  });
  await ctx.api.call(structureRoutes.createSpace, { body: { spaceId, kind, metadata, envelopes } });
  return spaceId;
}

/** The result, or null when it fails a cryptographic check. */
async function unlessUnreadable<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof CryptoError) return null;
    throw error;
  }
}

/** The spaces this person can open, with their names decrypted (null if unreadable). */
export async function loadSpaces(ctx: ClientContext) {
  const { spaces } = await ctx.api.call(structureRoutes.listSpaces);
  return Promise.all(
    spaces.map(async (space) => ({
      id: space.id,
      kind: space.kind,
      role: space.role,
      canPublish: space.canPublish,
      permissionVersion: space.permissionVersion,
      // One space that fails its checks mustn't hide the others.
      metadata: await unlessUnreadable(() =>
        openName(ctx, { spaceId: space.id, subjectKind: 'space', subjectId: space.id }, space),
      ),
    })),
  );
}

/** What the tree shows for a page whose version can't be opened: every part of its label missing. */
const UNLABELLED = {
  title: null,
  emoji: null,
  region: null,
} satisfies Record<keyof PageLabel, null>;

// A space's tree as the server lists it, its shares checked to be in the space.
async function listTree(ctx: ClientContext, spaceId: SpaceId) {
  const listed = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
  for (const share of listed.shares) {
    if (share.spaceId !== spaceId) {
      throw new CryptoError('binding-mismatch', `Share ${share.shareId} is in another space`);
    }
  }
  return listed;
}

// The listed tree with the space's and each folder's name opened.
async function openNames(
  ctx: ClientContext,
  spaceId: SpaceId,
  { space, shares, folders, pages, agentActivity }: Awaited<ReturnType<typeof listTree>>,
) {
  return {
    space: space && {
      id: space.id,
      role: space.role,
      canPublish: space.canPublish,
      permissionVersion: space.permissionVersion,
      // A space name that fails its checks mustn't hide the folders in it.
      metadata: await unlessUnreadable(() =>
        openName(ctx, { spaceId, subjectKind: 'space', subjectId: spaceId }, space),
      ),
    },
    shares,
    // One folder that fails its checks mustn't hide the rest of the tree.
    folders: await Promise.all(
      folders.map(async (folder) => ({
        id: folder.id,
        parentId: folder.parentId,
        permissionVersion: folder.permissionVersion,
        metadata: await unlessUnreadable(() =>
          openName(ctx, { spaceId, subjectKind: 'folder', subjectId: folder.id }, folder),
        ),
      })),
    ),
    pages,
    // Server-told, like every name in it: only about a page the tree lists.
    agentActivity:
      agentActivity && pages.some((page) => page.id === agentActivity.pageId)
        ? agentActivity
        : null,
  };
}

/**
 * A space's folders and pages as the server lists them, with the space's
 * and each folder's name decrypted, but no page opened. A space or folder
 * whose name can't be verified or opened has `metadata: null`. Someone who holds only
 * folder shares in the space gets no space (section 7.7): their folders
 * start at each share root.
 */
export async function loadStructure(ctx: ClientContext, spaceId: SpaceId) {
  return openNames(ctx, spaceId, await listTree(ctx, spaceId));
}

/**
 * A space's folders and pages, decrypted (`loadStructure`), each page with
 * the title and emoji of the version this person sees, or null if it can't
 * be opened, and the region that version's key material puts it in, which
 * `writeLinks` goes by rather than the tree.
 */
export async function loadTree(ctx: ClientContext, spaceId: SpaceId) {
  const listed = await listTree(ctx, spaceId);
  // Pages open before names, as they always have: it decides which check fails first.
  const labels = await pageLabels(ctx, spaceId, listed.pages);
  // A version opened before a share or move is remembered in its old region:
  // open again those the tree places elsewhere, and trust what they open in.
  const placed = placing(listed);
  const moved = listed.pages.filter((page) => {
    const [opened, inTree] = [labels.get(page.id)?.region, placed(page.id)];
    return opened && inTree && !sameRegion(opened, inTree);
  });
  if (moved.length > 0) {
    for (const [id, label] of await pageLabels(ctx, spaceId, moved, { fresh: true })) {
      labels.set(id, label);
    }
  }
  const structure = await openNames(ctx, spaceId, listed);
  return {
    ...structure,
    pages: structure.pages.map((page) => ({ ...page, ...(labels.get(page.id) ?? UNLABELLED) })),
  };
}

/** Where the server's tree puts each node (`regionInTree`), or null where it can't say. */
function placing(tree: {
  shares: readonly { spaceId: SpaceId; shareId: ShareId; rootId: string | null }[];
  folders: readonly { id: string; parentId: string | null }[];
  pages: readonly { id: string; parentId: string | null }[];
}): (nodeId: string) => Region | null {
  const parents = new Map<string, string | null>(
    [...tree.folders, ...tree.pages].map((node) => [node.id, node.parentId]),
  );
  return (nodeId) => {
    try {
      return regionInTree({
        subject: { kind: 'node', nodeId },
        parentOf: (id) => parents.get(id),
        shares: tree.shares,
      });
    } catch {
      return null;
    }
  };
}

/**
 * A new folder at the root or inside `parentId`, with `look`, or ⭐ on blue
 * until someone changes it.
 */
export async function createFolder(
  ctx: ClientContext,
  {
    spaceId,
    parentId,
    name,
    look,
  }: { spaceId: SpaceId; parentId: FolderId | null; name: string; look?: FolderLook },
): Promise<FolderId> {
  const folderId = newId(FolderIdSchema);
  await withFreshKeys(ctx, spaceId, async (keys) => {
    const { permissionVersion, share, region } = await newNodeTarget(ctx, spaceId, parentId);
    const { metadata, envelopes, wrap } = sealMetadataV2({
      author: ctx.identity,
      target: {
        installationId: ctx.installationId,
        spaceId,
        subjectKind: 'folder',
        subjectId: folderId,
        metadataRevisionId: newId(MetadataRevisionId),
        basedOn: null,
      },
      metadata: newFolderMetadata(name, look),
      ...keyTargetFor(ctx, keys, region, share),
    });
    await ctx.api.call(structureRoutes.createFolder, {
      params: { spaceId },
      body: { folderId, parentId, permissionVersion, metadata, envelopes, wrap },
    });
  });
  return folderId;
}

/**
 * Rename a space or folder, or change its emoji or tint, in the region of
 * the version the person was looking at (`current`). If someone changed it
 * since, the server answers `stale-head` and nothing is overwritten. A
 * broken character from a Milestone 1 client is written as U+FFFD, and
 * `repaired` says so.
 */
export async function updateMetadata(
  ctx: ClientContext,
  {
    spaceId,
    subject,
    current,
    changes,
  }: {
    spaceId: SpaceId;
    subject: { kind: 'space' } | { kind: 'folder'; folderId: FolderId };
    current: LoadedMetadata;
    changes: MetadataChanges;
  },
): Promise<LoadedMetadata & { repaired: boolean }> {
  const folderId = subject.kind === 'folder' ? subject.folderId : null;
  const { value: next, repaired } = repairText(reviseMetadata(current.opened, changes));
  const region = writeRegion({ kind: 'based-on', basedOn: current.region });
  const metadataRevisionId = await withFreshKeys(ctx, spaceId, async (keys) => {
    const { permissionVersion, share } = await treeTarget(ctx, spaceId, folderId);
    const id = newId(MetadataRevisionId);
    const { metadata, envelopes, wrap } = sealMetadataV2({
      author: ctx.identity,
      target: {
        installationId: ctx.installationId,
        spaceId,
        subjectKind: subject.kind,
        subjectId: folderId ?? spaceId,
        metadataRevisionId: id,
        basedOn: current.head,
      },
      metadata: next,
      ...keyTargetFor(ctx, keys, region, share),
    });
    await ctx.api.call(structureRoutes.updateMetadata, {
      params: { spaceId },
      body: { permissionVersion, metadata, envelopes, wrap },
    });
    return id;
  });
  return {
    head: metadataRevisionId,
    opened: { kind: 'current', metadata: next },
    region,
    repaired,
  };
}
