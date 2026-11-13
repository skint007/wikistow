// Ending a share (protocol section 6.9, ADR 0012): its records go back to
// the owner region, sealed to the owners, and the share is gone.
import type { sharingRoutes } from '@wikistow/contracts';
import { and, eq, isNotNull, isNull, sql, type AnyColumn } from 'drizzle-orm';
import type { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import {
  agentGrants,
  identities,
  nodes,
  publications,
  shareGroups,
  shareMembers,
  shares,
  spaceOwners,
} from '../db/schema/index.ts';
import { endLapsedWhere, linksIfOnly } from '../public-links/links.ts';
import { subtreeOf } from './access.ts';
import { ContentError } from './errors.ts';
import { loseLiveKeys } from './live.ts';
import { humanActor } from './identities.ts';
import { replaceKeyMaterial, requireOwnerEnvelopes, verifyGrants } from './moves.ts';
import {
  bumpPermissions,
  lockSpaceForUpdate,
  nodesUnder,
  recordsWrappedUnder,
  requireOwner,
  requirePermissionVersion,
  requireShare,
  rootPermissionVersion,
} from './sharing.ts';
import type { ReportUnreadable } from './stored.ts';
import { requireIdentity } from './structure.ts';

type Ending = z.output<typeof sharingRoutes.endShare.body>;

/**
 * End a share (section 6.9, step 3). The envelopes' signatures are checked
 * before the lock, as a move's are. Then, under a lock on the space, so no
 * write, rotation or move lands meanwhile:
 * - the share is still there (`not-found`, so a request sent again after
 *   its answer was lost finds it gone), and the caller owns its space;
 * - its root isn't in the trash (`forbidden`): restore it first, or delete
 *   it for good, which ends the share anyway;
 * - the root's permission version, or the space's, is current
 *   (`permission-version`), so a change of access or owners since the
 *   preview is previewed again;
 * - every record wrapped under the share, but a copy's hidden nodes', its
 *   comments included, has exactly one envelope to each current owner,
 *   granted by the caller
 *   (`recipients-mismatch`, `bad-signature`). One left without is
 *   `stale-head`, and so is an envelope for a record no longer wrapped
 *   under the share: the app scans again.
 * Then the share goes, with its members, groups' access, agents' picks,
 * folder key envelopes and wraps, by cascade; the envelopes are stored; the
 * public links and copies of people who can't publish their page any more
 * end; and permission versions move on. Deleting the share's row tells the
 * live tree. All or nothing.
 */
export async function endShare(
  db: Database,
  input: { accountId: string; shareId: string } & Ending,
  report: ReportUnreadable,
): Promise<void> {
  const { spaceId } = await requireShare(db, input.shareId);
  // An envelope for a record gone since the scan, such as a folder's name
  // deleted for good from the trash, means the app scans again.
  const changed = new ContentError('stale-head', 'The share changed since you loaded it');
  await verifyGrants(db, { actor: humanActor(input.accountId), spaceId, ...input }, report, {
    missing: changed,
  });
  await db.transaction(async (tx) => {
    const identity = await requireIdentity(tx, input.accountId);
    await lockSpaceForUpdate(tx, spaceId);
    const share = await requireShare(tx, input.shareId);
    await requireOwner(tx, identity, share.spaceId);
    if (share.rootId !== null) {
      const [root] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.id, share.rootId), isNotNull(nodes.trashId)));
      if (root) throw new ContentError('forbidden', 'Restore the folder from the trash first');
    }
    requirePermissionVersion(
      await rootPermissionVersion(tx, spaceId, share.rootId),
      input.permissionVersion,
    );
    const records = await recordsWrappedUnder(tx, spaceId, share.id);
    await requireOwnerEnvelopes(tx, input, records, {
      spaceId,
      identity,
      report,
      elsewhere: changed,
    });

    // Who loses access, by ID, for the audit log, before it cascades away.
    const members = await tx
      .select({ id: shareMembers.identityId })
      .from(shareMembers)
      .where(eq(shareMembers.shareId, share.id))
      .orderBy(shareMembers.identityId);
    const agents = await tx
      .selectDistinct({ id: agentGrants.agentId })
      .from(agentGrants)
      .where(eq(agentGrants.shareId, share.id))
      .orderBy(agentGrants.agentId);
    const groups = await tx
      .select({ id: shareGroups.groupId })
      .from(shareGroups)
      .where(eq(shareGroups.shareId, share.id))
      .orderBy(shareGroups.groupId);
    const subtree = await nodesUnder(tx, spaceId, share.rootId);

    await tx.delete(shares).where(eq(shares.id, share.id));
    await replaceKeyMaterial(tx, { wraps: [], ...input }, records);
    // Judged now the share is gone, as a rotation judges after it (ADR 0005, decision 8).
    await endLapsedWhere(tx, { spaceId, under: share.rootId }, input.accountId);
    await loseLiveKeys(tx, spaceId, subtree);
    await bumpPermissions(tx, spaceId, subtree);
    await audit(tx, {
      actor: input.accountId,
      action: 'share.ended',
      target: { kind: 'share', id: share.id },
      details: {
        spaceId,
        rootId: share.rootId,
        members: members.map((row) => row.id),
        agents: agents.map((row) => row.id),
        groups: groups.map((row) => row.id),
        records: records.revision.length + records.metadata.length + records.comment.length,
      },
    });
  });
}

/**
 * What ending a share would end and keep, for an owner's preview (section
 * 6.9, step 1), of the pages under its root, but those in the trash: each
 * public link, ending unless an owner turned it on; the pages with a live
 * publication into another space; and those that are a live one from
 * another space, once their first version has arrived.
 */
export async function shareEnding(db: Database, accountId: string, shareId: string) {
  const identity = await requireIdentity(db, accountId);
  const share = await requireShare(db, shareId);
  const { spaceId, rootId } = share;
  await requireOwner(db, identity, spaceId);
  // Once the share is gone, only the owners can publish there.
  const owners = await db
    .selectDistinct({ accountId: identities.accountId })
    .from(spaceOwners)
    .innerJoin(identities, eq(identities.id, spaceOwners.identityId))
    .where(and(eq(spaceOwners.spaceId, spaceId), isNull(spaceOwners.removedAt)));
  const links = await linksIfOnly(
    db,
    { spaceId, under: rootId },
    new Set(owners.map((owner) => owner.accountId)),
  );
  const under = (column: AnyColumn) =>
    sql`${column} in (${subtreeOf(spaceId, rootId)} select id from subtree)`;
  const from = await db
    .selectDistinct({ pageId: publications.sourcePageId })
    .from(publications)
    .where(
      and(
        eq(publications.sourceSpaceId, spaceId),
        isNull(publications.detachedAt),
        under(publications.sourcePageId),
      ),
    )
    .orderBy(publications.sourcePageId);
  const into = await db
    .select({ pageId: publications.destinationPageId })
    .from(publications)
    .where(
      and(
        eq(publications.destinationSpaceId, spaceId),
        isNull(publications.detachedAt),
        isNotNull(publications.lastSourceRevisionId),
        under(publications.destinationPageId),
      ),
    )
    .orderBy(publications.destinationPageId);
  return {
    links,
    publishedFrom: from.map((row) => row.pageId),
    publishedInto: into.map((row) => row.pageId),
  };
}
