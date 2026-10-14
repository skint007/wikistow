import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { keyEnvelopes, nodes, revisions, spaces } from '../db/schema/index.ts';
import { shareAt } from './access.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DRAFT_RETENTION_MS = 30 * DAY_MS;

/** Pages found, and checkpoints removed, per round: no query or transaction grows with the data. */
const PAGE_BATCH = 100;
const REVISION_BATCH = 1000;

/**
 * Old draft checkpoints nothing needs, as `r`: older than `cutoff`, and
 * with no draft saved on top since (an abandoned branch has none). Work
 * still building on one finds it until then: an open editor's next save is
 * `stale-head`, and an agent's retried change, built on the head when it
 * was journaled and saved over (by itself, if it landed) only after, finds
 * its base. Kept besides: the draft head; every draft a published version
 * was made from; and every draft a copy in another space was sent from, as
 * the copy's "Published from" label opens it. A page with copies sent before
 * the server recorded their sources keeps every draft, since those name
 * theirs only inside ciphertext.
 */
const removable = (cutoff: Date) => sql`
  r.audience = 'draft' and r.created_at < ${cutoff.toISOString()}
  and not exists (select 1 from page_heads h where h.page_id = r.page_id and h.draft_head = r.id)
  and not exists (select 1 from revisions c
    where c.audience = 'draft' and c.based_on = r.id and c.created_at >= ${cutoff.toISOString()})
  and not exists (select 1 from revisions p
    where p.audience = 'published' and p.based_on = r.id)
  and not exists (select 1 from revisions c where c.source_revision_id = r.id)
  and not exists (select 1 from publications s
    join revisions c on c.page_id = s.destination_page_id
    where s.source_page_id = r.page_id and c.audience = 'published'
      and c.based_on is null and c.source_revision_id is null)`;

/**
 * Remove draft checkpoints saved over more than `retentionMs` ago (issue
 * #8). Autosave leaves one per save on a single chain per page, and no app
 * walks it: history lists published versions and checks their signed
 * `basedOn` without fetching it; saves, publishes and moves use only the
 * head; a restore reads the published version. So the middle of the chain
 * can go. Published versions are never removed, and nothing signed is
 * rewritten.
 *
 * Pages with something to remove are found by one query a batch at a time.
 * Each is checked again under the space/share/node locks writes take, in
 * their order, so a save waits for it. Staged uploads name a page, not a
 * revision; restore sources are published; a send holds the source node
 * until its copy, which names its source, commits; a move, share or new
 * owner whose key material names a checkpoint removed meanwhile is
 * `stale-head` (`uncovered`), so the app reloads. Wraps and blob references
 * cascade with the revision, and envelopes go with it in the same
 * transaction. Unused blob bytes go later, in sweepBlobs.
 */
export async function sweepDrafts(
  db: Database,
  { retentionMs = DEFAULT_DRAFT_RETENTION_MS } = {},
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionMs);
  const old = removable(cutoff);
  let removed = 0;
  let after = '';
  for (;;) {
    const pages = await db.execute<{ page_id: string; space_id: string }>(sql`
      select distinct on (r.page_id) r.page_id, r.space_id from revisions r
      where ${old} and r.page_id > ${after}
      order by r.page_id limit ${PAGE_BATCH}`);
    const last = pages.at(-1);
    if (!last) return removed;
    for (const { page_id: pageId, space_id: spaceId } of pages) {
      // A page with more than a batch goes in several transactions.
      for (;;) {
        const count = await compactPage(db, spaceId, pageId, old);
        removed += count;
        if (count < REVISION_BATCH) break;
      }
    }
    after = last.page_id;
  }
}

async function compactPage(
  db: Database,
  spaceId: string,
  pageId: string,
  old: ReturnType<typeof removable>,
) {
  return db.transaction(async (tx) => {
    const [space] = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .for('key share');
    if (!space) return 0;
    await shareAt(tx, spaceId, pageId, { lock: 'share' });
    const [page] = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, pageId), eq(nodes.spaceId, spaceId)))
      .for('update');
    if (!page) return 0;
    const ids = (
      await tx.execute<{ id: string }>(sql`
        select r.id from revisions r where r.page_id = ${pageId} and ${old}
        limit ${REVISION_BATCH}`)
    ).map((row) => row.id);
    if (ids.length === 0) return 0;
    await tx
      .delete(keyEnvelopes)
      .where(and(eq(keyEnvelopes.subjectKind, 'revision'), inArray(keyEnvelopes.subjectId, ids)));
    await tx.delete(revisions).where(inArray(revisions.id, ids));
    return ids.length;
  });
}
