import type { importRoutes } from '@wikistow/contracts';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { anyId } from '../db/any.ts';
import type { Database } from '../db/client.ts';
import { nodes, pageHeads, spaces } from '../db/schema/index.ts';
import { transactOnce, type Once } from '../idempotency.ts';
import { accessTo, canEdit, lockShare, lockSpace, type ShareRow } from './access.ts';
import { ContentError } from './errors.ts';
import { requireCaller, type Actor } from './identities.ts';
import { createPage, publish, saveDraft } from './pages.ts';
import { queueWriter } from './quota.ts';
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
 * `not-found`, as is an empty batch, which says nothing of the space. The heads of each page once its steps are done.
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
  if (input.folders.length + input.pages.length === 0) throw new ContentError('not-found');
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
 * there that the caller may edit, each in the mode its step takes: the
 * caller's place in their account's queue of writes (`queueWriter`), the
 * space, then the shares they are in, then the space's row if something
 * goes at its top, then the folders things go in and the pages saved or
 * published, one a create sent again made too, then those pages' heads.
 * Shares and nodes go in ID order, shares first, as a delete or a rotation
 * takes them, so two batches, or a batch and one of those, never each wait
 * on what the other holds; and every page's heads before the account's
 * storage, which the first step to store a version takes. Each step then
 * takes its locks again, which it holds already. One the caller may not
 * edit is held by nothing here: its step refuses it, as its own route
 * would. A page saved or published that isn't made must be in
 * `spaceId`.
 */
async function holdForBatch(
  tx: Database,
  { actor, spaceId, folders, pages }: { actor: Actor; spaceId: string } & Batch,
) {
  const caller = await requireCaller(tx, actor);
  await queueWriter(tx, caller.accountId);
  await lockSpace(tx, spaceId);
  const made = new Set<string>([
    ...folders.map((folder) => folder.folderId),
    ...pages.flatMap((page) => (page.create ? [page.pageId] : [])),
  ]);
  const parentIds: (string | null)[] = [
    ...folders.map((folder) => folder.parentId),
    ...pages.flatMap((page) => (page.create ? [page.create.parentId] : [])),
  ];
  const parents = new Set(parentIds.filter((id) => id === null || !made.has(id)));
  const saved = new Set<string>(pages.flatMap((page) => (page.create ? [] : [page.pageId])));
  if (saved.size > 0) {
    const here = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(anyId(nodes.id, [...saved]), eq(nodes.spaceId, spaceId)));
    if (here.length !== saved.size) throw new ContentError('not-found');
  }
  // A create sent again for a page it made (`replayed` in `createPage`)
  // holds nothing of the page, but a save or publish on top of it holds it
  // as any other's does (#479). One made elsewhere is its create's to refuse.
  const savedOnCreate = pages.flatMap((page) =>
    page.create && (page.draft || page.publish) ? [page.pageId] : [],
  );
  const remade =
    savedOnCreate.length === 0
      ? []
      : await tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(
            and(anyId(nodes.id, savedOnCreate), eq(nodes.spaceId, spaceId), eq(nodes.kind, 'page')),
          );
  const written = new Set<string>([...saved, ...remade.map((page) => page.id)]);

  const shares = new Map<string, ShareRow>();
  const editable: string[] = [];
  let atTop = false;
  for (const nodeId of [...parents, ...written]) {
    const access = await accessTo(tx, caller, { spaceId, nodeId });
    if (!access || !canEdit(access)) continue;
    if (access.share) shares.set(access.share.id, access.share);
    if (nodeId === null) atTop = true;
    else editable.push(nodeId);
  }
  for (const id of [...shares.keys()].sort(byId)) await lockShare(tx, shares.get(id) ?? null);
  if (atTop) {
    await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.id, spaceId))
      .for('no key update');
  }
  editable.sort(byId);
  for (const id of editable) {
    const query = tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.id, id), eq(nodes.spaceId, spaceId)));
    // As `createPage` and `createFolder` hold a parent, and a save or publish its page.
    if (written.has(id)) await query.for('share');
    else await query.for('no key update');
  }
  for (const id of editable.filter((id) => written.has(id))) {
    await tx.select().from(pageHeads).where(eq(pageHeads.pageId, id)).for('update');
  }
}

// Code-unit order, as Postgres sorts IDs (their characters are ASCII).
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
