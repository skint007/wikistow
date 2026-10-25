import {
  closeSession,
  pageOperations as pages,
  searchOperations as search,
  type ClientContext,
  type SearchIndex,
} from '@wikistow/client';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, library, shareFolder } from './support/sharing.ts';

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
  await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, bob, 'reader'), await invite(alice, ed, 'editor')],
  });
  return { bob, ed, lib };
}

const hits = async (ctx: ClientContext, query: string) =>
  (await search.indexSpaces(ctx)).search(query).map(({ doc, snippet }) => ({
    ...doc,
    snippet: snippet().text,
  }));

const found = (index: SearchIndex<search.SearchPage>, query: string) =>
  index.search(query).map(({ doc }) => doc.pageId);

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

  it('is abandoned when the vault locks while it is built', async () => {
    const { bob } = await shared();
    const locking = search.indexSpaces(bob.ctx, { onProgress: () => closeSession(bob.ctx) });
    await expect(locking).rejects.toBeInstanceOf(search.IndexAbandoned);
  });
});
