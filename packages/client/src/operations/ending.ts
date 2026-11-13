// Ending a share (protocol section 6.9, ADR 0012): the owner's app seals
// every record wrapped under the share to the space's owners, as a move into
// the owner region does, without moving anything, and sends it all at once.
// The server deletes the share, and this app marks it ended in its No going
// back marks, so it never writes under it again.
import {
  groupRoutes,
  sharingRoutes,
  structureRoutes,
  type FolderId,
  type GroupId,
  type IdentityId,
  type KeyEnvelopeV2,
  type MetadataEnvelopeV2,
  type PageId,
  type ShareId,
  type SpaceId,
} from '@wikistow/contracts';
import { sendShareChange } from './share-changes.ts';
import { ApiError, outcomeUnknown } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { isAgentId } from '../identity.ts';
import { ENDED, requireNotBehind } from '../key-versions.ts';
import { grantMetadataKeyV2 } from '../metadata.ts';
import type { Region } from '../regions.ts';
import { grantRevisionKeyV2 } from '../revision.ts';
import { forgetSpaces } from './keys.ts';
import { audienceOf } from './moves.ts';
import { treeTarget } from './records.ts';
import type { ClientContext } from './session.ts';
import { forEachRecordKey, listShares, ownerKeys, subjectOf, type Progress } from './sharing.ts';

/** An ending worked out for the owner to confirm (section 6.9, step 1). */
export type EndingPreview = {
  spaceId: SpaceId;
  shareId: ShareId;
  /** The share's root folder, or null for the space share. */
  rootId: FolderId | null;
  /** The permission version of the root, or of the space, which the ending carries. */
  permissionVersion: number;
  /** The share's current key version, which the ending is pending from (section 6.8). */
  keyVersion: number;
  /**
   * The people who lose access, but the owners: those holding the share's
   * current keys by envelopes this app verified, and the members the server
   * lists. Agents follow their people, and are in `agents`.
   */
  people: IdentityId[];
  /** The space's groups that have the share. The groups themselves stay. */
  groups: GroupId[];
  /** Agents with a pick or a group in the share, by the names the server lists. */
  agents: sharingRoutes.ShareAgent[];
  /** The pages under the root with a public link, and whether it ends. */
  links: { pageId: PageId; ends: boolean }[];
};

/**
 * Work out ending `shareId` for the owner to confirm. Nothing is sealed or
 * sent. Refuses a share the server no longer lists (`not-found`), one
 * rooted in the trash (`forbidden`: restore it first), and one this app
 * ended already that a server lists again (`key-version`).
 */
export async function previewEnding(
  ctx: ClientContext,
  { spaceId, shareId }: { spaceId: SpaceId; shareId: ShareId },
): Promise<EndingPreview> {
  await ctx.marks.refresh?.();
  const keys = await ownerKeys(ctx, spaceId);
  const share = (await listShares(ctx, spaceId)).find((s) => s.shareId === shareId);
  if (!share) throw new ApiError(404, 'not-found', 'That folder isn’t shared any more');
  // An ended share is marked above every key version.
  requireNotBehind({ marks: ctx.marks, spaceId, shareId, keyVersion: share.currentKeyVersion });
  // The tree lists nothing in the trash.
  const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
  const { rootId } = share;
  if (rootId !== null && !tree.folders.some((f) => f.id === rootId)) {
    throw new ApiError(403, 'forbidden', 'Restore the folder from the trash first');
  }
  const owners = new Set<string>([
    ...keys.listed.map((owner) => owner.identity.id),
    ...keys.owners.sealingOwners().map((owner) => owner.id),
  ]);
  const holders = await audienceOf(ctx, keys, { kind: 'share', spaceId, shareId });
  const people = [
    ...new Set([...holders.keys(), ...share.members.map((m) => m.identityId)]),
  ].filter((id) => !owners.has(id) && !isAgentId(id));
  const { groups } = await ctx.api.call(groupRoutes.listGroups, { params: { spaceId } });
  const { links } = await ctx.api.call(sharingRoutes.shareEnding, { params: { shareId } });
  const { permissionVersion } = await treeTarget(ctx, spaceId, rootId);
  return {
    spaceId,
    shareId,
    rootId,
    permissionVersion,
    keyVersion: share.currentKeyVersion,
    people,
    groups: groups.filter((g) => g.shares.some((s) => s.shareId === shareId)).map((g) => g.groupId),
    agents: [...new Map(share.agents.map((a) => [a.agentId, a])).values()].map(
      ({ agentId, personId, name }) => ({ agentId, personId, name }),
    ),
    links,
  };
}

/**
 * A record under the share that this app can't open, such as a version
 * saved with a wrap that fails its checks, which stops the ending. Its
 * owner deletes that page or folder for good to get past it.
 */
export class UnreadableInShare extends Error {
  readonly nodeId: string;

  constructor(nodeId: string, failure: CryptoError) {
    super(`This app can't open a record of ${nodeId}`, { cause: failure });
    this.nodeId = nodeId;
  }
}

// The failures that mean the record itself is bad, which only deleting it
// gets past. Others, such as a key change to review or a newer format, have
// their own way out.
const BROKEN = new Set<CryptoError['code']>([
  'key-commitment',
  'decrypt-failed',
  'hash-mismatch',
  'bad-signature',
  'wrong-recipient',
]);

/** What an ending did. */
export type Ended = {
  /** Whether the trash holds anything from the share, which now restores to the owners. */
  fromTrash: boolean;
};

/**
 * End a share the owner confirmed (section 6.9, steps 2 and 3): scan every
 * record wrapped under it, open each one's content key and seal it to every
 * sealing owner in v2 envelopes, then send it all at once. A version saved
 * meanwhile, or a record gone since, is `stale-head`: scan again, seal what
 * is new, drop what the scan no longer lists, and send again. A change of
 * access meanwhile is `permission-version`: preview it again. A request
 * whose answer was lost is sent again, and a share the server then no
 * longer lists counts as ended. Once ended, this app's No going back mark
 * for the share is `ENDED`.
 */
export async function endShare(
  ctx: ClientContext,
  { preview, onProgress }: { preview: EndingPreview; onProgress?: Progress },
): Promise<Ended> {
  const { spaceId, shareId } = preview;
  const keys = await ownerKeys(ctx, spaceId);
  const owners = keys.owners.sealingOwners();
  const from: Region = { kind: 'share', spaceId, shareId };
  // Each record's envelopes, by its kind and version.
  const sealed = new Map<
    string,
    {
      node: string;
      keyEnvelopes: KeyEnvelopeV2[];
      metadataEnvelopes: MetadataEnvelopeV2[];
      commentEnvelopes: MetadataEnvelopeV2[];
    }
  >();
  // Returns whether anything changed since the last scan.
  const scan = async () => {
    const seen = new Set<string>();
    let added = 0;
    let unreadable: string | null = null;
    await forEachRecordKey(
      ctx,
      keys,
      spaceId,
      { scope: 'share', shareId },
      (item, contentKey) => {
        const subject = subjectOf(item);
        const key = `${item.kind}:${subject.versionId}`;
        seen.add(key);
        if (sealed.has(key)) return;
        added += 1;
        const out = {
          node:
            item.kind === 'revision'
              ? item.record.pageId
              : item.kind === 'comment'
                ? item.pageId
                : item.record.subjectId,
          keyEnvelopes: [] as KeyEnvelopeV2[],
          metadataEnvelopes: [] as MetadataEnvelopeV2[],
          commentEnvelopes: [] as MetadataEnvelopeV2[],
        };
        for (const recipient of owners) {
          const grant = { granter: ctx.identity, contentKey, recipient };
          if (item.kind === 'revision') {
            out.keyEnvelopes.push(grantRevisionKeyV2({ ...grant, record: item.record }));
          } else if (item.kind === 'comment') {
            out.commentEnvelopes.push(grantMetadataKeyV2({ ...grant, record: item.record }));
          } else {
            out.metadataEnvelopes.push(grantMetadataKeyV2({ ...grant, record: item.record }));
          }
        }
        sealed.set(key, out);
      },
      { onProgress, from, onUnreadable: (nodeId) => (unreadable = nodeId) },
    ).catch((error: unknown) => {
      throw unreadable !== null && error instanceof CryptoError && BROKEN.has(error.code)
        ? new UnreadableInShare(unreadable, error)
        : error;
    });
    let dropped = 0;
    for (const key of sealed.keys()) {
      if (!seen.has(key)) {
        sealed.delete(key);
        dropped += 1;
      }
    }
    return added + dropped > 0;
  };
  const send = () => {
    const all = [...sealed.values()];
    return ctx.api.call(sharingRoutes.endShare, {
      params: { shareId },
      body: {
        permissionVersion: preview.permissionVersion,
        keyEnvelopes: all.flatMap((s) => s.keyEnvelopes),
        metadataEnvelopes: all.flatMap((s) => s.metadataEnvelopes),
        commentEnvelopes: all.flatMap((s) => s.commentEnvelopes),
      },
    });
  };

  await scan();
  // The ending is pending until answered (section 6.8): no tab joins or
  // sends in the share's live sessions meanwhile.
  const sendUntilAnswered = async () => {
    let lost = false;
    for (let tries = 0; ; tries++) {
      try {
        await send();
        return;
      } catch (error) {
        if (!(error instanceof ApiError) || tries >= 4) throw error;
        // Sent again after a lost answer: the first one may have ended it.
        if (error.code === 'not-found' && lost) {
          const listed = await listShares(ctx, spaceId);
          if (listed.some((s) => s.shareId === shareId)) throw error;
          return;
        }
        if (outcomeUnknown(error) || error.code === 'request-timeout') {
          lost = true;
          continue;
        }
        // Saved or gone since the scan; with nothing new, something else changed.
        if (error.code !== 'stale-head' || !(await scan())) throw error;
      }
    }
  };
  await sendShareChange(
    ctx,
    [{ spaceId, shareId, change: 'ending', fromKeyVersion: preview.keyVersion }],
    sendUntilAnswered,
    () => [{ spaceId, shareId, keyVersion: ENDED }],
  );
  forgetSpaces(ctx);
  // The tree lists nothing in the trash, so what it doesn't list came from
  // there. It is only a hint: the share has ended whether or not it loads.
  const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId } }).catch(() => null);
  if (!tree) return { fromTrash: false };
  const listed = new Set<string>([
    spaceId,
    ...tree.folders.map((f) => f.id),
    ...tree.pages.map((p) => p.id),
  ]);
  return { fromTrash: [...sealed.values()].some(({ node }) => !listed.has(node)) };
}
