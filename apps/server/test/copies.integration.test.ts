// Copies of pages and folders, and moves into another space (protocol
// section 10, "Copies, and moves between spaces"): what arrives, who may
// make one, what is refused, what a move ends, and the hidden nodes
// nobody else sees until the copy finishes.
import {
  moveOperations as moves,
  ownerOperations as owners,
  pageOperations as pages,
  PageId as PageIdSchema,
  publicationOperations as pubs,
  publicLinkOperations as links,
  sharingOperations as sharing,
  spaceOperations,
  utf8,
  type FolderId,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { copyRoutes, pageRoutes, publicationRoutes } from '@wikistow/contracts';
import { fileBlobStore, schema, sweepBlobs, sweepDrafts } from '@wikistow/server';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { z } from 'zod';
import { enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { copyAll, openCopy } from './support/copies.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { ABOVE, draftHead, find, invite, library, shareFolder } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Alice's library (`library`: a folder above a shared folder holding a page
 * published with an attachment, and a newer draft; a private page beside
 * it), its shared folder edited by Bob and read by Erin; and her board,
 * another space whose folder Pinned Carol reads and Dave edits and
 * publishes in. Bob and Erin have spaces of their own.
 */
async function world() {
  const [alice, bob, carol, dave, erin] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(alice);
  const { page } = lib;
  const map = await pages.uploadAttachment(alice.ctx, page, {
    name: 'map.txt',
    mediaType: 'text/plain',
    bytes: utf8('the map of the source'),
  });
  await pages.editDraft(alice.ctx, page, { markdown: 'published words', attachments: [map] });
  await pages.publishPage(alice.ctx, page);
  await pages.editDraft(alice.ctx, page, { markdown: 'draft words' });
  const libShare = await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, bob, 'editor'), await invite(alice, erin, 'reader')],
  });
  const board = await spaceOperations.createSpace(alice.ctx, { name: 'Board' });
  const pinned = await spaceOperations.createFolder(alice.ctx, {
    spaceId: board,
    parentId: null,
    name: 'Pinned',
  });
  const boardShare = await shareFolder(alice.ctx, {
    spaceId: board,
    rootId: pinned,
    people: [await invite(alice, carol, 'reader'), await invite(alice, dave, 'editor', true)],
  });
  const own = async (person: typeof bob) =>
    spaceOperations.createSpace(person.ctx, { name: 'Mine' });
  return {
    alice,
    bob,
    carol,
    dave,
    erin,
    lib,
    page,
    libShare,
    board,
    pinned,
    boardShare,
    bobs: await own(bob),
    erins: await own(erin),
  };
}

const at = (spaceId: SpaceId, pageId: string) => ({
  spaceId,
  pageId: PageIdSchema.parse(pageId),
});

/** A page's current draft or published text, as `ctx` opens it. */
async function textOf(
  ctx: Parameters<typeof pages.loadPage>[0],
  page: { spaceId: SpaceId; pageId: PageId },
  audience: 'draft' | 'published',
) {
  const { heads } = await pages.loadPage(ctx, page.pageId);
  const head = audience === 'draft' ? heads.draftHead : heads.publishedHead;
  if (!head) return null;
  const { opened } = await pages.openRevisionOf(ctx, page, audience, head);
  return opened.kind === 'current' ? opened.payload : null;
}

const nodeRow = async (id: string) =>
  (await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, id)))[0] ?? null;

const copyRow = async (id: string) =>
  (await t.db.select().from(schema.copies).where(eq(schema.copies.id, id)))[0] ?? null;

/** A refusal's code and detail, or null if `promise` resolved. */
const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string; detail?: { nodeIds?: string[] } }) => error,
  );

const DAYS_AGO_2 = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

describe('copying', () => {
  it('copies a page into another space, its draft and publication with their files', async () => {
    const w = await world();
    const copy = await copyAll(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned,
    });
    const made = at(w.board, copy.newIdOf(w.page.pageId));

    // Readers there read the publication, and its file.
    const published = await textOf(w.carol.ctx, made, 'published');
    expect(published?.markdown).toBe('published words');
    const [map] = published?.attachments ?? [];
    if (!map) throw new Error('expected the map');
    expect(text(await pages.readAttachment(w.carol.ctx, made, 'published', map))).toBe(
      'the map of the source',
    );
    // Editors there read the draft; it is a first version, nobody's successor.
    expect((await textOf(w.dave.ctx, made, 'draft'))?.markdown).toBe('draft words');
    const stored = await t.db
      .select({ basedOn: schema.revisions.basedOn, from: schema.revisions.sourceRevisionId })
      .from(schema.revisions)
      .where(eq(schema.revisions.pageId, made.pageId));
    expect(stored.map((r) => r.basedOn)).toEqual([null, null]);
    // Its sources are the copy's own business: draft retention keeps none for it.
    expect(stored.map((r) => r.from)).toEqual([null, null]);
    expect((await pages.loadHistory(w.carol.ctx, made)).length).toBe(1);

    // The source is as it was.
    expect((await textOf(w.alice.ctx, w.page, 'draft'))?.markdown).toBe('draft words');
    const [event] = await t.db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.action, 'node.copied'),
          eq(schema.auditEvents.targetId, w.page.pageId),
        ),
      );
    expect(event?.details).toEqual({
      spaceId: w.lib.spaceId,
      toSpaceId: w.board,
      nodeId: made.pageId,
      nodes: 1,
    });
  });

  it('copies a folder with everything under it, into another space or its own', async () => {
    const w = await world();
    const copy = await copyAll(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.lib.above,
      to: w.board,
      parentId: null,
    });
    const tree = await spaceOperations.loadStructure(w.alice.ctx, w.board);
    const above = tree.folders.find((f) => f.id === copy.newIdOf(w.lib.above));
    const shared = tree.folders.find((f) => f.id === copy.newIdOf(w.lib.shared));
    expect(above?.parentId).toBeNull();
    expect(above?.metadata?.opened.kind === 'current' && above.metadata.opened.metadata.name).toBe(
      ABOVE,
    );
    expect(shared?.parentId).toBe(above?.id);
    expect(tree.pages.find((p) => p.id === copy.newIdOf(w.page.pageId))?.parentId).toBe(shared?.id);
    expect(tree.pages.find((p) => p.id === copy.newIdOf(w.lib.beside.pageId))?.parentId).toBe(
      above?.id,
    );

    // Within its own space, beside where it is, in batches of one.
    const again = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.lib.spaceId,
      parentId: null,
    });
    await again.open();
    await again.send(undefined, 1);
    await again.finish();
    const lib = await spaceOperations.loadStructure(w.alice.ctx, w.lib.spaceId);
    expect(lib.folders.find((f) => f.id === again.newIdOf(w.lib.shared))?.parentId).toBeNull();
    expect(lib.folders.find((f) => f.id === w.lib.shared)?.parentId).toBe(w.lib.above);
    const made = at(w.lib.spaceId, again.newIdOf(w.page.pageId));
    expect((await textOf(w.alice.ctx, made, 'published'))?.markdown).toBe('published words');
  });

  it('is for editors of the source, and agents within their picks; moves are for owners', async () => {
    const w = await world();
    const options = { from: w.lib.spaceId, nodeId: w.page.pageId };
    // Erin reads the folder: no copy.
    const erins = await openCopy(w.erin.ctx, { ...options, to: w.erins, parentId: null });
    expect(await rejection(erins.open())).toBe('forbidden');
    // Bob edits it: a copy, but no move, since he doesn't own the space.
    const bobs = await openCopy(w.bob.ctx, { ...options, to: w.bobs, parentId: null });
    await bobs.open();
    await bobs.send();
    await bobs.finish();
    expect(
      (await textOf(w.bob.ctx, at(w.bobs, bobs.newIdOf(w.page.pageId)), 'draft'))?.markdown,
    ).toBe('draft words');
    const move = await openCopy(w.bob.ctx, {
      ...options,
      kind: 'move',
      to: w.bobs,
      parentId: null,
    });
    expect(await rejection(move.open())).toBe('forbidden');
    // And not into a folder where he can't make pages.
    const there = { ...bobs.opening, copyId: 'bob-to-board', destinationSpaceId: w.board };
    expect(
      await rejection(
        w.bob.ctx.api.call(copyRoutes.open, { body: { ...there, parentId: w.pinned } }),
      ),
    ).toBe('not-found');

    // Alice's agent copies within its picks, never outside them, and never moves.
    const agent = await enrolledAgent(t, w.alice, {
      picks: [
        { spaceId: w.lib.spaceId, folderId: w.lib.shared, role: 'editor' },
        { spaceId: w.board, folderId: w.pinned, role: 'editor', canPublish: true },
      ],
    });
    const agents = await copyAll(agent.ctx, { ...options, to: w.board, parentId: w.pinned });
    expect(
      (await textOf(w.carol.ctx, at(w.board, agents.newIdOf(w.page.pageId)), 'published'))
        ?.markdown,
    ).toBe('published words');
    const agentMove = await openCopy(agent.ctx, {
      ...options,
      kind: 'move',
      to: w.board,
      parentId: w.pinned,
    });
    expect(await rejection(agentMove.open())).toBe('forbidden');
    const outside = { ...agents.opening, copyId: 'outside-its-picks', sourceNodeId: w.lib.above };
    expect(await rejection(agent.ctx.api.call(copyRoutes.open, { body: outside }))).toBe(
      'not-found',
    );
  });

  it('brings published versions only where the person can publish', async () => {
    const w = await world();
    // Bob edits the board's folder without publishing.
    await shareFolder(w.alice.ctx, {
      spaceId: w.board,
      rootId: await spaceOperations.createFolder(w.alice.ctx, {
        spaceId: w.board,
        parentId: null,
        name: 'Drafts',
      }),
      people: [await invite(w.alice, w.bob, 'editor')],
    });
    const drafts = (await spaceOperations.loadStructure(w.bob.ctx, w.board)).folders[0]?.id;
    if (!drafts) throw new Error('expected the folder');
    const sending = await openCopy(w.bob.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: drafts,
    });
    expect(await rejection(sending.open())).toBe('forbidden');
    const copy = await copyAll(w.bob.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: drafts,
      published: false,
    });
    const { heads } = await pages.loadPage(
      w.bob.ctx,
      PageIdSchema.parse(copy.newIdOf(w.page.pageId)),
    );
    expect(heads.publishedHead).toBeNull();
    expect(heads.draftHead).not.toBeNull();
  });

  it('shows a page whose source was deleted meanwhile, and ends once its source node is gone', async () => {
    const w = await world();
    const options = {
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: w.pinned as FolderId | null,
    };
    const [kept, ended] = [
      await openCopy(w.alice.ctx, options),
      await openCopy(w.alice.ctx, options),
    ];
    const move = await openCopy(w.alice.ctx, {
      ...options,
      kind: 'move',
      nodeId: w.lib.above,
      parentId: null,
    });
    for (const copy of [kept, ended, move]) {
      await copy.open();
      await copy.send();
    }
    // A page under the source goes: the copy shows what was sealed from it.
    await pages.deleteNode(w.alice.ctx, { spaceId: w.lib.spaceId, nodeId: w.page.pageId });
    await kept.finish();
    const made = at(w.board, kept.newIdOf(w.page.pageId));
    expect((await nodeRow(made.pageId))?.copyId).toBeNull();
    expect((await textOf(w.carol.ctx, made, 'published'))?.markdown).toBe('published words');
    // A move whose source changed ends.
    expect(await rejection(move.finish())).toBe('stale-head');
    expect(await nodeRow(move.newIdOf(w.lib.above))).toBeNull();
    // Once the source node itself is gone, so does a copy.
    await pages.deleteNode(w.alice.ctx, { spaceId: w.lib.spaceId, nodeId: w.lib.shared });
    expect(await rejection(ended.finish())).toBe('not-found');
    expect(await nodeRow(ended.newIdOf(w.lib.shared))).toBeNull();
    expect(await copyRow(ended.copyId)).toBeNull();
  });

  it('leaves the drafts it was sealed from to draft retention', async () => {
    const w = await world();
    const sealedFrom = await draftHead(w.alice, w.page);
    await copyAll(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned,
    });
    await pages.editDraft(w.alice.ctx, w.page, { markdown: 'saved over' });
    await t.db
      .update(schema.revisions)
      .set({ createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.revisions.pageId, w.page.pageId));
    await sweepDrafts(t.db);
    expect(
      await t.db.select().from(schema.revisions).where(eq(schema.revisions.id, sealedFrom)),
    ).toEqual([]);
  });
});

describe('what a copy refuses', () => {
  it('refuses a publication from another page, a destination inside the source, and a move within one space', async () => {
    const w = await world();
    // A copy of the page published into the board's folder.
    const { revisionId } = await pages.publishPage(w.alice.ctx, w.page);
    const preview = await pubs.previewPublication(w.alice.ctx, {
      source: w.page,
      revisionId,
      audience: 'published',
      spaceId: w.board,
      parentId: w.pinned,
    });
    const live = await pubs.publishToSpace(w.alice.ctx, { preview, attachmentIds: new Set() });
    const folder = await openCopy(w.alice.ctx, {
      from: w.board,
      nodeId: w.pinned,
      to: w.lib.spaceId,
      parentId: null,
    });
    // The refusal names the page, for the dialog to list.
    const refused = await refusal(folder.open());
    expect(refused?.code).toBe('forbidden');
    expect(refused?.detail?.nodeIds).toEqual([live.pageId]);

    // An opening nobody finished is in no tree, and stops nothing.
    const other = await spaceOperations.createFolder(w.alice.ctx, {
      spaceId: w.board,
      parentId: null,
      name: 'Other',
    });
    const opening = PageIdSchema.parse('opening-nobody-finished');
    await w.alice.ctx.api.call(publicationRoutes.open, {
      body: {
        sourcePageId: w.lib.beside.pageId,
        destinationSpaceId: w.board,
        pageId: opening,
        parentId: other,
        permissionVersion:
          (await spaceOperations.loadStructure(w.alice.ctx, w.board)).folders.find(
            (f) => f.id === other,
          )?.permissionVersion ?? 0,
      },
    });
    const moved = await copyAll(w.alice.ctx, {
      kind: 'move',
      from: w.board,
      nodeId: other,
      to: w.lib.spaceId,
      parentId: null,
    });
    expect(moved.sourceIds).toEqual([other]);
    // The move took it with its folder.
    expect(await nodeRow(opening)).toBeNull();

    const inside = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.lib.above,
      to: w.lib.spaceId,
      parentId: w.lib.shared,
    });
    expect(await rejection(inside.open())).toBe('binding-mismatch');
    const here = await openCopy(w.alice.ctx, {
      kind: 'move',
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.lib.spaceId,
      parentId: null,
    });
    expect(await rejection(here.open())).toBe('forbidden');
  });

  it('copies a publication ended without being detached, its publication as its draft', async () => {
    const w = await world();
    const { revisionId } = await pages.publishPage(w.alice.ctx, w.page);
    const preview = await pubs.previewPublication(w.alice.ctx, {
      source: w.page,
      revisionId,
      audience: 'published',
      spaceId: w.board,
      parentId: w.pinned,
    });
    const published = await pubs.publishToSpace(w.alice.ctx, {
      preview,
      attachmentIds: new Set(),
    });
    expect(await pubs.endPublication(w.alice.ctx, { source: w.page, spaceId: w.board })).toBe(true);
    const copy = await copyAll(w.alice.ctx, {
      kind: 'move',
      from: w.board,
      nodeId: published.pageId,
      to: w.lib.spaceId,
      parentId: null,
    });
    const made = at(w.lib.spaceId, copy.newIdOf(published.pageId));
    const draft = await textOf(w.alice.ctx, made, 'draft');
    expect(draft?.markdown).toBe('draft words');
    expect(draft?.extensions['wikistow.publication']).toBeUndefined();
    expect((await textOf(w.alice.ctx, made, 'published'))?.markdown).toBe('draft words');
    expect((await pages.loadPage(w.alice.ctx, made.pageId)).heads.draftChanges).toBe(false);
  });

  it('is stale when a page moved with no draft has one by the finish', async () => {
    const w = await world();
    const { revisionId } = await pages.publishPage(w.alice.ctx, w.page);
    const preview = await pubs.previewPublication(w.alice.ctx, {
      source: w.page,
      revisionId,
      audience: 'published',
      spaceId: w.board,
      parentId: w.pinned,
    });
    const published = await pubs.publishToSpace(w.alice.ctx, {
      preview,
      attachmentIds: new Set(),
    });
    await pubs.endPublication(w.alice.ctx, { source: w.page, spaceId: w.board });
    const move = await openCopy(w.alice.ctx, {
      kind: 'move',
      from: w.board,
      nodeId: published.pageId,
      to: w.lib.spaceId,
      parentId: null,
    });
    await move.open();
    await move.send();
    // Detached meanwhile: it has a draft now.
    const copy = { spaceId: w.board, pageId: published.pageId };
    await pubs.detachPublication(w.alice.ctx, copy);
    await pages.editDraft(w.alice.ctx, copy, { markdown: 'written once detached' });
    const stale = await move.finish().then(
      () => null,
      (error: { code?: string; detail?: { nodeIds?: string[] } }) => error,
    );
    expect(stale?.code).toBe('stale-head');
    expect(stale?.detail?.nodeIds).toEqual([move.newIdOf(published.pageId)]);
    await move.send([published.pageId]);
    await move.finish();
    const made = at(w.lib.spaceId, move.newIdOf(published.pageId));
    expect((await textOf(w.alice.ctx, made, 'draft'))?.markdown).toBe('written once detached');
  });

  it('shows unpublished changes in a copy only where the source has them', async () => {
    const w = await world();
    const changed = await copyAll(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned,
    });
    const info = (id: string) => pages.loadPage(w.alice.ctx, PageIdSchema.parse(id));
    // Its draft was edited since it was published.
    expect((await info(changed.newIdOf(w.page.pageId))).heads.draftChanges).toBe(true);
    // Published as it is, its copy's publication names the copy's draft.
    await pages.publishPage(w.alice.ctx, w.page);
    const same = await copyAll(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned,
    });
    const made = await info(same.newIdOf(w.page.pageId));
    expect(made.heads.draftChanges).toBe(false);
    const [published] = await t.db
      .select({ basedOn: schema.revisions.basedOn })
      .from(schema.revisions)
      .where(eq(schema.revisions.id, made.heads.publishedHead ?? ''));
    expect(published?.basedOn).toBe(made.heads.draftHead);
  });

  it('refuses an opening once the source changed since its preview', async () => {
    const w = await world();
    const copy = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: null,
    });
    // A page added since: the nodes no longer mirror the source.
    await pages.createPage(w.alice.ctx, {
      spaceId: w.lib.spaceId,
      parentId: w.lib.shared,
      title: 'Added',
    });
    expect(await rejection(copy.open())).toBe('stale-head');
    const pageCopy = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned,
    });
    // Unpublished since the preview, the page's permission version moved on.
    const { heads, permissionVersion } = await pages.loadPage(w.alice.ctx, w.page.pageId);
    if (!heads.publishedHead) throw new Error('expected a publication');
    await pages.unpublishPage(w.alice.ctx, w.page, {
      publishedHead: heads.publishedHead,
      permissionVersion,
    });
    expect(await rejection(pageCopy.open())).toBe('permission-version');
  });

  it('refuses a page with nothing to copy, naming it', async () => {
    const w = await world();
    // A publication ended without being detached, then unpublished: no draft, no publication.
    const { revisionId } = await pages.publishPage(w.alice.ctx, w.page);
    const preview = await pubs.previewPublication(w.alice.ctx, {
      source: w.page,
      revisionId,
      audience: 'published',
      spaceId: w.board,
      parentId: w.pinned,
    });
    const published = await pubs.publishToSpace(w.alice.ctx, { preview, attachmentIds: new Set() });
    await pubs.endPublication(w.alice.ctx, { source: w.page, spaceId: w.board });
    const empty = { spaceId: w.board, pageId: published.pageId };
    const { heads, permissionVersion } = await pages.loadPage(w.alice.ctx, empty.pageId);
    if (!heads.publishedHead || heads.draftHead) throw new Error('expected a publication alone');
    await pages.unpublishPage(w.alice.ctx, empty, {
      publishedHead: heads.publishedHead,
      permissionVersion,
    });
    const copy = await openCopy(w.alice.ctx, {
      from: w.board,
      nodeId: w.pinned,
      to: w.lib.spaceId,
      parentId: null,
    });
    expect(copy.sourceIds).toContain(published.pageId);
    const refused = await refusal(copy.open());
    expect(refused?.code).toBe('forbidden');
    expect(refused?.detail?.nodeIds).toEqual([published.pageId]);
  });

  it('refuses records for a node twice, and published versions in a copy that doesn’t bring them', async () => {
    const w = await world();
    // Bob edits the shared folder but can't publish there. His own page,
    // published, copied there without its publication.
    const own = await pages.createPage(w.bob.ctx, {
      spaceId: w.bobs,
      parentId: null,
      title: 'Bob’s',
    });
    const page = { spaceId: w.bobs, pageId: own };
    await pages.editDraft(w.bob.ctx, page, { markdown: 'for readers' });
    await pages.publishPage(w.bob.ctx, page);
    const options = { from: w.bobs, nodeId: own, to: w.lib.spaceId, parentId: w.lib.shared };
    expect(await rejection(openCopy(w.bob.ctx, options).then((copy) => copy.open()))).toBe(
      'forbidden',
    );
    const copy = await openCopy(w.bob.ctx, { ...options, published: false });
    await copy.open();
    const send = (nodes: z.input<typeof copyRoutes.CopiedRecords>[]) =>
      rejection(
        w.bob.ctx.api.call(copyRoutes.records, {
          params: { copyId: copy.copyId },
          body: { nodes },
        }),
      );
    // Sealed under the share's published key, which editors hold, it would
    // reach readers though nobody who may publish there published it.
    expect(await send([await copy.seal(own, { withPublished: true })])).toBe('forbidden');

    // One set of records each: a node listed twice, or a second draft.
    const entry = await copy.seal(own);
    expect(await send([entry, await copy.seal(own)])).toBe('binding-mismatch');
    const brings = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned,
    });
    await brings.open();
    const first = await brings.seal(w.page.pageId);
    const second = await brings.seal(w.page.pageId);
    const { publishedHead } = (await pages.loadPage(w.alice.ctx, w.page.pageId)).heads;
    if (first.kind !== 'page' || second.kind !== 'page' || !publishedHead) {
      throw new Error('expected a published page');
    }
    // A draft where its publication goes, named as sealed from that publication.
    const twoDrafts = {
      ...first,
      published: { ...second.draft, sourceRevisionId: publishedHead },
    };
    expect(
      await rejection(
        w.alice.ctx.api.call(copyRoutes.records, {
          params: { copyId: brings.copyId },
          body: { nodes: [twoDrafts] },
        }),
      ),
    ).toBe('binding-mismatch');
    // Sent as they should be, they go.
    expect(await send([entry])).toBe('no error');
    await copy.finish();
    const made = at(w.lib.spaceId, copy.newIdOf(own));
    expect((await pages.loadPage(w.bob.ctx, made.pageId)).heads.publishedHead).toBeNull();
  });

  it('refuses records once access at the destination changed since the opening', async () => {
    const w = await world();
    // At the top of the space, whose own permission version it was opened at.
    const copy = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: null,
    });
    await copy.open();
    expect(copy.opening.parentId).toBeNull();
    await sharing.addMember(w.alice.ctx, {
      spaceId: w.board,
      shareId: w.boardShare,
      ...(await invite(w.alice, w.erin, 'reader')),
    });
    expect(await rejection(copy.send())).toBe('permission-version');
  });
});

describe('moving into another space', () => {
  it('moves a folder and deletes the source with its share, links and publications', async () => {
    const w = await world();
    const linkId = await links.turnOn(w.alice.ctx, w.page.pageId);
    const { revisionId } = await pages.publishPage(w.alice.ctx, w.page);
    const third = await spaceOperations.createSpace(w.alice.ctx, { name: 'Third' });
    const preview = await pubs.previewPublication(w.alice.ctx, {
      source: w.page,
      revisionId,
      audience: 'published',
      spaceId: third,
      parentId: null,
    });
    const published = await pubs.publishToSpace(w.alice.ctx, {
      preview,
      attachmentIds: new Set(),
    });
    expect(linkId).toBeTruthy();

    const move = await copyAll(w.alice.ctx, {
      kind: 'move',
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: w.pinned,
    });
    const made = at(w.board, move.newIdOf(w.page.pageId));
    // Its draft was published above.
    expect((await textOf(w.carol.ctx, made, 'published'))?.markdown).toBe('draft words');
    expect((await textOf(w.dave.ctx, made, 'draft'))?.markdown).toBe('draft words');

    // The source and all it had are gone; the copy published from it stays,
    // a page of its own.
    expect(await nodeRow(w.lib.shared)).toBeNull();
    expect(await nodeRow(w.page.pageId)).toBeNull();
    expect(await t.db.select().from(schema.shares).where(eq(schema.shares.id, w.libShare))).toEqual(
      [],
    );
    expect(
      await t.db
        .select()
        .from(schema.publicLinks)
        .where(eq(schema.publicLinks.pageId, w.page.pageId)),
    ).toEqual([]);
    const [row] = await t.db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.destinationPageId, published.pageId));
    expect(row?.detachedAt).not.toBeNull();
    expect(await rejection(pages.loadPage(w.bob.ctx, w.page.pageId))).toBe('not-found');
    expect(
      await t.db
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.action, 'node.moved-between-spaces'),
            eq(schema.auditEvents.targetId, w.lib.shared),
          ),
        ),
    ).toHaveLength(1);

    // A page alone moves the same way.
    const page = await copyAll(w.alice.ctx, {
      kind: 'move',
      from: w.lib.spaceId,
      nodeId: w.lib.beside.pageId,
      to: w.board,
      parentId: null,
    });
    expect(await nodeRow(w.lib.beside.pageId)).toBeNull();
    expect((await nodeRow(page.newIdOf(w.lib.beside.pageId)))?.copyId).toBeNull();
  });

  it('is refused as stale when a source head moved on, and finishes once that node is sent again', async () => {
    const w = await world();
    const move = await openCopy(w.alice.ctx, {
      kind: 'move',
      from: w.lib.spaceId,
      nodeId: w.lib.above,
      to: w.board,
      parentId: null,
    });
    await move.open();
    await move.send();
    await pages.editDraft(w.alice.ctx, w.page, { markdown: 'words written meanwhile' });
    const stale = await move.finish().then(
      () => null,
      (error: { code?: string; detail?: { nodeIds?: string[] } }) => error,
    );
    expect(stale?.code).toBe('stale-head');
    expect(stale?.detail?.nodeIds).toEqual([move.newIdOf(w.page.pageId)]);
    // Still there: send that page again and finish.
    await move.send([w.page.pageId]);
    await move.finish();
    const made = at(w.board, move.newIdOf(w.page.pageId));
    expect((await textOf(w.alice.ctx, made, 'draft'))?.markdown).toBe('words written meanwhile');
    expect(await nodeRow(w.page.pageId)).toBeNull();
    // The first records sent for it are gone, and only one draft is left.
    expect(
      await t.db.select().from(schema.revisions).where(eq(schema.revisions.pageId, made.pageId)),
    ).toHaveLength(2);
  });

  it('ends when the source gains a page meanwhile, which would otherwise go uncopied', async () => {
    const w = await world();
    const move = await openCopy(w.alice.ctx, {
      kind: 'move',
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: null,
    });
    await move.open();
    await move.send();
    const added = await pages.createPage(w.alice.ctx, {
      spaceId: w.lib.spaceId,
      parentId: w.lib.shared,
      title: 'Added meanwhile',
    });
    expect(await rejection(move.finish())).toBe('stale-head');
    // The copy is gone, its nodes too; the source and the new page stay.
    expect(await rejection(move.finish())).toBe('not-found');
    expect(await nodeRow(move.newIdOf(w.lib.shared))).toBeNull();
    expect(await nodeRow(added)).not.toBeNull();
    expect(await nodeRow(w.page.pageId)).not.toBeNull();
  });
});

describe('a copy’s hidden nodes', () => {
  it('are seen by nobody, and count for nothing outside their copy', async () => {
    const w = await world();
    const copy = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: w.pinned,
    });
    await copy.open();
    await copy.send();
    const hidden = [copy.newIdOf(w.lib.shared), copy.newIdOf(w.page.pageId)];
    const sent = await t.db
      .select({ id: schema.revisions.id })
      .from(schema.revisions)
      .where(inArray(schema.revisions.pageId, hidden));
    for (const person of [w.alice, w.carol, w.dave]) {
      const tree = await spaceOperations.loadStructure(person.ctx, w.board);
      const ids = [...tree.folders, ...tree.pages].map((node) => node.id as string);
      for (const id of hidden) expect(ids).not.toContain(id);
      expect(await rejection(pages.loadPage(person.ctx, PageIdSchema.parse(hidden[1])))).toBe(
        'not-found',
      );
      const fetched = await person.ctx.api.call(pageRoutes.fetchRevisions, {
        body: { ids: sent.map((r) => r.id) },
      });
      expect(fetched.revisions).toEqual([]);
    }
    // Only the opener uploads to them, sends to them, or finishes them.
    const page = at(w.board, hidden[1] ?? '');
    expect(await rejection(pages.uploadBlob(w.dave.ctx, page, 'draft', utf8('x')))).toBe(
      'not-found',
    );
    const params = { copyId: copy.copyId };
    expect(
      await rejection(
        w.dave.ctx.api.call(copyRoutes.records, {
          params,
          body: { nodes: [await copy.seal(w.page.pageId)] },
        }),
      ),
    ).toBe('not-found');
    expect(await rejection(w.dave.ctx.api.call(copyRoutes.finish, { params }))).toBe('not-found');
    expect(await rejection(w.dave.ctx.api.call(copyRoutes.cancel, { params }))).toBe('not-found');
    // Nor does the owner delete one by itself.
    expect(
      await rejection(
        pages.deleteNode(w.alice.ctx, { spaceId: w.board, nodeId: PageIdSchema.parse(hidden[1]) }),
      ),
    ).toBe('not-found');

    // A change of who has access at the destination meanwhile doesn't wait
    // for the copy, which then fails at its finish, and is gone.
    await sharing.addMember(w.alice.ctx, {
      spaceId: w.board,
      shareId: w.boardShare,
      ...(await invite(w.alice, w.erin, 'reader')),
    });
    expect(await rejection(copy.finish())).toBe('permission-version');
    for (const id of hidden) expect(await nodeRow(id)).toBeNull();
    expect(
      await t.db.select().from(schema.copies).where(eq(schema.copies.id, copy.copyId)),
    ).toEqual([]);
  });

  it('go when cancelled, or when nobody sent anything for a day', async () => {
    const w = await world();
    const options = {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned as FolderId | null,
    };
    const cancelled = await openCopy(w.alice.ctx, options);
    await cancelled.open();
    await cancelled.send();
    const made = cancelled.newIdOf(w.page.pageId);
    const uploaded = await t.db.select().from(schema.blobs).where(eq(schema.blobs.pageId, made));
    expect(uploaded).toHaveLength(2);
    await cancelled.cancel();
    expect(await nodeRow(made)).toBeNull();
    const store = fileBlobStore(t.blobDir);
    for (const { hash } of uploaded) expect(await store.get(hash)).toBeNull();

    const abandoned = await openCopy(w.alice.ctx, options);
    await abandoned.open();
    await abandoned.send();
    const busy = await openCopy(w.alice.ctx, options);
    await busy.open();
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await t.db
      .update(schema.copies)
      .set({ touchedAt: old })
      .where(eq(schema.copies.id, abandoned.copyId));
    const { copies } = await sweepBlobs(t.db, store);
    expect(copies).toBe(1);
    expect(await nodeRow(abandoned.newIdOf(w.page.pageId))).toBeNull();
    expect(await nodeRow(busy.newIdOf(w.page.pageId))).not.toBeNull();
    await busy.send();
    await busy.finish();
    expect((await nodeRow(busy.newIdOf(w.page.pageId)))?.copyId).toBeNull();
  });

  it('go when more than one statement could name one by one, and one that can’t go stops no sweep', async () => {
    const w = await world();
    const big = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: w.pinned,
    });
    await big.open();
    await big.send();
    // More hidden pages than half Postgres's 65,535 parameters, which a
    // delete naming each ID twice would pass.
    const top = big.newIdOf(w.lib.shared);
    const prefix = `big${big.copyId.slice(0, 8)}`;
    await t.db.execute(sql`
      insert into nodes (id, space_id, parent_id, kind, copy_id)
      select ${prefix} || g, ${w.board}, ${top}, 'page', ${big.copyId}
      from generate_series(1, 33000) g`);
    expect(await big.cancel()).toEqual({ ok: true });
    const [left] = await t.db
      .select({ n: count() })
      .from(schema.nodes)
      .where(sql`${schema.nodes.id} like ${`${prefix}%`}`);
    expect(left?.n).toBe(0);
    expect(await nodeRow(top)).toBeNull();

    // A copy whose hidden top went elsewhere can't be dropped: the sweep
    // counts it, and goes on to the next.
    const options = { from: w.lib.spaceId, nodeId: w.page.pageId, to: w.board, parentId: null };
    const stuck = await openCopy(w.alice.ctx, options);
    const abandoned = await openCopy(w.alice.ctx, options);
    for (const copy of [stuck, abandoned]) await copy.open();
    await t.db
      .update(schema.nodes)
      .set({ spaceId: w.bobs })
      .where(eq(schema.nodes.id, stuck.newIdOf(w.page.pageId)));
    await t.db
      .update(schema.copies)
      .set({ touchedAt: DAYS_AGO_2() })
      .where(inArray(schema.copies.id, [stuck.copyId, abandoned.copyId]));
    const swept = await sweepBlobs(t.db, fileBlobStore(t.blobDir));
    expect(swept).toMatchObject({ copies: 1, copiesFailed: 1 });
    expect(await copyRow(abandoned.copyId)).toBeNull();
    expect(await copyRow(stuck.copyId)).not.toBeNull();
    await t.db.delete(schema.copies).where(eq(schema.copies.id, stuck.copyId));
  });

  it('go with their copy, and with an unfinished copy’s source space', async () => {
    const w = await world();
    const scratch = await spaceOperations.createSpace(w.alice.ctx, { name: 'Scratch' });
    const folder = await spaceOperations.createFolder(w.alice.ctx, {
      spaceId: scratch,
      parentId: null,
      name: 'Notes',
    });
    const note = await pages.createPage(w.alice.ctx, {
      spaceId: scratch,
      parentId: folder,
      title: 'Note',
    });
    await pages.editDraft(w.alice.ctx, { spaceId: scratch, pageId: note }, { markdown: 'a note' });
    const copy = await openCopy(w.alice.ctx, {
      from: scratch,
      nodeId: folder,
      to: w.board,
      parentId: null,
    });
    await copy.open();
    await copy.send();
    const hidden = copy.sourceIds.map((id) => copy.newIdOf(id));
    const names = () =>
      t.db
        .select({ id: schema.metadataRevisions.id })
        .from(schema.metadataRevisions)
        .where(inArray(schema.metadataRevisions.subjectId, hidden));
    const [name] = await names();
    if (!name) throw new Error('expected the folder’s name');
    const [space] = await t.db
      .select({ permissionVersion: schema.spaces.permissionVersion })
      .from(schema.spaces)
      .where(eq(schema.spaces.id, scratch));
    await spaceOperations.deleteSpace(w.alice.ctx, {
      spaceId: scratch,
      permissionVersion: space?.permissionVersion ?? 1,
    });
    // Their names and key material too, which name them only by ID.
    for (const id of hidden) expect(await nodeRow(id)).toBeNull();
    expect(await copyRow(copy.copyId)).toBeNull();
    expect(await names()).toEqual([]);
    expect(
      await t.db
        .select()
        .from(schema.keyEnvelopes)
        .where(eq(schema.keyEnvelopes.subjectId, name.id)),
    ).toEqual([]);
    // The owners can still add an owner there: nothing is left to cover.
    await owners.addCoOwner(w.alice.ctx, { spaceId: w.board, person: await find(w.alice, w.bob) });

    // However else a copy's row goes, its hidden nodes go with it.
    const other = await openCopy(w.alice.ctx, {
      from: w.lib.spaceId,
      nodeId: w.page.pageId,
      to: w.board,
      parentId: w.pinned,
    });
    await other.open();
    await other.send();
    await t.db.delete(schema.copies).where(eq(schema.copies.id, other.copyId));
    expect(await nodeRow(other.newIdOf(w.page.pageId))).toBeNull();
  });

  it('stay their copy’s when its source is deleted, to cancel or sweep', async () => {
    const w = await world();
    const options = {
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: w.pinned as FolderId | null,
    };
    const cancelled = await openCopy(w.alice.ctx, options);
    const abandoned = await openCopy(w.alice.ctx, { ...options, kind: 'move' });
    for (const copy of [cancelled, abandoned]) {
      await copy.open();
      await copy.send();
    }
    await pages.deleteNode(w.alice.ctx, { spaceId: w.lib.spaceId, nodeId: w.lib.shared });
    // The source's delete took neither copy.
    for (const copy of [cancelled, abandoned]) {
      expect(await copyRow(copy.copyId)).not.toBeNull();
      expect((await nodeRow(copy.newIdOf(w.page.pageId)))?.copyId).toBe(copy.copyId);
    }
    expect(await cancelled.cancel()).toEqual({ ok: true });
    expect(await nodeRow(cancelled.newIdOf(w.lib.shared))).toBeNull();
    await t.db
      .update(schema.copies)
      .set({ touchedAt: DAYS_AGO_2() })
      .where(eq(schema.copies.id, abandoned.copyId));
    expect((await sweepBlobs(t.db, fileBlobStore(t.blobDir))).copies).toBe(1);
    expect(await copyRow(abandoned.copyId)).toBeNull();
    expect(await nodeRow(abandoned.newIdOf(w.page.pageId))).toBeNull();
  });

  it('take their records with them, envelopes and names too, when cancelled, swept or sent again', async () => {
    const w = await world();
    // Into the board's owner region, whose records carry envelopes, not wraps.
    const options = {
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: null as FolderId | null,
    };
    const recordsOf = async (copy: Awaited<ReturnType<typeof openCopy>>) => {
      const hidden = copy.sourceIds.map((id) => copy.newIdOf(id));
      const versions = await t.db
        .select({ id: schema.revisions.id })
        .from(schema.revisions)
        .where(inArray(schema.revisions.pageId, hidden));
      const names = await t.db
        .select({ id: schema.metadataRevisions.id })
        .from(schema.metadataRevisions)
        .where(inArray(schema.metadataRevisions.subjectId, hidden));
      const subjects = [...versions, ...names].map((row) => row.id);
      const envelopes =
        subjects.length === 0
          ? []
          : await t.db
              .select({ id: schema.keyEnvelopes.subjectId })
              .from(schema.keyEnvelopes)
              .where(inArray(schema.keyEnvelopes.subjectId, subjects));
      return { versions, names, envelopes };
    };
    const cancelled = await openCopy(w.alice.ctx, options);
    const swept = await openCopy(w.alice.ctx, options);
    for (const copy of [cancelled, swept]) {
      await copy.open();
      await copy.send();
      const sent = await recordsOf(copy);
      expect(sent.names).toHaveLength(1);
      expect(sent.envelopes.length).toBeGreaterThan(0);
    }

    // The folder sent again: its first name and envelopes go.
    const [first] = (await recordsOf(cancelled)).names;
    await cancelled.send([w.lib.shared]);
    const again = await recordsOf(cancelled);
    expect(again.names).toHaveLength(1);
    expect(again.names[0]?.id).not.toBe(first?.id);
    expect(
      await t.db
        .select()
        .from(schema.keyEnvelopes)
        .where(eq(schema.keyEnvelopes.subjectId, first?.id ?? '')),
    ).toEqual([]);

    await cancelled.cancel();
    await t.db
      .update(schema.copies)
      .set({ touchedAt: DAYS_AGO_2() })
      .where(eq(schema.copies.id, swept.copyId));
    await sweepBlobs(t.db, fileBlobStore(t.blobDir));
    for (const copy of [cancelled, swept]) {
      expect(await recordsOf(copy)).toEqual({ versions: [], names: [], envelopes: [] });
    }
  });

  it('leave a share, a new co-owner and a move between regions nothing to cover', async () => {
    const w = await world();
    const folder = (name: string) =>
      spaceOperations.createFolder(w.alice.ctx, { spaceId: w.board, parentId: null, name });
    const hiddenUnder = async (parentId: FolderId | null) => {
      const copy = await openCopy(w.alice.ctx, {
        from: w.lib.spaceId,
        nodeId: w.lib.shared,
        to: w.board,
        parentId,
      });
      await copy.open();
      await copy.send();
      return copy;
    };
    // A share over a folder holding a copy's hidden nodes.
    const loose = await folder('Loose');
    await hiddenUnder(loose);
    await shareFolder(w.alice.ctx, {
      spaceId: w.board,
      rootId: loose,
      people: [await invite(w.alice, w.erin, 'reader')],
    });
    // A co-owner, with hidden nodes in the owner region.
    await hiddenUnder(null);
    await owners.addCoOwner(w.alice.ctx, { spaceId: w.board, person: await find(w.alice, w.bob) });
    // A folder holding some moved from the owner region into a share.
    const moving = await folder('Moving');
    const inside = await hiddenUnder(moving);
    const preview = await moves.previewMove(w.alice.ctx, {
      spaceId: w.board,
      nodeId: moving,
      parentId: w.pinned,
    });
    await moves.moveNode(w.alice.ctx, { preview });
    // The hidden nodes moved along, and their copy fails at its finish.
    expect((await nodeRow(inside.newIdOf(w.lib.shared)))?.parentId).toBe(moving);
    expect(await rejection(inside.finish())).toBe('permission-version');
  });
});

describe('a finished copy', () => {
  it('answers a finish or cancel sent again as the finish did, and leaves its nodes when swept', async () => {
    const w = await world();
    const move = await copyAll(w.alice.ctx, {
      kind: 'move',
      from: w.lib.spaceId,
      nodeId: w.lib.shared,
      to: w.board,
      parentId: w.pinned,
    });
    const made = at(w.board, move.newIdOf(w.page.pageId));
    // Its answer lost, the app finishes again, or gives up and cancels:
    // nothing changes, and the source is gone already. Deleting it didn't
    // take the copy's row, whose references to it don't cascade.
    expect(await nodeRow(w.lib.shared)).toBeNull();
    expect((await copyRow(move.copyId))?.finishedAt).not.toBeNull();
    expect(await move.finish()).toEqual({ ok: true });
    expect(await move.cancel()).toEqual({ ok: true });
    expect(await move.finish()).toEqual({ ok: true });
    expect(await nodeRow(w.lib.shared)).toBeNull();
    expect((await nodeRow(made.pageId))?.copyId).toBeNull();
    expect((await textOf(w.dave.ctx, made, 'draft'))?.markdown).toBe('draft words');
    expect(
      await t.db
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.action, 'node.moved-between-spaces'),
            eq(schema.auditEvents.targetId, w.lib.shared),
          ),
        ),
    ).toHaveLength(1);
    // Its nodes are no longer its own.
    expect(
      await t.db.select().from(schema.copyNodes).where(eq(schema.copyNodes.copyId, move.copyId)),
    ).toEqual([]);

    // A day on, it goes, and its nodes stay.
    await t.db
      .update(schema.copies)
      .set({ finishedAt: DAYS_AGO_2(), touchedAt: DAYS_AGO_2() })
      .where(eq(schema.copies.id, move.copyId));
    const { copies } = await sweepBlobs(t.db, fileBlobStore(t.blobDir));
    expect(copies).toBe(0);
    expect(await copyRow(move.copyId)).toBeNull();
    expect((await textOf(w.carol.ctx, made, 'published'))?.markdown).toBe('published words');
    expect(await rejection(move.finish())).toBe('not-found');
  });
});
