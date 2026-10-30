// Copies of pages and folders, and moves into another space (protocol
// section 10, "Copies, and moves between spaces"): what arrives, who may
// make one, what is refused, what a move ends, and the hidden nodes
// nobody else sees until the copy finishes.
import {
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
import { fileBlobStore, schema, sweepBlobs } from '@wikistow/server';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { copyAll, openCopy } from './support/copies.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { ABOVE, invite, library, shareFolder } from './support/sharing.ts';

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
    expect(stored.every((r) => r.from !== null)).toBe(true);
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
    await pubs.publishToSpace(w.alice.ctx, { preview, attachmentIds: new Set() });
    const folder = await openCopy(w.alice.ctx, {
      from: w.board,
      nodeId: w.pinned,
      to: w.lib.spaceId,
      parentId: null,
    });
    expect(await rejection(folder.open())).toBe('forbidden');

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

  it('refuses an opening made from an old preview', async () => {
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
});
