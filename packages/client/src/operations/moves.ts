// Moving a page or folder (protocol section 10). Within one region a move
// changes no keys. Across a share boundary an owner's app shows who gains
// and who loses access, then rewraps every record of what moves under the
// destination's keys, or seals it to the owners, and sends it all at once.
import {
  FolderKeyEnvelope,
  sharingRoutes,
  structureRoutes,
  type RevisionId,
  type FolderId,
  type IdentityId,
  type KeyEnvelopeV2,
  type MetadataEnvelopeV2,
  type PageId,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import {
  folderKeyEnvelopeBytes,
  folderKeyOf,
  metadataWrapSubject,
  revisionWrapSubject,
  wrapContentKey,
  type HeldKeyVersion,
} from '../folder-keys.ts';
import { isAgentId, verifySignature, type PublicIdentity } from '../identity.ts';
import { writeKeyVersion } from '../key-versions.ts';
import { grantMetadataKeyV2 } from '../metadata.ts';
import { OWNER_REGION, requireRegion, sameRegion, type Region } from '../regions.ts';
import { grantRevisionKeyV2 } from '../revision.ts';
import { foldersUnder } from '../tree.ts';
import { forgetSpaces, type SpaceKeys } from './keys.ts';
import { loadHistory, loadPage, openRevisionOf } from './pages.ts';
import { treeTarget } from './records.ts';
import type { ClientContext } from './session.ts';
import {
  forEachRecordKey,
  listShares,
  ownerKeys,
  type Progress,
  type SharePreview,
} from './sharing.ts';
import { loadTree } from './spaces.ts';

/** What someone holds in a region: both keys, or the published key only. */
export type Reach = 'drafts' | 'published';

/** Someone whose access a move changes: what they hold before it, and after (null: nothing). */
export type AccessChange = { identityId: IdentityId; before: Reach | null; after: Reach | null };

/** A move worked out for the person to confirm. */
export type MovePreview = {
  spaceId: SpaceId;
  nodeId: FolderId | PageId;
  kind: 'folder' | 'page';
  /** Where it is now, and where it goes (null: the top of the space). */
  fromParentId: FolderId | null;
  parentId: FolderId | null;
  /** The permission versions of the node and of the destination, which the move carries. */
  permissionVersion: number;
  parentPermissionVersion: number;
  /** Its region now, and the destination's, from records this app opened (section 6.1). */
  from: Region;
  to: Region;
  /** Whether keys change: a move across a region boundary, which only owners make. */
  crossing: boolean;
  /**
   * Who gains access, and who loses it, when keys change. The gainers come
   * from envelopes this app verified, which a server can hide, so they are
   * at least these people (section 10).
   */
  gains: AccessChange[];
  losses: AccessChange[];
  /**
   * Agents picked for a folder in what moves, whose picks end when it
   * leaves their share (section 9.4), by the names the server lists.
   */
  endingPicks: sharingRoutes.ShareAgent[];
  /** Everything that moves, by decrypted name, for an owner to look over when keys change. */
  folders: SharePreview['folders'];
  pages: SharePreview['pages'];
};

const RANK: Record<Reach, number> = { published: 1, drafts: 2 };
const rank = (reach: Reach | null | undefined) => (reach ? RANK[reach] : 0);

/**
 * Work out moving `nodeId`, with everything under it, under `parentId`, or
 * to the top of the space for `null` (section 10). Nothing is wrapped,
 * sealed or sent: the person confirms the preview, then `moveNode` makes
 * the move. Refuses a destination inside what moves (`stale-head`: it went
 * there since it was chosen), one that would nest a share
 * (`share-nesting`), a move across a share
 * boundary by anyone but an owner (`forbidden`), and a node or destination
 * whose region this app's records and the server's tree disagree on
 * (`region-mismatch`).
 */
export async function previewMove(
  ctx: ClientContext,
  {
    spaceId,
    nodeId,
    parentId,
  }: { spaceId: SpaceId; nodeId: FolderId | PageId; parentId: FolderId | null },
): Promise<MovePreview> {
  const tree = await loadTree(ctx, spaceId);
  const folder = tree.folders.find((f) => f.id === nodeId);
  const page = tree.pages.find((p) => p.id === nodeId);
  const node = folder ?? page;
  if (!node) throw new ApiError(404, 'not-found', 'There is no such page or folder');
  const parentName =
    parentId === null
      ? tree.space?.metadata
      : tree.folders.find((f) => f.id === parentId)?.metadata;
  if (parentName === undefined) throw new ApiError(404, 'not-found', 'There is no such folder');
  if (!parentName) {
    throw new CryptoError('missing-key', 'This app can’t open the destination’s name');
  }

  const moving = whatMoves(tree, { nodeId, kind: folder ? 'folder' : 'page' });
  // The destination went inside what moves since it was chosen.
  if (parentId !== null && moving.under.has(parentId)) {
    throw new ApiError(409, 'stale-head', 'Nothing moves into itself');
  }
  const from = folder
    ? requireOpened(folder.metadata?.region)
    : page &&
      (
        await openRevisionOf(
          ctx,
          { spaceId, pageId: page.id },
          ...(await headOf(ctx, spaceId, page)),
          { fresh: true },
        )
      ).region;
  if (!from) throw new ApiError(404, 'not-found', 'There is no such page or folder');
  const to = parentName.region;
  const atNode = await treeTarget(ctx, spaceId, nodeId);
  const atParent = await treeTarget(ctx, spaceId, parentId);
  requireRegion({ write: from, tree: regionOf(atNode.share) });
  requireRegion({ write: to, tree: regionOf(atParent.share) });

  const roots = new Set<string>(
    tree.shares.flatMap((share) => (share.rootId ? [share.rootId] : [])),
  );
  if (to.kind === 'share' && [...moving.under].some((id) => roots.has(id))) {
    throw new ApiError(409, 'share-nesting', 'A share can’t go inside another share', {
      shareId: to.shareId,
    });
  }
  // A share root keeps its own share wherever it goes.
  const crossing = !roots.has(nodeId) && !sameRegion(from, to);
  const base = {
    spaceId,
    nodeId,
    kind: folder ? ('folder' as const) : ('page' as const),
    fromParentId: node.parentId,
    parentId,
    permissionVersion: atNode.permissionVersion,
    parentPermissionVersion: atParent.permissionVersion,
    from,
    to,
    crossing,
    folders: moving.folders.map(({ id, parentId: p, metadata }) => ({ id, parentId: p, metadata })),
    pages: moving.pages.map(({ id, parentId: p, title }) => ({ id, parentId: p, title })),
  };
  if (!crossing) return { ...base, gains: [], losses: [], endingPicks: [] };
  if (tree.space?.role !== 'owner') {
    throw new ApiError(403, 'forbidden', 'Only owners move across a share boundary');
  }
  const keys = await ownerKeys(ctx, spaceId);
  const before = await audienceOf(ctx, keys, from);
  const after = await audienceOf(ctx, keys, to);
  const changes = (gaining: boolean): AccessChange[] =>
    [...new Set([...before.keys(), ...after.keys()])].flatMap((identityId) => {
      const change = {
        identityId,
        before: before.get(identityId) ?? null,
        after: after.get(identityId) ?? null,
      };
      const gained = rank(change.after) > rank(change.before);
      const lost = rank(change.after) < rank(change.before);
      return (gaining ? gained : lost) ? [change] : [];
    });
  const fromShare =
    from.kind === 'share'
      ? (await listShares(ctx, spaceId)).find((s) => s.shareId === from.shareId)
      : undefined;
  const endingPicks = (fromShare?.agents ?? []).flatMap(({ agentId, personId, name, folderId }) =>
    folderId !== null && moving.under.has(folderId) ? [{ agentId, personId, name }] : [],
  );
  return { ...base, gains: changes(true), losses: changes(false), endingPicks };
}

type Node = { id: string; parentId: string | null };

/**
 * What moves, by a tree: a folder with every folder and page under it, or
 * a page alone. A page never holds another, whatever a server lists.
 */
function whatMoves<F extends Node, P extends Node>(
  tree: { folders: readonly F[]; pages: readonly P[] },
  { nodeId, kind }: { nodeId: string; kind: 'folder' | 'page' },
): { under: Set<string>; folders: F[]; pages: P[] } {
  if (kind === 'page') {
    return { under: new Set(), folders: [], pages: tree.pages.filter((p) => p.id === nodeId) };
  }
  const under = foldersUnder(tree.folders, nodeId);
  return {
    under,
    folders: tree.folders.filter((f) => under.has(f.id)),
    pages: tree.pages.filter((p) => p.parentId !== null && under.has(p.parentId)),
  };
}

/**
 * Whether the server's own tree, as it is now, explains how what moves
 * differs from the preview: it differs, everything in `added` is now in
 * what moves, and nothing in `gone` is. That's someone adding to or deleting
 * from it meanwhile, an honest race, so the person looks at the move again.
 * Anything else is left for the caller to refuse as binding-mismatch.
 */
async function changedMeanwhile(
  ctx: ClientContext,
  preview: MovePreview,
  { added = [], gone = [] }: { added?: Iterable<string>; gone?: Iterable<string> },
): Promise<boolean> {
  const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId: preview.spaceId } });
  const moving = whatMoves(tree, preview);
  const now = new Set<string>([...moving.folders, ...moving.pages].map((node) => node.id));
  const shown = new Set<string>([...preview.folders, ...preview.pages].map((node) => node.id));
  const differs = now.size !== shown.size || [...now].some((id) => !shown.has(id));
  return differs && [...added].every((id) => now.has(id)) && ![...gone].some((id) => now.has(id));
}

/** Refuses a move whose subtree changed since the preview, so it is previewed again. */
const previewAgain = () => new ApiError(409, 'stale-head', 'What moves changed since the preview');

const regionOf = (share: { spaceId: SpaceId; shareId: ShareId } | null): Region =>
  share ? { kind: 'share', spaceId: share.spaceId, shareId: share.shareId } : OWNER_REGION;

function requireOpened(region: Region | undefined): Region {
  if (!region) throw new CryptoError('missing-key', 'This app can’t open the folder’s name');
  return region;
}

/**
 * The version a page's region is read from: its draft, or for a page
 * published from another page, which has none until it is detached
 * (section 13), its latest publication, which for one unpublished there is
 * the newest in its history. Readers see no draft either, and don't move
 * pages.
 */
async function headOf(
  ctx: ClientContext,
  spaceId: SpaceId,
  page: { id: PageId; draftHead: RevisionId | null; publishedHead: RevisionId | null },
): Promise<['draft' | 'published', RevisionId]> {
  if (page.draftHead) return ['draft', page.draftHead];
  const refused = new ApiError(403, 'forbidden', 'Only someone who can edit a page moves it');
  if ((await loadPage(ctx, page.id)).role === 'reader') throw refused;
  const latest =
    page.publishedHead ?? (await loadHistory(ctx, { spaceId, pageId: page.id }))[0]?.revisionId;
  if (!latest) throw refused;
  return ['published', latest];
}

/**
 * Who holds keys in a region, and how much (section 10): in the owner
 * region, the sealing owners; in a share, the people whose envelopes of its
 * current version this app verifies, sealed by an owner it accepts for
 * writing, and the sealing owners. Agents follow their people.
 */
export async function audienceOf(
  ctx: ClientContext,
  keys: SpaceKeys,
  region: Region,
): Promise<Map<IdentityId, Reach>> {
  const held = new Map<IdentityId, Reach>(
    keys.owners.sealingOwners().map((owner) => [owner.id, 'drafts'] as const),
  );
  if (region.kind === 'owner') return held;
  const share = (await listShares(ctx, region.spaceId)).find((s) => s.shareId === region.shareId);
  if (!share) throw new CryptoError('missing-key', `The server lists no share ${region.shareId}`);
  const { envelopes } = await ctx.api.call(sharingRoutes.versionEnvelopes, {
    params: { shareId: share.shareId, keyVersion: share.currentKeyVersion },
  });
  for (const raw of envelopes) {
    const parsed = FolderKeyEnvelope.safeParse(raw);
    if (!parsed.success) continue;
    const envelope = parsed.data;
    if (
      envelope.spaceId !== region.spaceId ||
      envelope.shareId !== region.shareId ||
      envelope.keyVersion !== share.currentKeyVersion ||
      isAgentId(envelope.recipientId)
    ) {
      continue;
    }
    let sealer: PublicIdentity;
    try {
      sealer = ctx.trust.require(envelope.sealerId, envelope.sealerKeyVersion);
    } catch {
      continue;
    }
    const bytes = folderKeyEnvelopeBytes(ctx.installationId, envelope);
    if (!keys.owners.writes(sealer) || !verifySignature(sealer, bytes, envelope.signature))
      continue;
    const reach: Reach = envelope.draftKey === null ? 'published' : 'drafts';
    if (rank(reach) > rank(held.get(envelope.recipientId))) held.set(envelope.recipientId, reach);
  }
  return held;
}

/**
 * Make a move the person confirmed (section 10). Within one region it just
 * moves. Across a share boundary it rewraps every record of the subtree,
 * only those of the folders and pages the preview showed, under the
 * destination share's current key version, which must count for writing,
 * or seals each to the space's sealing owners, and sends the move with all
 * of it. Nothing changes until the server takes it whole, so a move that
 * stops part-way leaves everything where it was. A version someone saved
 * meanwhile is wrapped too, and the move sent again. A change of access
 * meanwhile, such as a rotation, a new member or owner, is
 * `permission-version`: preview the move again, since who gains may differ.
 * So is a page or folder added to or deleted from what moves meanwhile,
 * when the server's own tree shows it (`stale-head`); a difference the tree
 * doesn't explain is `binding-mismatch`. `onProgress` hears as each part of
 * the records is wrapped.
 */
export async function moveNode(
  ctx: ClientContext,
  { preview, onProgress }: { preview: MovePreview; onProgress?: Progress },
): Promise<void> {
  const { spaceId, nodeId } = preview;
  const send = (material: Partial<KeyMaterial>) =>
    ctx.api.call(sharingRoutes.move, {
      params: { spaceId, nodeId },
      body: {
        parentId: preview.parentId,
        expectedParentId: preview.fromParentId,
        permissionVersion: preview.permissionVersion,
        parentPermissionVersion: preview.parentPermissionVersion,
        wraps: [],
        keyEnvelopes: [],
        metadataEnvelopes: [],
        ...material,
      },
    });
  if (!preview.crossing) {
    await send({});
    return;
  }
  requireReviewable(preview);
  const rewrap = await rewrapper(ctx, preview);
  await rewrap.scan(onProgress);
  for (let tries = 0; ; tries++) {
    try {
      await send(rewrap.material());
      break;
    } catch (error) {
      // The server refuses wraps for something deleted meanwhile.
      if (
        error instanceof ApiError &&
        error.code === 'binding-mismatch' &&
        (await changedMeanwhile(ctx, preview, {}))
      ) {
        throw previewAgain();
      }
      // Records saved meanwhile are wrapped too, and the move sent again. A
      // node that moved needs no scan to tell; with nothing new, something
      // else changed.
      if (
        !(error instanceof ApiError) ||
        error.code !== 'stale-head' ||
        error.detail.parentId !== undefined ||
        tries >= 4
      ) {
        throw error;
      }
      const before = rewrap.count();
      await rewrap.scan(onProgress);
      if (rewrap.count() === before) throw error;
    }
  }
  forgetSpaces(ctx);
}

type KeyMaterial = {
  wraps: z.input<typeof sharingRoutes.SubjectWrap>[];
  keyEnvelopes: KeyEnvelopeV2[];
  metadataEnvelopes: MetadataEnvelopeV2[];
};

/**
 * The destination's key material for each record of the move, gathered
 * scan by scan: a record already done isn't done again.
 */
async function rewrapper(ctx: ClientContext, preview: MovePreview) {
  const { spaceId, nodeId, to } = preview;
  const keys = await ownerKeys(ctx, spaceId);
  const target = await destinationKeys(ctx, keys, to);
  const done = new Set<string>();
  const out: KeyMaterial = { wraps: [], keyEnvelopes: [], metadataEnvelopes: [] };
  const folders = new Set<string>(preview.folders.map((folder) => folder.id));
  const pages = new Set<string>(preview.pages.map((page) => page.id));
  // One scan of the subtree: wraps what the preview showed and wasn't done,
  // crossing off each node it sees in `unseen`, and stops at a record of a
  // node it didn't show, noting it in `unshown`.
  const scanOnce = async (
    onProgress: Progress | undefined,
    unseen: Set<string>,
    unshown: Set<string>,
  ) => {
    await forEachRecordKey(
      ctx,
      keys,
      spaceId,
      { scope: 'subtree', rootId: nodeId },
      (item, contentKey) => {
        const node = item.kind === 'revision' ? item.record.pageId : item.record.subjectId;
        // Only what the person was shown moves (section 6.7, step 1).
        const shown =
          item.kind === 'revision'
            ? pages.has(node)
            : item.record.subjectKind === 'folder' && folders.has(node);
        if (!shown) {
          unshown.add(node);
          throw new CryptoError('binding-mismatch', 'A record there is outside the preview');
        }
        unseen.delete(node);
        const subject =
          item.kind === 'revision'
            ? revisionWrapSubject(item.record)
            : metadataWrapSubject(item.record);
        const key = `${item.kind}:${subject.versionId}`;
        if (done.has(key)) return;
        done.add(key);
        if (target.kind === 'share') {
          const folderKey = folderKeyOf(target.held, subject.audienceClass);
          if (!folderKey) throw new CryptoError('missing-key', 'No draft key to wrap a draft');
          out.wraps.push({
            subjectKind: item.kind,
            versionId: subject.versionId,
            wrap: wrapContentKey({
              installationId: ctx.installationId,
              subject,
              shareId: target.held.shareId,
              keyVersion: target.held.keyVersion,
              folderKey,
              contentKey,
            }),
          });
          return;
        }
        for (const recipient of target.owners) {
          const grant = { granter: ctx.identity, contentKey, recipient };
          if (item.kind === 'revision') {
            out.keyEnvelopes.push(grantRevisionKeyV2({ ...grant, record: item.record }));
          } else {
            out.metadataEnvelopes.push(grantMetadataKeyV2({ ...grant, record: item.record }));
          }
        }
      },
      { onProgress, from: preview.from },
    );
  };
  return {
    count: () => done.size,
    material: () => out,
    scan: async (onProgress?: Progress) => {
      const unseen = new Set<string>([...folders, ...pages]);
      const unshown = new Set<string>();
      try {
        await scanOnce(onProgress, unseen, unshown);
      } catch (error) {
        // Someone added a page or folder there since the preview.
        if (unshown.size > 0 && (await changedMeanwhile(ctx, preview, { added: unshown }))) {
          throw previewAgain();
        }
        throw error;
      }
      if (unseen.size > 0) {
        // Or deleted one.
        if (await changedMeanwhile(ctx, preview, { gone: unseen })) throw previewAgain();
        throw new CryptoError('binding-mismatch', 'The server left out records of the preview');
      }
    },
  };
}

/**
 * Where moved content's keys go: the destination share's key version to
 * wrap under, the highest that counts for writing and not behind the No
 * going back mark (sections 6.5 and 6.8), or the sealing owners.
 */
async function destinationKeys(
  ctx: ClientContext,
  keys: SpaceKeys,
  to: Region,
): Promise<{ kind: 'share'; held: HeldKeyVersion } | { kind: 'owner'; owners: PublicIdentity[] }> {
  if (to.kind === 'owner') return { kind: 'owner', owners: keys.owners.sealingOwners() };
  const share = (await listShares(ctx, to.spaceId)).find((s) => s.shareId === to.shareId);
  if (!share) throw new CryptoError('missing-key', `The server lists no share ${to.shareId}`);
  const held = writeKeyVersion({
    keyring: ctx.keyring,
    marks: ctx.marks,
    spaceId: to.spaceId,
    shareId: to.shareId,
    writes: keys.owners.writes,
    currentKeyVersion: share.currentKeyVersion,
  });
  return { kind: 'share', held };
}

// Refuse a preview the person couldn't have looked over: a name or title
// this app couldn't open, a page move holding anything but that page, or a
// folder move with a folder or page whose previewed parent folders don't
// lead to what moves. Only folders hold things, so a page counts as moving
// only when its parent is a previewed folder.
function requireReviewable({ nodeId, kind, folders, pages }: MovePreview) {
  for (const folder of folders) {
    if (folder.metadata === null) {
      throw new CryptoError('binding-mismatch', `This app can't open the name of ${folder.id}`);
    }
  }
  for (const page of pages) {
    if (page.title === null) {
      throw new CryptoError('binding-mismatch', `This app can't open the title of ${page.id}`);
    }
  }
  if (kind === 'page') {
    if (folders.length > 0 || pages.length !== 1 || pages[0]?.id !== nodeId) {
      throw new CryptoError('binding-mismatch', 'A page moves alone');
    }
    return;
  }
  const parents = new Map<string, string | null>(folders.map((f) => [f.id, f.parentId]));
  const leads = (folderId: string | null) => {
    for (let at = folderId, steps = 0; at !== null && steps <= parents.size; steps++) {
      if (at === nodeId) return true;
      if (!parents.has(at)) return false;
      at = parents.get(at) ?? null;
    }
    return false;
  };
  if (!parents.has(nodeId)) throw new CryptoError('binding-mismatch', 'The folder isn’t shown');
  for (const node of [...folders, ...pages]) {
    if (node.id !== nodeId && !leads(node.parentId)) {
      throw new CryptoError('binding-mismatch', `${node.id} isn't under what moves`);
    }
  }
}
