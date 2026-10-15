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
        // Bob holds a folder, not the space: its name isn't his to read.
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

  it('takes unchanged pages from a kept index, sealed for its person, and opens changed ones', async () => {
    const { bob, ed, lib } = await shared();
    // Kept text stands in for the version's, so what was opened again shows.
    const kept = new Map(
      [...search.keptPages(await search.indexSpaces(ed.ctx))].map(([id, page]) => [
        id,
        { ...page, text: 'kept words' },
      ]),
    );
    const sealed = search.sealKept(ed.ctx, kept);
    expect(search.openKept(bob.ctx, sealed)).toBeNull();
    const opened = search.openKept(ed.ctx, sealed);
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
