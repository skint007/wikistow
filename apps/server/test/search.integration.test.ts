import {
  closeSession,
  moveOperations as moves,
  pageOperations as pages,
  searchOperations as search,
  sharingOperations as sharing,
  spaceOperations,
  type ClientContext,
  type SearchIndex,
  type SpaceId,
} from '@wikistow/client';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, library, shareFolder, type Person } from './support/sharing.ts';
import { schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/** A word only the shared page's newest draft holds. */
const DRAFT_ONLY = 'unpublishedzebra';

/**
 * Alice's library, its page's newest draft holding `DRAFT_ONLY`, shared
 * with Bob to read and Ed to edit.
 */
async function shared() {
  const [alice, bob, ed] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(alice);
  await pages.editDraft(alice.ctx, lib.page, { markdown: `draft words ${DRAFT_ONLY}` });
  const shareId = await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, bob, 'reader'), await invite(alice, ed, 'editor')],
  });
  return { alice, bob, ed, lib, shareId };
}

const hits = async (ctx: ClientContext, query: string) =>
  (await search.indexSpaces(ctx)).search(query).map(({ doc, snippet }) => ({
    ...doc,
    snippet: snippet().text,
  }));

const found = (index: SearchIndex<search.SearchPage>, query: string) =>
  index.search(query).map(({ doc }) => doc.pageId);

/** What an index holds and finds, to compare an updated one with one built afresh. */
const held = (index: search.PageIndex) => ({
  pages: index
    .pages()
    .map(({ doc, title, text }) => ({ doc, title, text }))
    .sort((a, b) => (a.doc.pageId < b.doc.pageId ? -1 : 1)),
  found: ['published', 'republished', 'draft', 'private', 'plan', 'words', DRAFT_ONLY].map((q) =>
    index.search(q).map(({ doc, score }) => ({ doc, score })),
  ),
});

/** The paths of the routes `ctx` calls from now on. */
function calls(ctx: ClientContext): string[] {
  const paths: string[] = [];
  const call = ctx.api.call.bind(ctx.api);
  ctx.api.call = ((route, ...rest) => {
    paths.push(route.path);
    return call(route, ...rest);
  }) as typeof ctx.api.call;
  return paths;
}

const identityOf = (person: Person) => person.vault.identity.public.id;

describe('a search index', () => {
  it('holds only published text for a reader, never a draft, and an editor’s drafts', async () => {
    const { bob, ed, lib } = await shared();
    expect(await hits(bob.ctx, 'published')).toEqual([
      {
        spaceId: lib.spaceId,
        pageId: lib.page.pageId,
        revisionId: expect.any(String),
        parentId: lib.shared,
        // Bob holds a folder, not the space: its name isn't his to read,
        // nor the folder above it.
        folderIds: [lib.shared],
        path: ['Shared'],
        draft: false,
        unpublished: false,
        snippet: 'published words',
      },
    ]);
    expect(await hits(bob.ctx, DRAFT_ONLY)).toEqual([]);
    expect(await hits(bob.ctx, 'draft')).toEqual([]);
    // The page beside the share stays out, title and all.
    expect(await hits(bob.ctx, 'private')).toEqual([]);
    // An editor finds the draft.
    expect(await hits(ed.ctx, DRAFT_ONLY)).toMatchObject([
      { pageId: lib.page.pageId, draft: true },
    ]);
  });

  it('keeps each page’s properties from the version it holds, a draft only for its editors', async () => {
    const { bob, ed, lib } = await shared();
    await pages.editDraft(ed.ctx, lib.page, {
      markdown: `---\nstatus: in progress\ntags: [plan]\n---\n${DRAFT_ONLY}`,
    });
    const read = await search.indexSpaces(bob.ctx);
    expect(read.page(lib.spaceId, lib.page.pageId)?.properties).toEqual([]);
    expect(read.list({ spaceId: lib.spaceId, tag: 'plan' })).toEqual([]);
    expect(read.page(lib.spaceId, lib.beside.pageId)).toBeUndefined();
    const edited = await search.indexSpaces(ed.ctx);
    expect(edited.page(lib.spaceId, lib.page.pageId)).toMatchObject({
      draft: true,
      properties: [
        { key: 'status', type: 'text', value: 'in progress' },
        { key: 'tags', type: 'list', value: ['plan'] },
      ],
    });
    expect(
      edited.list({ spaceId: lib.spaceId, folderId: lib.shared, tag: 'plan' }).map((p) => p.pageId),
    ).toEqual([lib.page.pageId]);
  });

  it('takes unchanged pages from a kept index, sealed for its person and build, and opens changed ones', async () => {
    const { bob, ed, lib } = await shared();
    // Kept text stands in for the version's, so what was opened again shows.
    const kept = new Map(
      [...search.keptPages(await search.indexSpaces(ed.ctx))].map(([id, page]) => [
        id,
        { ...page, text: 'kept words' },
      ]),
    );
    const sealed = search.sealKept(ed.ctx, kept, '1.0.0');
    expect(search.openKept(bob.ctx, sealed, '1.0.0')).toBeNull();
    expect(search.openKept(ed.ctx, sealed, '1.0.1')).toBeNull();
    const opened = search.openKept(ed.ctx, sealed, '1.0.0');
    expect(opened).toEqual(kept);
    expect(found(await search.indexSpaces(ed.ctx, { kept: opened }), 'kept')).toEqual([
      lib.page.pageId,
    ]);
    await pages.editDraft(ed.ctx, lib.page, { markdown: 'changed words' });
    const next = await search.indexSpaces(ed.ctx, { kept: opened });
    expect(found(next, 'kept')).toEqual([]);
    expect(found(next, 'changed')).toEqual([lib.page.pageId]);
  });

  it('drops what a reader loses as it is updated, as one built afresh would', async () => {
    const { alice, bob, lib, shareId } = await shared();
    const update = (index: search.PageIndex) =>
      search.updateIndex(bob.ctx, index, { spaces: [lib.spaceId] });
    let index = await search.indexSpaces(bob.ctx);
    expect(found(index, 'published')).toEqual([lib.page.pageId]);
    // Published again: the reader's index holds the new publication only.
    await pages.editDraft(alice.ctx, lib.page, { markdown: 'republished words' });
    await pages.publishPage(alice.ctx, lib.page);
    index = await update(index);
    expect(found(index, 'republished')).toEqual([lib.page.pageId]);
    expect(found(index, 'published')).toEqual([]);
    expect(held(index)).toEqual(held(await search.indexSpaces(bob.ctx)));
    // Moved out of the share: gone from every read.
    const out = await moves.previewMove(alice.ctx, {
      spaceId: lib.spaceId,
      nodeId: lib.page.pageId,
      parentId: lib.above,
    });
    await moves.moveNode(alice.ctx, { preview: out });
    index = await update(index);
    expect(index.page(lib.spaceId, lib.page.pageId)).toBeUndefined();
    expect(found(index, 'republished')).toEqual([]);
    expect(index.size).toBe(0);
    expect(held(index)).toEqual(held(await search.indexSpaces(bob.ctx)));
    // Moved back, then Bob is taken out of the share.
    const back = await moves.previewMove(alice.ctx, {
      spaceId: lib.spaceId,
      nodeId: lib.page.pageId,
      parentId: lib.shared,
    });
    await moves.moveNode(alice.ctx, { preview: back });
    index = await update(index);
    expect(found(index, 'republished')).toEqual([lib.page.pageId]);
    await sharing.removeMember(alice.ctx, {
      spaceId: lib.spaceId,
      shareId,
      identityId: identityOf(bob),
    });
    const removed = await update(index);
    expect(removed.size).toBe(0);
    expect(found(removed, 'republished')).toEqual([]);
    expect(removed.list({ spaceId: lib.spaceId })).toEqual([]);
    // Listing every space drops it too, as no longer shared with him.
    expect((await search.updateIndex(bob.ctx, index, { spaces: 'all' })).size).toBe(0);
  });

  it('drops a space deleted, and an editor’s draft another replaced, as it is updated', async () => {
    const { alice, ed, lib } = await shared();
    let index = await search.indexSpaces(ed.ctx);
    expect(found(index, DRAFT_ONLY)).toEqual([lib.page.pageId]);
    await pages.editDraft(alice.ctx, lib.page, { markdown: 'replaced words' });
    index = await search.updateIndex(ed.ctx, index, { spaces: [lib.spaceId] });
    expect(found(index, DRAFT_ONLY)).toEqual([]);
    expect(found(index, 'replaced')).toEqual([lib.page.pageId]);
    expect(held(index)).toEqual(held(await search.indexSpaces(ed.ctx)));
    // A second space of Alice's, a home space being one that can't be deleted.
    const second = await library(alice);
    await shareFolder(alice.ctx, {
      spaceId: second.spaceId,
      rootId: second.shared,
      people: [await invite(alice, ed, 'editor')],
    });
    index = await search.updateIndex(ed.ctx, index, { spaces: [second.spaceId] });
    expect(index.list({ spaceId: second.spaceId })).toHaveLength(1);
    const [space] = await t.db
      .select({ permissionVersion: schema.spaces.permissionVersion })
      .from(schema.spaces)
      .where(eq(schema.spaces.id, second.spaceId));
    await spaceOperations.deleteSpace(alice.ctx, {
      spaceId: second.spaceId,
      permissionVersion: space?.permissionVersion ?? 1,
    });
    index = await search.updateIndex(ed.ctx, index, { spaces: [second.spaceId] });
    expect(index.list({ spaceId: second.spaceId })).toEqual([]);
    expect(held(index)).toEqual(held(await search.indexSpaces(ed.ctx)));
  });

  it('lists only the spaces named, and opens only the versions it doesn’t hold', async () => {
    const { alice, ed, lib } = await shared();
    const other: SpaceId = await spaceOperations.createSpace(ed.ctx, { name: 'Notes' });
    const mine = await pages.createPage(ed.ctx, { spaceId: other, parentId: null, title: 'Mine' });
    const index = await search.indexSpaces(ed.ctx);
    const paths = calls(ed.ctx);
    // The echo of a change already held: one tree listed, nothing opened,
    // and the same index.
    const same = await search.updateIndex(ed.ctx, index, { spaces: [lib.spaceId] });
    expect(same).toBe(index);
    expect(paths).toEqual(['/api/spaces/:spaceId/tree']);
    // Someone else's edit: the one version opened, besides the tree.
    paths.length = 0;
    await pages.editDraft(alice.ctx, lib.page, { markdown: 'edited elsewhere' });
    const next = await search.updateIndex(ed.ctx, index, { spaces: [lib.spaceId] });
    expect(found(next, 'elsewhere')).toEqual([lib.page.pageId]);
    expect(paths.filter((path) => path === '/api/spaces/:spaceId/tree')).toHaveLength(1);
    expect(paths).not.toContain('/api/spaces');
    expect(paths.length).toBeLessThanOrEqual(3);
    // The space not named is kept as it was.
    expect(next.page(other, mine)).toBe(index.page(other, mine));
  });

  it('is abandoned when the vault locks while it is built', async () => {
    const { bob } = await shared();
    const locking = search.indexSpaces(bob.ctx, { onProgress: () => closeSession(bob.ctx) });
    await expect(locking).rejects.toBeInstanceOf(search.IndexAbandoned);
  });
});
