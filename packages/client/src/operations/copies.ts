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
// new preview. Versions are opened many to a request, and both steps wait
// out the server's rate limits (`patient`), since a copy of many pages
// reads, uploads and sends more in a minute than they allow.
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
import { ApiError, outcomeUnknown, type ApiClient } from '../api/client.ts';
import { utf8 } from '../encoding.ts';
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
import { findLinks, foldTitle, rewriteAddressLinks, type FoundLinks } from '../links.ts';
import { sealMetadataV2 } from '../metadata.ts';
import { revisePayload, type AttachmentRef, type PagePayload } from '../payload.ts';
import { sameRegion, type Region } from '../regions.ts';
import { resealAttachment } from '../revision.ts';
import { spaceKeys } from './keys.ts';
import { audienceOf, type AccessChange, type Reach } from './moves.ts';
import {
  attachmentTarget,
  commitFor,
  downloadBlob,
  fetchRevisions,
  publicationsFor,
  shownVersions,
  uploadBlob,
  type OpenedRevision,
  type Wanted,
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
   * that don't come along, and for a move, address links to pages and
   * folders it deletes that are written with escapes, so they aren't
   * pointed at the copies. Null when some Markdown couldn't be read for links.
   */
  links: ClosedLink[] | null;
  /**
   * For a move, pages staying behind, that this person can open, which link
   * to a page or folder that moves.
   */
  inbound: { pageId: PageId; title: string | null }[];
  /** For a move, what it ends. */
  ends: MoveEnds | null;
};

/** How far `makeCopy` has got: nodes sealed and sent, of `total`. */
export type CopyProgress = { stage: 'sending' | 'finishing'; sent: number; total: number };

/** `makeCopy` stopped by its `signal` before the finish was sent: the copy is cancelled. */
export class CopyStopped extends Error {
  constructor() {
    super('The copy was stopped');
    this.name = 'CopyStopped';
  }
}

/**
 * A copy `makeCopy` left, not cancelled, because its finish may have made it:
 * the finish's answer never came (`busy` false), or the server stayed too
 * busy to finish it (`busy` true) and keeps it for a later finish. `cause`
 * is the finish's error. Anything else `makeCopy` throws cancelled the copy.
 */
export class CopyKept extends Error {
  readonly busy: boolean;
  constructor(cause: unknown, busy: boolean) {
    super(busy ? 'The server was too busy to finish the copy' : 'The copy may have finished', {
      cause,
    });
    this.name = 'CopyKept';
    this.busy = busy;
  }
}

type ReadLinks = (markdown: string) => Promise<FoundLinks>;

/** How long one request waits out the server's rate limits, in all, before giving up. */
const PATIENCE_MS = 2 * 60 * 1000;

/** How many nodes are opened at a time, many to a request: fewer than a records request takes. */
const CHUNK = 200;

/** Wait `ms`, or throw `CopyStopped` as soon as `signal` aborts. */
const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new CopyStopped());
    const stop = () => {
      clearTimeout(timer);
      reject(new CopyStopped());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * `ctx` with an API that waits out `rate-limited` and tries again, as long
 * as the server's `Retry-After` says (a second if it doesn't), for up to
 * `PATIENCE_MS` a request. That is also the finish's answer while
 * publications a delete ends are being written. A wait ends early when
 * `signal` aborts, throwing `CopyStopped`.
 */
function patient(ctx: ClientContext, signal?: AbortSignal): ClientContext {
  const waiting = async <T>(send: () => Promise<T>): Promise<T> => {
    const until = Date.now() + PATIENCE_MS;
    for (;;) {
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'rate-limited') throw error;
        const ms = (error.retryAfterSeconds ?? 1) * 1000;
        if (Date.now() + ms > until) throw error;
        await pause(ms, signal);
      }
    }
  };
  const { api } = ctx;
  const patientApi: ApiClient = {
    call: ((...args: Parameters<ApiClient['call']>) =>
      waiting(() => api.call(...args))) as ApiClient['call'],
    upload: (...args) => waiting(() => api.upload(...args)),
    download: (...args) => waiting(() => api.download(...args)),
  };
  return { ...ctx, api: patientApi };
}

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
 * `read`, by default here; the web app reads them in a worker. The copy's
 * ID and each new node's ID, by its source's, are made at random unless
 * `copyId` and `ids` choose them, as the CLI does from an idempotency key.
 */
export async function previewCopy(
  ctx: ClientContext,
  {
    kind,
    source,
    destination,
    read = async (markdown) => findLinks(markdown),
    copyId = newId(copyRoutes.CopyId),
    ids: idOf,
  }: {
    kind: 'copy' | 'move';
    source: { spaceId: SpaceId; nodeId: FolderId | PageId };
    destination: { spaceId: SpaceId; parentId: FolderId | null };
    read?: ReadLinks;
    copyId?: string;
    ids?: (sourceId: string) => string;
  },
): Promise<CopyPreview> {
  ctx = patient(ctx);
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
    moving.map(({ kind: k, node }) => {
      const schema = k === 'folder' ? FolderIdSchema : PageIdSchema;
      return [node.id, idOf ? schema.parse(idOf(node.id)) : newId(schema)];
    }),
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
    copyId: copyRoutes.CopyId.parse(copyId),
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
      : await closedLinks(ctx, {
          tree,
          pages,
          inside,
          spaceId: source.spaceId,
          read,
          moving: isMove,
        }),
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
 * the destination, everyone at the source is listed but the mover, who
 * writes there.
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
  const mover = ctx.identity.public.id;
  return [...before].flatMap(([identityId, reach]) => {
    if (audience?.kind === 'unlisted' && identityId === mover) return [];
    const kept = after.get(identityId) ?? null;
    return rank(kept) < rank(reach) ? [{ identityId, before: reach, after: kept }] : [];
  });
}

/**
 * The current version this app reads of each of `pages`, a part at a time,
 * many to a request (`shownVersions`): its draft, or for a page with none,
 * its publication. Null for one that can't be opened; any other failure is
 * thrown, so no page is passed over unread.
 */
async function* currentVersions(ctx: ClientContext, spaceId: SpaceId, pages: readonly TreePage[]) {
  for (let i = 0; i < pages.length; i += CHUNK) {
    const part = pages.slice(i, i + CHUNK);
    const versions = await shownVersions(ctx, spaceId, part);
    for (const page of part) {
      const opened = versions.get(page.id)?.opened;
      yield { page, payload: opened?.kind === 'current' ? opened.payload : null };
    }
  }
}

/** The pages of `tree` a wikilink's target names by title, as a reader without its entry resolves it. */
const titled = (tree: Tree, target: string) =>
  tree.pages.filter((page) => page.title !== null && foldTitle(page.title) === foldTitle(target));

/**
 * Wikilinks of the copied pages that name a page of the source space that
 * doesn't come along: by their table's entry, or by title. In another space
 * they resolve by title among its pages, or not at all. For a move
 * (`moving`), also address links to a page or folder it deletes that the
 * copy can't point at its copy, written with escapes. Each page or folder once.
 */
async function closedLinks(
  ctx: ClientContext,
  {
    tree,
    pages,
    inside,
    spaceId,
    read,
    moving,
  }: {
    tree: Tree;
    pages: readonly TreePage[];
    inside: ReadonlySet<string>;
    spaceId: SpaceId;
    read: ReadLinks;
    moving: boolean;
  },
): Promise<ClosedLink[] | null> {
  const closed = new Map<string, ClosedLink>();
  const add = (link: Omit<ClosedLink, 'count'>) => {
    const key = `${link.kind} ${link.page}`;
    const seen = closed.get(key);
    if (seen) seen.count += 1;
    else closed.set(key, { ...link, count: 1 });
  };
  for await (const { payload } of currentVersions(ctx, spaceId, pages)) {
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
      add({ kind: 'wikilink', page: key, text: link.target });
    }
    if (!moving) continue;
    const addresses = [
      ...found.pageLinks.map((link) => ({ ...link, kind: 'page-link' as const, id: link.pageId })),
      ...found.folderLinks.map((link) => ({
        ...link,
        kind: 'folder-link' as const,
        id: link.folderId,
      })),
    ];
    for (const link of addresses) {
      if (link.plain || link.spaceId !== spaceId || !inside.has(link.id)) continue;
      add({ kind: link.kind, page: `${link.spaceId}/${link.id}`, text: link.text || link.source });
    }
  }
  return [...closed.values()];
}

/**
 * Pages staying in the source space, that this person can open, which link
 * to a page that moves, by a table entry, an address, or a title only that
 * page has, or to a folder that moves, by its address. Those links won't
 * find it once it has moved.
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
  const staying = tree.pages.filter((page) => !inside.has(page.id));
  for await (const { page, payload } of currentVersions(ctx, spaceId, staying)) {
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
      found.pageLinks.some((link) => link.spaceId === spaceId && inside.has(link.pageId)) ||
      found.folderLinks.some((link) => link.spaceId === spaceId && inside.has(link.folderId));
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

/** How many times a finish is sent: again for source heads that moved on, or an answer lost. */
const FINISH_TRIES = 5;

/**
 * Make a copy or move the person confirmed (`previewCopy`): open it, seal
 * every node again for the destination and send them a batch at a time,
 * then finish. `onProgress` hears how far it has got. For a move, a source
 * head that moved on meanwhile is `stale-head` naming its nodes: those are
 * sealed again from the source as it is now, and the finish tried again. A
 * busy server (`rate-limited`) is waited for, as its `Retry-After` says,
 * for every request (`patient`). A finish whose answer was lost is sent
 * again, which the server answers as it answered the first; if no answer
 * comes, it throws `CopyKept` without cancelling, since the copy may have
 * been made. So does a finish still busy after all that: the server keeps
 * the copy, and sweeps it if nobody finishes it. Anything else ends the
 * copy, which the server or this deletes, and is thrown: preview again. That includes a batch of records refused for
 * `permission-version`; one refused for a newer key version is sealed again
 * and sent again. A broken character from a Milestone 1 client is written
 * as U+FFFD.
 *
 * When `signal` aborts, it stops before the next node or attachment is
 * sealed, or the next request is sent, and from a wait for a busy server;
 * cancels the copy and throws `CopyStopped`. Once the finish is sent, it no
 * longer stops: the finish decides.
 */
export async function makeCopy(
  ctx: ClientContext,
  preview: CopyPreview,
  {
    onProgress = () => {},
    signal,
  }: { onProgress?: (progress: CopyProgress) => void; signal?: AbortSignal } = {},
): Promise<MadeCopy> {
  // Only sending stops on `signal`; the finish, and a cancel, never do.
  const sending = patient(ctx, signal);
  ctx = patient(ctx);
  const params = { copyId: preview.copyId };
  const total = preview.nodes.length;
  const live = () => {
    if (signal?.aborted) throw new CopyStopped();
  };
  live();
  // An opening whose answer was lost may have opened the copy: cancelled,
  // which is not-found if it didn't.
  const opening = sending.api.call(
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
  await opening.catch(async (error: unknown) => {
    if (outcomeUnknown(error)) await cancelCopy(ctx, preview.copyId).catch(() => undefined);
    throw error;
  });
  // Whether to leave the copy: the last finish sent may have made it, its
  // answer lost, or the server was still too busy to finish it.
  let keep = false;
  try {
    let sent = 0;
    await sendNodes(sending, preview, preview.nodes, {
      sent: () => {
        sent += 1;
        onProgress({ stage: 'sending', sent, total });
      },
      live,
    });
    live();
    for (let tries = 1; ; tries++) {
      onProgress({ stage: 'finishing', sent: total, total });
      try {
        await ctx.api.call(copyRoutes.finish, { params });
        break;
      } catch (error) {
        const busy = error instanceof ApiError && error.code === 'rate-limited';
        keep = outcomeUnknown(error) || busy;
        // Still busy once `patient` has waited as long as it would: the
        // server keeps the copy for a later finish, so stop asking now.
        if (!(error instanceof ApiError) || busy || tries >= FINISH_TRIES) throw error;
        const stale = error.code === 'stale-head' ? error.detail?.nodeIds : undefined;
        if (stale && stale.length > 0) {
          const again = preview.nodes.filter((node) => stale.includes(node.nodeId));
          await sendNodes(ctx, preview, again);
        } else if (keep) {
          await pause(1000 * tries);
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    // A finish the server refused has deleted it already. One that may have
    // made it is left, as a cancel would answer as its finish did anyway, and
    // so is one still busy, which the server keeps for a later finish.
    if (!keep) {
      await cancelCopy(ctx, preview.copyId).catch(() => undefined);
      throw error;
    }
    throw new CopyKept(error, error instanceof ApiError && error.code === 'rate-limited');
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
 * request as fit by bytes and by count, with the destination's keys, and
 * once more with fresh keys and target for a batch the server refused for
 * a newer key version or other owners. Their versions are opened a part at
 * a time, many to a request. `sent` is called as each node goes, and `live`
 * before each part is opened, each node sealed and each attachment read and
 * sent, to stop there.
 */
async function sendNodes(
  ctx: ClientContext,
  preview: CopyPreview,
  nodes: readonly CopiedNode[],
  { sent = () => {}, live = () => {} }: { sent?: () => void; live?: () => void } = {},
) {
  const sealing = await sealingFor(ctx, preview, live);
  for (let i = 0; i < nodes.length; i += CHUNK) {
    live();
    const part = nodes.slice(i, i + CHUNK);
    const versions = await sealing.open(part);
    let batch: CopiedNode[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const going = batch;
      batch = [];
      bytes = 0;
      const send = async () => {
        const entries = [];
        for (const node of going) {
          live();
          entries.push(await sealing.seal(node, versions));
        }
        live();
        await ctx.api.call(copyRoutes.records, {
          params: { copyId: preview.copyId },
          body: { nodes: entries },
        });
      };
      try {
        await send();
      } catch (error) {
        const stale =
          (error instanceof ApiError &&
            (error.code === 'key-version' || error.code === 'recipients-mismatch')) ||
          (error instanceof CryptoError && error.code === 'missing-key');
        if (!stale) throw error;
        await sealing.refresh();
        await send();
      }
      for (const _ of going) sent();
    };
    for (const node of part) {
      // Pages are counted by what they hold; a folder's name is small.
      const size = node.kind === 'page' ? sealing.sizeOf(node, versions) : 1024;
      const full =
        bytes + size > copyRoutes.RECORDS_BATCH_BYTES ||
        batch.length >= copyRoutes.MAX_RECORDS_NODES;
      if (batch.length > 0 && full) await flush();
      batch.push(node);
      bytes += size;
    }
    await flush();
  }
}

type Opened = ReadonlyMap<RevisionId, () => OpenedRevision>;

/** A version `open` fetched, opened, as `openRevisionOf` answers. */
function openedIn(versions: Opened, revisionId: RevisionId): OpenedRevision {
  const open = versions.get(revisionId);
  if (!open) throw new ApiError(404, 'not-found', 'That version is not available');
  return open();
}

/**
 * What sealing the copy's nodes needs, worked out once for each round of
 * sending: the source as it is now, the destination's keys and target, and
 * the tree its link tables are worked out from, with the copied pages and
 * folders placed at their new nodes, in the destination's region (section
 * 10, **Links**). Each page is sealed from the heads the round's tree
 * lists, which a move's finish compares.
 */
async function sealingFor(ctx: ClientContext, preview: CopyPreview, live: () => void) {
  const { source, destination } = preview;
  const sameSpace = source.spaceId === destination.spaceId;
  const tree = await loadTree(ctx, source.spaceId);
  const destTree = sameSpace ? tree : await loadTree(ctx, destination.spaceId);
  let target = await treeTarget(ctx, destination.spaceId, destination.parentId);
  let keys = await spaceKeys(ctx, destination.spaceId);
  const region = destination.region;
  const copies = new Map<string, string>(preview.nodes.map((n) => [n.sourceId, n.nodeId]));
  const sourcePages = new Map(tree.pages.map((page) => [page.id as string, page]));
  const sourceFolders = new Map(tree.folders.map((folder) => [folder.id as string, folder]));

  /**
   * The source versions a page's copy is sealed from: its draft (its
   * publication, for a page with none), and its publication when it comes
   * along. Null for a page gone from the tree.
   */
  const headsOf = (node: CopiedNode) => {
    const page = sourcePages.get(node.sourceId);
    if (node.kind !== 'page' || !page) return null;
    const draft = page.draftHead
      ? { audience: 'draft' as const, revisionId: page.draftHead }
      : page.publishedHead && { audience: 'published' as const, revisionId: page.publishedHead };
    const published = preview.bringsPublished ? page.publishedHead : null;
    return { page, draft: draft || null, published };
  };

  // A copied page counts as published there only when its publication comes along.
  const published = new Map<PageId, OpenedPublication>();
  const publishing = preview.nodes.flatMap((node) => {
    const revisionId = headsOf(node)?.published;
    return revisionId ? [{ node, revisionId }] : [];
  });
  for (let i = 0; i < publishing.length; i += CHUNK) {
    const part = publishing.slice(i, i + CHUNK);
    const wanted = new Map<RevisionId, Wanted>(
      part.map(({ node, revisionId }) => [
        revisionId,
        { pageId: node.sourceId as PageId, audience: 'published' },
      ]),
    );
    const versions = await fetchRevisions(ctx, source.spaceId, wanted);
    for (const { node, revisionId } of part) {
      try {
        const { opened } = openedIn(versions, revisionId);
        if (opened.kind === 'current') {
          published.set(node.nodeId as PageId, { title: opened.payload.title, region });
        }
      } catch {
        // Not counted as published there; sealing it finds out why.
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
    const markdown = rewriteAddressLinks(payload.markdown, (link) => {
      const copy = link.spaceId === source.spaceId ? copies.get(link.nodeId) : undefined;
      return copy ? { spaceId: destination.spaceId, nodeId: copy } : null;
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
    const copied = { ...payload, markdown, extensions };
    const { payload: linked } = await writeLinks(copied, {
      page: { id: node.nodeId as PageId, parentId: node.parentId },
      audience,
      region,
      // A publication into a share keeps only entries its readers read
      // already: the source publication's, for the copies published with it.
      ...(audience === 'published' && {
        publication: {
          table: new Map([...linkTableOf(copied)].filter(([, id]) => published.has(id))),
          region,
        },
      }),
      // A copy is a new page, so its table is never carried, even within
      // one region: only entries the writer can check stay (section 10).
      tree: () => linkTree,
      published: publicationsOf,
      // Its text is the source's, apart from address links: no link is renamed.
      renames: false,
    });
    return linked;
  };

  return {
    /** The source versions `nodes` are sealed from, fetched fresh, many to a request. */
    async open(nodes: readonly CopiedNode[]): Promise<Opened> {
      const wanted = new Map<RevisionId, Wanted>();
      for (const node of nodes) {
        const heads = headsOf(node);
        if (!heads) continue;
        const pageId = heads.page.id;
        if (heads.draft)
          wanted.set(heads.draft.revisionId, { pageId, audience: heads.draft.audience });
        if (heads.published) wanted.set(heads.published, { pageId, audience: 'published' });
      }
      return fetchRevisions(ctx, source.spaceId, wanted, { fresh: true });
    },
    /** The destination's keys and target again, after a batch was refused for them. */
    async refresh() {
      keys = await spaceKeys(ctx, destination.spaceId, { refresh: true });
      target = await treeTarget(ctx, destination.spaceId, destination.parentId);
    },
    /** Bytes a page's records take, roughly, for batching: its versions' UTF-8, sealed and encoded. */
    sizeOf(node: CopiedNode, versions: Opened) {
      const heads = headsOf(node);
      let size = 4096;
      for (const revisionId of [heads?.draft?.revisionId, heads?.published]) {
        if (!revisionId) continue;
        try {
          const { opened } = openedIn(versions, revisionId);
          if (opened.kind === 'current') {
            size += (utf8(JSON.stringify(opened.payload)).length * 4) / 3;
          }
        } catch {
          // Sealing it finds out why.
        }
      }
      return size;
    },
    async seal(node: CopiedNode, versions: Opened): Promise<Entry> {
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
      const heads = headsOf(node);
      if (!heads) throw new ApiError(404, 'not-found', 'A page being copied is gone');
      const from = { spaceId: source.spaceId, pageId: PageIdSchema.parse(node.sourceId) };
      const page = { spaceId: destination.spaceId, pageId: node.nodeId as PageId };
      const version = async (
        audience: 'draft' | 'published',
        sealedFrom: 'draft' | 'published',
        revisionId: RevisionId,
        baseOf: (opened: OpenedRevision) => RevisionId | null = () => null,
      ) => {
        const opened = openedIn(versions, revisionId);
        const payload = await forCopy(opened, node, audience);
        const attachments: AttachmentRef[] = [];
        for (const ref of payload.attachments) {
          live();
          const blob = await downloadBlob(ctx, ref.blobHash);
          const resealed = resealAttachment({
            from: attachmentTarget(ctx, from, sealedFrom),
            to: attachmentTarget(ctx, page, audience),
            ref,
            blob,
          });
          live();
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
      if (!heads.draft) throw new ApiError(404, 'not-found', 'That page has no version to copy');
      const draft = await version('draft', heads.draft.audience, heads.draft.revisionId);
      // Its publication names the copy's draft when the source's was made
      // from its current draft, or it had none: the copy then shows no
      // unpublished changes where the source had none.
      const draftId = draft.revision.record.revisionId;
      const { draftHead } = heads.page;
      const baseOf = (opened: OpenedRevision) =>
        draftHead === null || opened.record.basedOn === draftHead ? draftId : null;
      return {
        kind: 'page',
        nodeId: node.nodeId,
        draft,
        published: heads.published
          ? await version('published', 'published', heads.published, baseOf)
          : null,
      };
    },
  };
}
