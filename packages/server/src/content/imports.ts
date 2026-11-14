import type { importRoutes } from '@wikistow/contracts';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Database } from '../db/client.ts';
import { nodes, pageHeads, spaces } from '../db/schema/index.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import { lockShare, lockSpace, shareAt, type ShareRow } from './access.ts';
import { ContentError } from './errors.ts';
import type { Actor } from './identities.ts';
import { createPage, publish, saveDraft } from './pages.ts';
import { createFolder } from './structure.ts';

type Batch = z.output<typeof importRoutes.batch.body>;

/**
 * An import's batch (`importRoutes.batch`) in `spaceId`, as one change:
 * its folders made, in order, then each page made, saved and published, in
 * order. Each step is its own route's change, run in a savepoint of this
 * transaction, so it makes every check that change makes, under the same
 * locks, and the first refusal undoes the whole batch. A retry with the
 * same `once` is answered as the first was. A page listed twice is
 * `invalid-request`, and one already there that isn't in `spaceId` is
 * `not-found`. The heads of each page once its steps are done.
 */
export async function importBatch(
  db: Database,
  input: {
    actor: Actor;
    spaceId: string;
    storageBytes: number;
    maxPages?: number;
    maxFolders?: number;
    once?: Once | undefined;
  } & Batch,
) {
  const { actor, spaceId, storageBytes, maxPages, maxFolders } = input;
  const pageIds = input.pages.map((page) => page.pageId);
  if (new Set(pageIds).size !== pageIds.length) {
    throw new ContentError('invalid-request', 'A page is listed twice');
  }
  const limits = {
    ...(maxPages === undefined ? {} : { maxPages }),
    ...(maxFolders === undefined ? {} : { maxFolders }),
  };
  return transactOnce(db, input.once, async (tx) => {
    await holdForBatch(tx, input);
    for (const folder of input.folders) {
      await createFolder(tx, { actor, spaceId, storageBytes, ...limits, ...folder });
    }
    const pages = [];
    for (const { pageId, create, draft, publish: published } of input.pages) {
      if (create)
        await createPage(tx, { actor, spaceId, pageId, storageBytes, ...limits, ...create });
      if (draft) await saveDraft(tx, { actor, pageId, storageBytes, restoredFrom: null, ...draft });
      if (published) await publish(tx, { actor, pageId, storageBytes, ...published });
      const [heads] = await tx
        .select({ draftHead: pageHeads.draftHead, publishedHead: pageHeads.publishedHead })
        .from(pageHeads)
        .where(eq(pageHeads.pageId, pageId));
      // Each step leaves the page a draft, or refuses it.
      if (!heads?.draftHead) throw new ContentError('not-found');
      pages.push({ pageId, draftHead: heads.draftHead, publishedHead: heads.publishedHead });
    }
    return { folders: input.folders.map((folder) => folder.folderId), pages };
  });
}

/**
 * Hold, before any step, what the batch's steps hold for the nodes already
 * there, each in the mode its step takes: the space, then the shares they
 * are in, then the space's row if something goes at its top, then the
 * folders things go in and the pages saved or published. Shares and nodes
 * go in ID order, shares first, as a delete or a rotation takes them, so
 * two batches, or a batch and one of those, never each wait on what the
 * other holds. Each step then takes its locks again, which it holds
 * already. A page already there must be in `spaceId`.
 */
async function holdForBatch(
  tx: Database,
  { spaceId, folders, pages }: { spaceId: string } & Batch,
) {
  await lockSpace(tx, spaceId);
  const made = new Set<string>([
    ...folders.map((folder) => folder.folderId),
    ...pages.flatMap((page) => (page.create ? [page.pageId] : [])),
  ]);
  const parentIds: (string | null)[] = [
    ...folders.map((folder) => folder.parentId),
    ...pages.flatMap((page) => (page.create ? [page.create.parentId] : [])),
  ];
  const atTop = parentIds.includes(null);
  const parents = new Set(parentIds.filter((id): id is string => id !== null && !made.has(id)));
  const written = new Set<string>(pages.flatMap((page) => (page.create ? [] : [page.pageId])));

  const shares = new Map<string, ShareRow>();
  for (const nodeId of [...(atTop ? [null] : []), ...parents, ...written]) {
    const share = await shareAt(tx, spaceId, nodeId);
    if (share) shares.set(share.id, share);
  }
  for (const id of [...shares.keys()].sort(byId)) await lockShare(tx, shares.get(id) ?? null);
  if (atTop) {
    await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .for('no key update');
  }
  for (const id of [...parents, ...written].sort(byId)) {
    const query = tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.spaceId, spaceId)));
    // As `createPage` and `createFolder` hold a parent, and a save or publish its page.
    const [held] = parents.has(id) ? await query.for('no key update') : await query.for('share');
    if (!held && written.has(id)) throw new ContentError('not-found');
  }
}

// Code-unit order, as Postgres sorts IDs (their characters are ASCII).
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
