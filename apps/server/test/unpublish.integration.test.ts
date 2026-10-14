import { pageOperations as pages, type PageId, type RevisionId } from '@wikistow/client';
import { pageRoutes, structureRoutes } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const bytes = (value: string) => new TextEncoder().encode(value);

/** What a person sees of a page: its publication, and the permission version a change carries. */
const seen = async (person: Person, pageId: PageId) => {
  const { heads, permissionVersion } = await pages.loadPage(person.ctx, pageId);
  if (!heads.publishedHead) throw new Error('expected a publication');
  return { publishedHead: heads.publishedHead, permissionVersion };
};

const publishedHead = async (person: Person, pageId: PageId) =>
  (await seen(person, pageId)).publishedHead;

/**
 * A shared folder holding a published page with an attachment, and its
 * owner, a reader, an editor and an editor who can publish.
 */
async function world() {
  const [alice, reader, editor, publisher] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(alice);
  await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [
      await invite(alice, reader, 'reader'),
      await invite(alice, editor, 'editor'),
      await invite(alice, publisher, 'editor', true),
    ],
  });
  const { page } = lib;
  const ref = await pages.uploadAttachment(alice.ctx, page, {
    name: 'map.txt',
    mediaType: 'text/plain',
    bytes: bytes('the first map'),
  });
  await pages.editDraft(alice.ctx, page, { attachments: [ref] });
  await pages.publishPage(alice.ctx, page);
  return { alice, reader, editor, publisher, lib, page };
}

/** Everything a reader could ask of a page, each answered with its error code or 'no error'. */
async function readerView(reader: Person, page: pages.PageRef) {
  const { heads } = await pages.loadPage(reader.ctx, page.pageId).catch(() => ({
    heads: null,
  }));
  return { heads, ...(await readerRoutes(reader, page)) };
}

async function readerRoutes(reader: Person, page: pages.PageRef) {
  const tree = await reader.api.call(structureRoutes.tree, {
    params: { spaceId: page.spaceId },
  });
  return {
    info: await rejection(pages.loadPage(reader.ctx, page.pageId)),
    history: await rejection(
      reader.api.call(pageRoutes.history, { params: { pageId: page.pageId } }),
    ),
    target: await rejection(
      reader.api.call(structureRoutes.target, {
        params: { spaceId: page.spaceId },
        query: { nodeId: page.pageId },
      }),
    ),
    inTree: tree.pages.some((p) => p.id === page.pageId),
  };
}

const fetched = async (person: Person, ids: readonly RevisionId[]) =>
  (await person.api.call(pageRoutes.fetchRevisions, { body: { ids: [...ids] } })).revisions.map(
    (r) => r.revision.record.revisionId,
  );

const download = (person: Person, blobHash: string) =>
  rejection(person.api.download(pageRoutes.BLOB_DOWNLOAD_PATH.replace(':hash', blobHash)));

describe('unpublishing a page', () => {
  it('leaves readers nothing of it on any route, and editors everything', async () => {
    const { alice, reader, editor, page } = await world();
    const head = await publishedHead(alice, page.pageId);
    const [published] = (await pages.openRevisions(reader.ctx, page, 'published', [head])).values();
    const ref =
      published?.opened.kind === 'current' ? published.opened.payload.attachments[0] : null;
    if (!ref) throw new Error('expected the published attachment');
    expect(await download(reader, ref.blobHash)).toBe('no error');
    expect(await readerRoutes(reader, page)).toEqual({
      info: 'no error',
      history: 'no error',
      target: 'no error',
      inTree: true,
    });

    await pages.unpublishPage(alice.ctx, page, await seen(alice, page.pageId));

    expect(await readerRoutes(reader, page)).toEqual({
      info: 'not-found',
      history: 'not-found',
      target: 'not-found',
      inTree: false,
    });
    expect(await fetched(reader, [head])).toEqual([]);
    expect(await download(reader, ref.blobHash)).toBe('not-found');

    // Editors keep the page, its whole history and the published copy, and can restore it.
    const info = await pages.loadPage(editor.ctx, page.pageId);
    expect(info.heads).toMatchObject({
      publishedHead: null,
      publishedCount: 2,
      draftChanges: true,
    });
    expect((await pages.loadHistory(editor.ctx, page)).map((v) => v.revisionId)).toContain(head);
    expect(await fetched(editor, [head])).toEqual([head]);
    expect(await download(editor, ref.blobHash)).toBe('no error');
    expect(await rejection(pages.restorePublished(editor.ctx, page, head))).toBe('no error');
  });

  it('starts a new reader history when the page is published again', async () => {
    const { alice, reader, publisher, page } = await world();
    const earlier = (await pages.loadHistory(alice.ctx, page)).map((v) => v.revisionId);
    await pages.unpublishPage(publisher.ctx, page, await seen(publisher, page.pageId));
    await pages.editDraft(publisher.ctx, page, { markdown: 'new words', attachments: [] });
    await pages.publishPage(publisher.ctx, page);
    const again = await publishedHead(alice, page.pageId);

    const view = await readerView(reader, page);
    expect(view).toMatchObject({ info: 'no error', history: 'no error', inTree: true });
    expect(view.heads).toMatchObject({ publishedHead: again, publishedCount: 1 });
    expect((await pages.loadHistory(reader.ctx, page)).map((v) => v.revisionId)).toEqual([again]);
    expect(await fetched(reader, [...earlier, again])).toEqual([again]);
    // Owners and editors still see every version, in order.
    expect((await pages.loadHistory(alice.ctx, page)).map((v) => v.revisionId)).toEqual([
      again,
      ...earlier,
    ]);
  });

  it('keeps an earlier copy of an attachment from readers unless the new history lists it', async () => {
    const { alice, reader, page } = await world();
    const first = await publishedHead(alice, page.pageId);
    const [opened] = (await pages.openRevisions(alice.ctx, page, 'published', [first])).values();
    const old = opened?.opened.kind === 'current' ? opened.opened.payload.attachments[0] : null;
    if (!old) throw new Error('expected the published attachment');
    await pages.unpublishPage(alice.ctx, page, await seen(alice, page.pageId));
    await pages.editDraft(alice.ctx, page, { markdown: 'without the map', attachments: [] });
    await pages.publishPage(alice.ctx, page);
    expect(await download(reader, old.blobHash)).toBe('not-found');
  });

  it('is for publishers, of the publication they saw', async () => {
    const { alice, reader, editor, publisher, page } = await world();
    const before = await seen(alice, page.pageId);
    expect(await rejection(pages.unpublishPage(reader.ctx, page, before))).toBe('not-found');
    expect(await rejection(pages.unpublishPage(editor.ctx, page, before))).toBe('forbidden');
    // A stale publication changes nothing, and names the heads.
    await pages.editDraft(alice.ctx, page, { markdown: 'later' });
    await pages.publishPage(alice.ctx, page);
    const stale = await pages.unpublishPage(publisher.ctx, page, before).catch((e: unknown) => e);
    expect(stale).toMatchObject({
      code: 'stale-head',
      detail: { publishedHead: await publishedHead(alice, page.pageId) },
    });
  });
});
