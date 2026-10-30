// Copying a page or folder, with everything under it, under a folder of any
// space, and moving one into another space, which is a copy that deletes its
// source (protocol section 10, "Copies, and moves between spaces"; ADR 0007).
//
// `previewCopy` works out what the person confirms, sealing nothing. Then
// `makeCopy` opens the copy, whose new nodes the server keeps hidden; seals
// each source node's current name, or draft and publication, again as a new
// node's first version in the destination's region, with every attachment
// sealed again; sends them a batch at a time; and finishes. A source head
// that moved on meanwhile is sealed again and sent, and the finish tried
// again; anything else ends the copy, and the person starts again from a
// new preview.
import {
  copyRoutes,
  MetadataRevisionId,
  publicationRoutes,
  type FolderId,
  type IdentityId,
  type PageId,
  type RevisionId,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { FolderId as FolderIdSchema, newId, PageId as PageIdSchema } from '../ids.ts';
import { repairText } from '../json.ts';
import {
  LINKS_NAMESPACE,
  LinkTable,
  linkTableOf,
  writeLinks,
  type LinkTree,
  type LinkWrite,
  type OpenedPublication,
} from '../link-table.ts';
import { findLinks, foldTitle, rewritePageLinks, type FoundLinks } from '../links.ts';
import { sealMetadataV2 } from '../metadata.ts';
import { revisePayload, type AttachmentRef, type PagePayload } from '../payload.ts';
import { sameRegion, type Region } from '../regions.ts';
import { resealAttachment } from '../revision.ts';
import { spaceKeys, type SpaceKeys } from './keys.ts';
import { audienceOf, type AccessChange, type Reach } from './moves.ts';
import {
  attachmentTarget,
  commitFor,
  downloadBlob,
  loadPage,
  openRevisionOf,
  publicationsFor,
  uploadBlob,
  type OpenedRevision,
} from './pages.ts';
import { PUBLICATION_NAMESPACE, type ClosedLink } from './publications.ts';
import { keyTargetFor, newNodeTarget, treeTarget } from './records.ts';
import type { ClientContext } from './session.ts';
import { list as listPublicLinks } from './public-links.ts';
import { listShares } from './sharing.ts';
import { loadTree } from './spaces.ts';

type Tree = Awaited<ReturnType<typeof loadTree>>;
type TreePage = Tree['pages'][number];
type TreeFolder = Tree['folders'][number];
type Entry = z.input<typeof copyRoutes.CopiedRecords>;

/** One node of what is copied, and the new node that copies it. */
export type CopiedNode = {
  sourceId: string;
  /** The new node's ID, made now; it is hidden until the copy finishes. */
  nodeId: FolderId | PageId;
  kind: 'folder' | 'page';
  /** The new node's parent: the copy of the source's parent, or the destination folder. */
  parentId: FolderId | null;
  /** The source's name or title as this app opened it; null where it couldn't. */
  name: string | null;
};

/**
 * Who reads and edits at the destination. An owner of the destination
 * space verifies who holds its keys, as for a move between regions, so it is
 * at least these people (`verified`, A10). Anyone else is shown only the
 * folder and its share, if any (`unlisted`): they write there already. An
 * agent's copy has no preview (`null`).
 */
export type CopyAudience =
  | { kind: 'verified'; region: Region; people: { identityId: IdentityId; reach: Reach }[] }
  | { kind: 'unlisted'; region: Region; shareId: ShareId | null }
  | null;

/** What a move ends, besides every earlier version of what it moves. */
export type MoveEnds = {
  /** Shares rooted in what moves, and their members, who lose them. */
  shares: { shareId: ShareId; rootId: string; members: IdentityId[] }[];
  /** Agents picked for a folder in what moves, by the names the server lists. */
  agentPicks: { agentId: IdentityId; personId: IdentityId; name: string }[];
  /** Pages whose public link ends. */
  publicLinks: PageId[];
  /** Pages and the other spaces they are published into, which those publications end in. */
  publications: { pageId: PageId; spaceId: SpaceId }[];
};

/** A copy or move worked out for the person to confirm. Nothing is sealed or sent yet. */
export type CopyPreview = {
  kind: 'copy' | 'move';
  copyId: string;
  source: {
    spaceId: SpaceId;
    nodeId: FolderId | PageId;
    kind: 'folder' | 'page';
    permissionVersion: number;
  };
  destination: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    permissionVersion: number;
    region: Region;
  };
  /** Whether published versions come along: only where the person can publish. */
  bringsPublished: boolean;
  /** Top first, every parent before its children. */
  nodes: CopiedNode[];
  audience: CopyAudience;
  /** For a move, who loses access, by what the source's regions give them. */
  losses: AccessChange[];
  /** Pages published now that arrive with their draft alone, by source ID. */
  unpublished: { pageId: PageId; title: string | null }[];
  /**
   * Pages a copied version links to that won't be the same page afterwards:
   * in a copy into another space, wikilinks to pages of the source space
   * that don't come along. Null when some Markdown couldn't be read for links.
   */
  links: ClosedLink[] | null;
  /** For a move, pages staying behind, that this person can open, which link to what moves. */
  inbound: { pageId: PageId; title: string | null }[];
  /** For a move, what it ends. */
  ends: MoveEnds | null;
};

/** How far `makeCopy` has got: nodes sealed and sent, of `total`. */
export type CopyProgress = { stage: 'sending' | 'finishing'; sent: number; total: number };

type ReadLinks = (markdown: string) => Promise<FoundLinks>;

/**
 * The listed subtree of `nodeId` in `tree`, top first, every parent before
 * its children.
 */
function subtreeOf(tree: Tree, nodeId: string) {
  const all: ({ kind: 'folder'; node: TreeFolder } | { kind: 'page'; node: TreePage })[] = [
    ...tree.folders.map((node) => ({ kind: 'folder' as const, node })),
    ...tree.pages.map((node) => ({ kind: 'page' as const, node })),
  ];
  const top = all.find(({ node }) => node.id === nodeId);
  if (!top) return [];
  const out = [top];
  for (let i = 0; i < out.length; i++) {
    const at = out[i]?.node.id;
    for (const child of all)
      if (child.node.parentId === at && child.node.id !== nodeId) out.push(child);
  }
  return out;
}

const nameOfFolder = (folder: TreeFolder) =>
  folder.metadata?.opened.kind === 'current' ? folder.metadata.opened.metadata.name : null;

/** Whether this person can publish where `region` is in `tree`: an owner, or a member who publishes. */
function publishesIn(tree: Tree, region: Region) {
  if (tree.space?.role === 'owner') return true;
  if (region.kind === 'owner') return false;
  const share = tree.shares.find((s) => s.shareId === region.shareId);
  return share !== undefined && share.role !== 'reader' && share.canPublish;
}

/**
 * Work out copying `nodeId` of `spaceId`, with everything under it that
 * this person's tree lists, under `parentId` of `destination.spaceId` (null
 * for the top of the space), or for `kind: 'move'`, moving it there from
 * another space. Nothing is sealed or sent: the person confirms the
 * preview, then `makeCopy` makes it. Refuses a move within one space, which
 * is an ordinary move (`forbidden`), a destination inside what is copied
 * (`binding-mismatch`), a move by anyone but an owner of the source space,
 * or an agent (`forbidden`), and a destination whose region this app's
 * records and the server's tree disagree on (`region-mismatch`). The server
 * refuses the rest when the copy opens: someone who may not copy or move
 * it, and a publication from another page in it. Links are read with
 * `read`, by default here; the web app reads them in a worker.
 */
export async function previewCopy(
  ctx: ClientContext,
  {
    kind,
    source,
    destination,
    read = async (markdown) => findLinks(markdown),
  }: {
    kind: 'copy' | 'move';
    source: { spaceId: SpaceId; nodeId: FolderId | PageId };
    destination: { spaceId: SpaceId; parentId: FolderId | null };
    read?: ReadLinks;
  },
): Promise<CopyPreview> {
  const sameSpace = source.spaceId === destination.spaceId;
  if (kind === 'move' && sameSpace) {
    throw new ApiError(403, 'forbidden', 'A move within one space is an ordinary move');
  }
  if (kind === 'move' && ctx.agent) {
    throw new ApiError(403, 'forbidden', 'Agents copy, and never move');
  }
  const tree = await loadTree(ctx, source.spaceId);
  if (kind === 'move' && tree.space?.role !== 'owner') {
    throw new ApiError(403, 'forbidden', 'Only an owner of its space moves it into another');
  }
  const moving = subtreeOf(tree, source.nodeId);
  const [top] = moving;
  if (!top) throw new ApiError(404, 'not-found', 'There is no such page or folder');
  const inside = new Set(moving.map(({ node }) => node.id as string));
  if (sameSpace && destination.parentId !== null && inside.has(destination.parentId)) {
    throw new ApiError(400, 'binding-mismatch', 'Nothing copies into itself');
  }
  const target = await newNodeTarget(ctx, destination.spaceId, destination.parentId);
  const destTree = sameSpace ? tree : await loadTree(ctx, destination.spaceId);
  const bringsPublished = publishesIn(destTree, target.region);

  const ids = new Map<string, FolderId | PageId>(
    moving.map(({ kind: k, node }) => [
      node.id,
      k === 'folder' ? newId(FolderIdSchema) : newId(PageIdSchema),
    ]),
  );
  const nodes = moving.map(({ kind: k, node }): CopiedNode => {
    const parentId =
      node.id === source.nodeId ? destination.parentId : (ids.get(node.parentId ?? '') ?? null);
    return {
      sourceId: node.id,
      nodeId: ids.get(node.id) as FolderId | PageId,
      kind: k,
      parentId: parentId as FolderId | null,
      name: k === 'folder' ? nameOfFolder(node) : node.title,
    };
  });
  const pages = moving.flatMap(({ kind: k, node }) => (k === 'page' ? [node] : []));
  const unpublished = bringsPublished
    ? []
    : pages
        .filter((page) => page.publishedHead !== null)
        .map((page) => ({ pageId: page.id, title: page.title }));

  const audience = ctx.agent ? null : await destinationAudience(ctx, destTree, target);
  const isMove = kind === 'move';
  return {
    kind,
    copyId: newId(PageIdSchema),
    source: {
      spaceId: source.spaceId,
      nodeId: source.nodeId,
      kind: top.kind,
      permissionVersion: top.node.permissionVersion,
    },
    destination: {
      spaceId: destination.spaceId,
      parentId: destination.parentId,
      permissionVersion: target.permissionVersion,
      region: target.region,
    },
    bringsPublished,
    nodes,
    audience,
    losses: isMove ? await lossesOf(ctx, source.spaceId, moving, audience) : [],
    unpublished,
    links: sameSpace
      ? []
      : await closedLinks(ctx, { tree, pages, inside, spaceId: source.spaceId, read }),
    inbound: isMove ? await linkingIn(ctx, { tree, inside, spaceId: source.spaceId, read }) : [],
    ends: isMove ? await endsOf(ctx, source.spaceId, { tree, inside, pages }) : null,
  };
}

async function destinationAudience(
  ctx: ClientContext,
  tree: Tree,
  target: Awaited<ReturnType<typeof newNodeTarget>>,
): Promise<CopyAudience> {
  const { region } = target;
  if (tree.space?.role !== 'owner') {
    return { kind: 'unlisted', region, shareId: target.share?.shareId ?? null };
  }
  const keys = await spaceKeys(ctx, tree.space.id);
  const held = await audienceOf(ctx, keys, region);
  return {
    kind: 'verified',
    region,
    people: [...held].map(([identityId, reach]) => ({ identityId, reach })),
  };
}

// The regions what moves is in now, each once, from the key material this app opened it through.
function regionsOf(moving: ReturnType<typeof subtreeOf>): Region[] {
  const regions: Region[] = [];
  for (const { kind, node } of moving) {
    const region = kind === 'folder' ? node.metadata?.region : node.region;
    if (region && !regions.some((r) => sameRegion(r, region))) regions.push(region);
  }
  return regions;
}

const RANK: Record<Reach, number> = { published: 1, drafts: 2 };
const rank = (reach: Reach | null | undefined) => (reach ? RANK[reach] : 0);

/**
 * Who holds less at the destination than in the source's regions now, for
 * a move, whose mover owns the source space. Only someone the destination
 * audience names counts as keeping access, so for a non-owner's preview of
 * the destination, everyone at the source is listed.
 */
async function lossesOf(
  ctx: ClientContext,
  spaceId: SpaceId,
  moving: ReturnType<typeof subtreeOf>,
  audience: CopyAudience,
): Promise<AccessChange[]> {
  const keys = await spaceKeys(ctx, spaceId);
  const before = new Map<IdentityId, Reach>();
  for (const region of regionsOf(moving)) {
    for (const [id, reach] of await audienceOf(ctx, keys, region)) {
      if (rank(reach) > rank(before.get(id))) before.set(id, reach);
    }
  }
  const after = new Map(
    audience?.kind === 'verified' ? audience.people.map((p) => [p.identityId, p.reach]) : [],
  );
  return [...before].flatMap(([identityId, reach]) => {
    const kept = after.get(identityId) ?? null;
    return rank(kept) < rank(reach) ? [{ identityId, before: reach, after: kept }] : [];
  });
}

/**
 * The current version this app reads of a page: its draft, or for a page
 * with none, its publication. Null when it can't be opened.
 */
async function currentOf(ctx: ClientContext, spaceId: SpaceId, page: TreePage) {
  const [audience, head] = page.draftHead
    ? (['draft', page.draftHead] as const)
    : (['published', page.publishedHead] as const);
  if (!head) return null;
  try {
    const opened = await openRevisionOf(ctx, { spaceId, pageId: page.id }, audience, head);
    return opened.opened.kind === 'current' ? opened.opened.payload : null;
  } catch (error) {
    if (error instanceof ApiError || error instanceof CryptoError) return null;
    throw error;
  }
}

/** The pages of `tree` a wikilink's target names by title, as a reader without its entry resolves it. */
const titled = (tree: Tree, target: string) =>
  tree.pages.filter((page) => page.title !== null && foldTitle(page.title) === foldTitle(target));

/**
 * Wikilinks of the copied pages that name a page of the source space that
 * doesn't come along: by their table's entry, or by title. In another space
 * they resolve by title among its pages, or not at all. Each page once.
 */
async function closedLinks(
  ctx: ClientContext,
  {
    tree,
    pages,
    inside,
    spaceId,
    read,
  }: {
    tree: Tree;
    pages: readonly TreePage[];
    inside: ReadonlySet<string>;
    spaceId: SpaceId;
    read: ReadLinks;
  },
): Promise<ClosedLink[] | null> {
  const closed = new Map<string, ClosedLink>();
  for (const page of pages) {
    const payload = await currentOf(ctx, spaceId, page);
    if (!payload) continue;
    const found = await read(payload.markdown).catch(() => null);
    if (!found) return null;
    const table = linkTableOf(payload);
    for (const link of found.wikilinks) {
      if (link.embed || link.target === '') continue;
      const key = foldTitle(link.target);
      const named = table.get(key);
      const target = named ?? titled(tree, link.target)[0]?.id;
      if (target === undefined || inside.has(target)) continue;
      const seen = closed.get(key);
      if (seen) seen.count += 1;
      else closed.set(key, { kind: 'wikilink', page: key, text: link.target, count: 1 });
    }
  }
  return [...closed.values()];
}

/**
 * Pages staying in the source space, that this person can open, which link
 * to a page that moves: by a table entry, an address, or a title only that
 * page has. Those links won't find it once it has moved.
 */
async function linkingIn(
  ctx: ClientContext,
  {
    tree,
    inside,
    spaceId,
    read,
  }: { tree: Tree; inside: ReadonlySet<string>; spaceId: SpaceId; read: ReadLinks },
) {
  const linking = [];
  for (const page of tree.pages) {
    if (inside.has(page.id)) continue;
    const payload = await currentOf(ctx, spaceId, page);
    if (!payload) continue;
    const found = await read(payload.markdown).catch(() => null);
    if (!found) continue;
    const table = linkTableOf(payload);
    const named = (target: string) => {
      const entry = table.get(foldTitle(target));
      if (entry !== undefined) return inside.has(entry);
      const matches = titled(tree, target);
      return matches.length === 1 && inside.has(matches[0]?.id ?? '');
    };
    const links =
      found.wikilinks.some((link) => !link.embed && link.target !== '' && named(link.target)) ||
      found.pageLinks.some((link) => link.spaceId === spaceId && inside.has(link.pageId));
    if (links) linking.push({ pageId: page.id, title: page.title });
  }
  return linking;
}

/** What a move of the subtree ends, as the server lists it to an owner of the space. */
async function endsOf(
  ctx: ClientContext,
  spaceId: SpaceId,
  { tree, inside, pages }: { tree: Tree; inside: ReadonlySet<string>; pages: readonly TreePage[] },
): Promise<MoveEnds> {
  const listed = await listShares(ctx, spaceId);
  const rooted = tree.shares.flatMap((share) =>
    share.rootId !== null && inside.has(share.rootId)
      ? [{ shareId: share.shareId, rootId: share.rootId }]
      : [],
  );
  const shares = rooted.map(({ shareId, rootId }) => ({
    shareId,
    rootId,
    members: (listed.find((s) => s.shareId === shareId)?.members ?? []).map((m) => m.identityId),
  }));
  const agentPicks = listed.flatMap((share) =>
    share.agents.flatMap(({ agentId, personId, name, folderId }) =>
      folderId !== null && inside.has(folderId) ? [{ agentId, personId, name }] : [],
    ),
  );
  const publicLinks = (await listPublicLinks(ctx, spaceId))
    .filter((link) => inside.has(link.pageId))
    .map((link) => link.pageId);
  const publications = [];
  for (const page of pages) {
    const { publications: live } = await ctx.api.call(publicationRoutes.list, {
      params: { pageId: page.id },
    });
    for (const { spaceId: into } of live) publications.push({ pageId: page.id, spaceId: into });
  }
  return { shares, agentPicks, publicLinks, publications };
}

/** What the copy made: the new top node, and each source node's copy. */
export type MadeCopy = {
  spaceId: SpaceId;
  nodeId: FolderId | PageId;
  copies: ReadonlyMap<string, FolderId | PageId>;
};

/** How many times a finish is tried again: for source heads that moved on, or a busy server. */
const FINISH_TRIES = 5;

/**
 * Make a copy or move the person confirmed (`previewCopy`): open it, seal
 * every node again for the destination and send them a batch at a time,
 * then finish. `onProgress` hears how far it has got. For a move, a source
 * head that moved on meanwhile is `stale-head` naming its nodes: those are
 * sealed again from the source as it is now, and the finish tried again; a
 * busy server (`rate-limited`) is waited for, and the finish tried again.
 * Anything else ends the copy, which the server or this deletes, and is
 * thrown: preview again. A broken character from a Milestone 1 client is
 * written as U+FFFD.
 */
export async function makeCopy(
  ctx: ClientContext,
  preview: CopyPreview,
  { onProgress = () => {} }: { onProgress?: (progress: CopyProgress) => void } = {},
): Promise<MadeCopy> {
  const params = { copyId: preview.copyId };
  const total = preview.nodes.length;
  await ctx.api.call(
    copyRoutes.open,
    {
      body: {
        copyId: preview.copyId,
        kind: preview.kind,
        bringsPublished: preview.bringsPublished,
        sourceSpaceId: preview.source.spaceId,
        sourceNodeId: preview.source.nodeId,
        sourcePermissionVersion: preview.source.permissionVersion,
        destinationSpaceId: preview.destination.spaceId,
        parentId: preview.destination.parentId,
        permissionVersion: preview.destination.permissionVersion,
        nodes: preview.nodes.map(({ sourceId, nodeId, kind, parentId }) => ({
          sourceId,
          nodeId,
          kind,
          parentId,
        })),
      },
    },
    { idempotencyKey: preview.copyId },
  );
  try {
    let sent = 0;
    await sendNodes(ctx, preview, preview.nodes, () => {
      sent += 1;
      onProgress({ stage: 'sending', sent, total });
    });
    for (let tries = 1; ; tries++) {
      onProgress({ stage: 'finishing', sent: total, total });
      try {
        await ctx.api.call(copyRoutes.finish, { params });
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || tries >= FINISH_TRIES) throw error;
        const stale = error.code === 'stale-head' ? error.detail?.nodeIds : undefined;
        if (stale && stale.length > 0) {
          const again = preview.nodes.filter((node) => stale.includes(node.nodeId));
          await sendNodes(ctx, preview, again, () => {});
        } else if (error.code === 'rate-limited') {
          await new Promise((resolve) => setTimeout(resolve, 500 * tries));
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    // A finish the server refused has deleted it already.
    await cancelCopy(ctx, preview.copyId).catch(() => undefined);
    throw error;
  }
  const top = preview.nodes[0];
  if (!top) throw new ApiError(404, 'not-found', 'Nothing was copied');
  return {
    spaceId: preview.destination.spaceId,
    nodeId: top.nodeId,
    copies: new Map(preview.nodes.map((node) => [node.sourceId, node.nodeId])),
  };
}

/** Delete a copy not finished, and its hidden nodes. */
export async function cancelCopy(ctx: ClientContext, copyId: string): Promise<void> {
  await ctx.api.call(copyRoutes.cancel, { params: { copyId } });
}

/**
 * Seal `nodes` again from the source as it is now and send them, as many a
 * request as fit, with the destination's keys, and once more with fresh ones
 * for a batch the server refused for a newer key version or other owners.
 * `sent` is called as each node goes.
 */
async function sendNodes(
  ctx: ClientContext,
  preview: CopyPreview,
  nodes: readonly CopiedNode[],
  sent: () => void,
) {
  const sealing = await sealingFor(ctx, preview);
  let batch: CopiedNode[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const going = batch;
    batch = [];
    bytes = 0;
    const send = async (keys: SpaceKeys) => {
      const entries = [];
      for (const node of going) entries.push(await sealing.seal(node, keys));
      await ctx.api.call(copyRoutes.records, {
        params: { copyId: preview.copyId },
        body: { nodes: entries },
      });
    };
    try {
      await send(sealing.keys);
    } catch (error) {
      const stale =
        (error instanceof ApiError &&
          (error.code === 'key-version' || error.code === 'recipients-mismatch')) ||
        (error instanceof CryptoError && error.code === 'missing-key');
      if (!stale) throw error;
      sealing.keys = await spaceKeys(ctx, preview.destination.spaceId, { refresh: true });
      await send(sealing.keys);
    }
    for (const _ of going) sent();
  };
  for (const node of nodes) {
    // Pages are counted by what they hold; a folder's name is small.
    const size = node.kind === 'page' ? await sealing.sizeOf(node) : 1024;
    if (batch.length > 0 && bytes + size > copyRoutes.RECORDS_BATCH_BYTES) await flush();
    batch.push(node);
    bytes += size;
  }
  await flush();
}

/**
 * What sealing the copy's nodes needs, worked out once for each round of
 * sending: the source as it is now, the destination's keys and tree, and
 * the tree its link tables are worked out from, with the copied pages and
 * folders placed at their new nodes, in the destination's region (section
 * 10, **Links**).
 */
async function sealingFor(ctx: ClientContext, preview: CopyPreview) {
  const { source, destination } = preview;
  const sameSpace = source.spaceId === destination.spaceId;
  const tree = await loadTree(ctx, source.spaceId);
  const destTree = sameSpace ? tree : await loadTree(ctx, destination.spaceId);
  const target = await treeTarget(ctx, destination.spaceId, destination.parentId);
  const region = destination.region;
  const copies = new Map<string, string>(preview.nodes.map((n) => [n.sourceId, n.nodeId]));
  const sourcePages = new Map(tree.pages.map((page) => [page.id as string, page]));
  const sourceFolders = new Map(tree.folders.map((folder) => [folder.id as string, folder]));

  // A copied page counts as published there only when its publication comes along.
  const published = new Map<PageId, OpenedPublication>();
  if (preview.bringsPublished) {
    for (const node of preview.nodes) {
      const page = sourcePages.get(node.sourceId);
      if (node.kind !== 'page' || !page?.publishedHead) continue;
      const opened = await openRevisionOf(
        ctx,
        { spaceId: source.spaceId, pageId: page.id },
        'published',
        page.publishedHead,
      ).catch(() => null);
      if (opened?.opened.kind === 'current') {
        published.set(node.nodeId as PageId, { title: opened.opened.payload.title, region });
      }
    }
  }
  const linkTree: LinkTree = {
    shares: destTree.shares,
    folders: [
      ...destTree.folders,
      ...preview.nodes.flatMap((node) => {
        const folder = sourceFolders.get(node.sourceId);
        return node.kind === 'folder' && folder
          ? [{ id: node.nodeId as FolderId, parentId: node.parentId, metadata: folder.metadata }]
          : [];
      }),
    ],
    pages: [
      ...destTree.pages,
      ...preview.nodes.flatMap((node) => {
        const page = sourcePages.get(node.sourceId);
        if (node.kind !== 'page' || !page) return [];
        const id = node.nodeId as PageId;
        return [
          {
            id,
            parentId: node.parentId,
            title: page.title,
            region,
            // Any version ID: `published` answers for it from `published`.
            publishedHead: published.has(id) ? (page.publishedHead as RevisionId) : null,
          },
        ];
      }),
    ],
  };
  const others = publicationsFor(ctx, destination.spaceId);
  const publicationsOf: LinkWrite['published'] = async (asked) => {
    const found = new Map(await others(asked.filter((page) => !published.has(page.id))));
    for (const page of asked) {
      const copied = published.get(page.id);
      if (copied) found.set(page.id, copied);
    }
    return found;
  };

  /** A copied version's payload: its address links, link table and extensions for the copy. */
  const forCopy = async (
    opened: OpenedRevision,
    node: CopiedNode,
    audience: 'draft' | 'published',
  ): Promise<PagePayload> => {
    const { value: payload } = repairText(revisePayload(opened.opened, {}));
    const { [PUBLICATION_NAMESPACE]: _source, ...extensions } = payload.extensions;
    const markdown = rewritePageLinks(payload.markdown, (link) => {
      const copy = link.spaceId === source.spaceId ? copies.get(link.pageId) : undefined;
      return copy ? { spaceId: destination.spaceId, pageId: copy } : null;
    });
    // Entries naming a page of the copy name its copy.
    const table = LinkTable.safeParse(extensions[LINKS_NAMESPACE]);
    if (table.success) {
      extensions[LINKS_NAMESPACE] = {
        ...table.data,
        links: table.data.links.map((link) => ({
          ...link,
          pageId: copies.get(link.pageId) ?? link.pageId,
        })),
      };
    }
    const { payload: linked } = await writeLinks(
      { ...payload, markdown, extensions },
      {
        page: { id: node.nodeId as PageId, parentId: node.parentId },
        audience,
        region,
        // A copy is a new page, so its table is never carried, even within
        // one region: only entries the writer can check stay (section 10).
        tree: () => linkTree,
        published: publicationsOf,
      },
    );
    return linked;
  };

  const sealing = {
    keys: await spaceKeys(ctx, destination.spaceId),
    /** Ciphertext a page's versions take, roughly, for batching. */
    async sizeOf(node: CopiedNode) {
      const page = sourcePages.get(node.sourceId);
      const heads = page ? [page.draftHead ?? page.publishedHead, page.publishedHead] : [];
      let size = 4096;
      for (const head of heads) {
        if (!head || !page) continue;
        const audience = head === page.draftHead ? 'draft' : 'published';
        const opened = await openRevisionOf(
          ctx,
          { spaceId: source.spaceId, pageId: page.id },
          audience,
          head,
        ).catch(() => null);
        if (opened?.opened.kind === 'current') {
          size += (JSON.stringify(opened.opened.payload).length * 4) / 3;
        }
      }
      return size;
    },
    async seal(node: CopiedNode, keys: SpaceKeys): Promise<Entry> {
      if (node.kind === 'folder') {
        const folder = sourceFolders.get(node.sourceId);
        const name = folder?.metadata;
        if (!name) throw new CryptoError('missing-key', 'This app can’t open a folder’s name');
        if (name.opened.kind !== 'current') {
          throw new CryptoError('unsupported-format', 'A folder’s name is in a newer format');
        }
        const { metadata, envelopes, wrap } = sealMetadataV2({
          author: ctx.identity,
          target: {
            installationId: ctx.installationId,
            spaceId: destination.spaceId,
            subjectKind: 'folder',
            subjectId: node.nodeId,
            metadataRevisionId: newId(MetadataRevisionId),
            basedOn: null,
          },
          metadata: name.opened.metadata,
          ...keyTargetFor(ctx, keys, region, target.share),
        });
        return {
          kind: 'folder',
          nodeId: node.nodeId,
          metadata,
          envelopes,
          wrap,
          sourceMetadataRevisionId: name.head,
        };
      }
      // The source's heads as they are now, which a move's finish compares.
      const from = { spaceId: source.spaceId, pageId: PageIdSchema.parse(node.sourceId) };
      const { heads } = await loadPage(ctx, from.pageId);
      const page = { spaceId: destination.spaceId, pageId: node.nodeId as PageId };
      const version = async (
        audience: 'draft' | 'published',
        sealedFrom: 'draft' | 'published',
        revisionId: RevisionId,
        baseOf: (opened: OpenedRevision) => RevisionId | null = () => null,
      ) => {
        const opened = await openRevisionOf(ctx, from, sealedFrom, revisionId, { fresh: true });
        const payload = await forCopy(opened, node, audience);
        const attachments: AttachmentRef[] = [];
        for (const ref of payload.attachments) {
          const resealed = resealAttachment({
            from: attachmentTarget(ctx, from, sealedFrom),
            to: attachmentTarget(ctx, page, audience),
            ref,
            blob: await downloadBlob(ctx, ref.blobHash),
          });
          await uploadBlob(ctx, page, audience, resealed.blob);
          attachments.push(resealed.ref);
        }
        const { permissionVersion: _version, ...commit } = commitFor(ctx, keys, page, {
          audience,
          basedOn: baseOf(opened),
          payload: { ...payload, attachments },
          region,
          target,
        });
        return { ...commit, sourceRevisionId: revisionId };
      };
      // A page with no draft, as a publication ended without being
      // detached, gets its publication as its draft too.
      const draft = heads.draftHead
        ? await version('draft', 'draft', heads.draftHead)
        : heads.publishedHead && (await version('draft', 'published', heads.publishedHead));
      if (!draft) throw new ApiError(404, 'not-found', 'That page has no version to copy');
      // Its publication names the copy's draft when the source's was made
      // from its current draft, or it had none: the copy then shows no
      // unpublished changes where the source had none.
      const draftId = draft.revision.record.revisionId;
      const baseOf = (opened: OpenedRevision) =>
        heads.draftHead === null || opened.record.basedOn === heads.draftHead ? draftId : null;
      return {
        kind: 'page',
        nodeId: node.nodeId,
        draft,
        published:
          preview.bringsPublished && heads.publishedHead
            ? await version('published', 'published', heads.publishedHead, baseOf)
            : null,
      };
    },
  };
  return sealing;
}
