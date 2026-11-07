// Changes made offline, sent once the server answers (ADR 0009, decision 7):
// in order, under the IDs recorded before each request, so a lost answer is
// told from a change that never landed, and a page changed or trashed
// meanwhile waits for the person rather than being overwritten.
import {
  createApiClient,
  memoryKeptStore,
  newId,
  newFolderMetadata,
  newPayload,
  openSession,
  PageId,
  pageOperations as pages,
  RevisionId,
  spaceOperations as spaces,
  trashOperations as trash,
  utf8,
  type ClientContext,
} from '@wikistow/client';
import { pageRoutes, structureRoutes } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/** A person whose session keeps a queue on the device, with a page in a space of theirs. */
async function device() {
  const person = await personWithVault(t);
  const ctx = await openSession(person.api, person.vault, { content: memoryKeptStore() });
  const queue = ctx.keptContent?.queue;
  if (!queue) throw new Error('The session keeps nothing');
  const spaceId = await spaces.createSpace(ctx, { name: 'Notes' });
  const pageId = await pages.createPage(ctx, {
    spaceId,
    parentId: null,
    title: 'Plan',
    markdown: 'first words',
  });
  const page: pages.PageRef = { spaceId, pageId };
  const head = async (at = page) => (await pages.loadPage(ctx, at.pageId)).heads.draftHead;
  const based = await head();
  if (!based) throw new Error('No draft');
  // The same session, whose answers to `path` are lost: the request lands, its answer doesn't.
  const losing = (path: string): ClientContext => ({
    ...ctx,
    api: createApiClient({
      fetch: async (url, init) => {
        const answer = await person.browser.fetch(url, init);
        if (init?.method === 'POST' || init?.method === 'PUT') {
          if (new URL(url, 'http://app').pathname === path) throw new TypeError('Lost');
        }
        return answer;
      },
    }),
  });
  const draft = async (at = page) => {
    const id = await head(at);
    if (!id) throw new Error('No draft');
    const opened = await pages.openRevisionOf(ctx, at, 'draft', id, { fresh: true });
    if (opened.opened.kind !== 'current') throw new Error('Not readable');
    return { ...opened.opened.payload, basedOn: opened.record.basedOn };
  };
  const payload = (markdown: string) => newPayload({ title: 'Plan', markdown });
  return { person, ctx, queue, spaceId, page, based, head, draft, losing, payload };
}

describe('changes made offline', () => {
  it('go in order: a folder, then a page in it with a file, made in two steps', async () => {
    const { ctx, queue, spaceId, draft } = await device();
    const folder = await queue.newFolder({
      spaceId,
      parentId: null,
      metadata: newFolderMetadata('Trips'),
    });
    const made = await queue.newPage({
      spaceId,
      parentId: folder.id,
      payload: newPayload({ title: 'Packing', markdown: 'socks' }),
    });
    const at = { spaceId, pageId: made.id };
    if (!made.newPage) throw new Error('Not a new page');
    const ref = await queue.attach(at, {
      name: 'list.txt',
      mediaType: 'text/plain',
      bytes: utf8('tent'),
    });
    await queue.saveDraft({
      page: at,
      basedOn: made.newPage.revisionId,
      region: null,
      payload: { ...made.payload, attachments: [ref] },
      seen: made.version,
    });
    // A file attached since the last save, which no entry names yet, stays for the next.
    const next = await queue.attach(at, {
      name: 'later.txt',
      mediaType: 'text/plain',
      bytes: utf8('stove'),
    });

    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect(await queue.blob(next.blobHash)).not.toBeNull();
    const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
    expect(tree.folders.map((f) => f.id)).toContain(folder.id);
    expect(tree.pages.find((p) => p.id === made.id)?.parentId).toBe(folder.id);
    const sent = await draft(at);
    expect(sent.markdown).toBe('socks');
    expect(sent.attachments.map((a) => a.name)).toEqual(['list.txt']);
    // Its second step is on top of the first draft, made with the ID recorded for it.
    expect(sent.basedOn).toBe(made.newPage.revisionId);
    const file = await pages.readAttachment(ctx, at, 'draft', sent.attachments[0]!);
    expect(new TextDecoder().decode(file)).toBe('tent');
  });

  it('resend a version whose answer was lost under its recorded ID, and land it once', async () => {
    const { ctx, queue, page, based, head, draft, losing, payload } = await device();
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('offline words'),
      seen: null,
    });
    const path = pageRoutes.saveDraft.path.replace(':pageId', page.pageId);

    expect(await queue.send(losing(path))).toBe('offline');
    const [waiting] = await queue.entries();
    const recorded = waiting?.kind === 'page' ? waiting.sending?.revisionId : undefined;
    // It landed; only its answer was lost.
    expect(await head()).toBe(recorded);

    // Typed into since: the recorded version goes again, `duplicate` says it
    // landed, and what was typed since goes on top of it.
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('and more'),
      seen: waiting?.kind === 'page' ? waiting.version : null,
    });
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    const now = await draft();
    expect(now.markdown).toBe('and more');
    expect(now.basedOn).toBe(recorded);
  });

  it('make a page whose answer was lost only once', async () => {
    const { ctx, queue, spaceId, losing, draft } = await device();
    const made = await queue.newPage({
      spaceId,
      parentId: null,
      payload: newPayload({ title: 'Once', markdown: 'only once' }),
    });
    const path = pageRoutes.createPage.path.replace(':spaceId', spaceId);
    expect(await queue.send(losing(path))).toBe('offline');
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    const at = { spaceId, pageId: made.id };
    expect((await draft(at)).markdown).toBe('only once');
    const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
    expect(tree.pages.filter((p) => p.id === made.id)).toHaveLength(1);

    // The app's own create got no answer (`PageWriter.newPage`): the page is queued
    // under the IDs it sent, and what is typed into it later goes on top.
    const pageId = newId(PageId);
    const revisionId = newId(RevisionId);
    await pages.createPage(ctx, { spaceId, parentId: null, title: 'Typed', pageId, revisionId });
    const lost = await queue.newPage({
      spaceId,
      parentId: null,
      payload: newPayload({ title: 'Typed', markdown: '' }),
      pageId,
      revisionId,
    });
    const typed = { spaceId, pageId };
    await queue.saveDraft({
      page: typed,
      basedOn: revisionId,
      region: null,
      payload: { ...lost.payload, markdown: 'typed offline' },
      seen: lost.version,
    });
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    const sent = await draft(typed);
    expect(sent.markdown).toBe('typed offline');
    expect(sent.basedOn).toBe(revisionId);
  });

  it('wait as a conflict when someone saved since, and go on top once the person chooses', async () => {
    const { ctx, queue, page, based, head, draft, payload } = await device();
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('mine'),
      seen: null,
    });
    // Meanwhile, from another device.
    await pages.editDraft(ctx, page, { markdown: 'theirs' });
    const theirs = await head();

    expect(await queue.send(ctx)).toBe('sent');
    const [stopped] = await queue.entries();
    expect(stopped?.failure).toEqual({ kind: 'conflict' });
    expect((await draft()).markdown).toBe('theirs');

    // Save mine on top: the entry is based on theirs now, and goes.
    if (!theirs) throw new Error('No draft');
    await queue.saveDraft({
      page,
      basedOn: theirs,
      region: null,
      payload: payload('mine'),
      seen: stopped?.kind === 'page' ? stopped.version : null,
    });
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    const now = await draft();
    expect(now.markdown).toBe('mine');
    expect(now.basedOn).toBe(theirs);
  });

  it('go on top of theirs when the person chose so before the change was sent', async () => {
    const { ctx, queue, page, based, head, draft, payload } = await device();
    const first = await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('mine'),
      seen: null,
    });
    await pages.editDraft(ctx, page, { markdown: 'theirs' });
    const theirs = await head();
    if (!theirs) throw new Error('No draft');
    // The draft view saw their draft first, and the person chose Save mine on top.
    await queue.saveDraft({
      page,
      basedOn: theirs,
      region: null,
      payload: payload('mine'),
      seen: first,
      onTop: true,
    });
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect((await draft()).basedOn).toBe(theirs);
  });

  it('wait as gone for a page put in the trash, sent once restored, or saved as a new page', async () => {
    const { ctx, queue, spaceId, page, based, draft, payload } = await device();
    const ref = await queue.attach(page, {
      name: 'photo.txt',
      mediaType: 'text/plain',
      bytes: utf8('a photo'),
    });
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: { ...payload('kept words'), attachments: [ref] },
      seen: null,
    });
    await pages.deleteNode(ctx, { spaceId, nodeId: page.pageId });

    expect(await queue.send(ctx)).toBe('sent');
    expect((await queue.entry(page.pageId))?.failure).toEqual({ kind: 'gone' });

    // An owner restores it: Try again sends it.
    await trash.restoreDeleted(ctx, page.pageId);
    await queue.retry(page.pageId);
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect((await draft()).markdown).toBe('kept words');

    // Gone again with a change waiting: saved as a new page in the home space
    // instead, with the file added offline. The one sent before isn't on this
    // device (nothing kept it), so it is left out.
    const later = await pages.loadPage(ctx, page.pageId);
    if (!later.heads.draftHead) throw new Error('No draft');
    const another = await queue.attach(page, {
      name: 'another.txt',
      mediaType: 'text/plain',
      bytes: utf8('another photo'),
    });
    await queue.saveDraft({
      page,
      basedOn: later.heads.draftHead,
      region: null,
      payload: { ...payload('rescued words'), attachments: [ref, another] },
      seen: null,
    });
    const entry = await queue.entry(page.pageId);
    if (entry?.kind !== 'page') throw new Error('No change');
    expect((await queue.filesHere(ctx, entry)).missing.map((a) => a.name)).toEqual(['photo.txt']);
    await pages.deleteNode(ctx, { spaceId, nodeId: page.pageId });
    expect(await queue.send(ctx)).toBe('sent');
    const home = await spaces.createSpace(ctx, { name: 'Home' });
    const rescued = await queue.saveAsNewPage(ctx, page.pageId, home);
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    const copy = await draft({ spaceId: home, pageId: rescued });
    expect(copy.markdown).toBe('rescued words');
    expect(copy.attachments.map((a) => a.name)).toEqual(['another.txt']);
    const file = await pages.readAttachment(
      ctx,
      { spaceId: home, pageId: rescued },
      'draft',
      copy.attachments[0]!,
    );
    expect(new TextDecoder().decode(file)).toBe('another photo');
  });
});
