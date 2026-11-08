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
  FolderId as FolderIdSchema,
  PageId,
  pageOperations as pages,
  publicLinkOperations as links,
  sharingOperations as sharing,
  type FolderId,
  type SpaceId,
  RevisionId,
  spaceOperations as spaces,
  trashOperations as trash,
  utf8,
  type ClientContext,
} from '@wikistow/client';
import { pageRoutes, sharingRoutes, structureRoutes } from '@wikistow/contracts';
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
        if (init?.method === 'POST' || init?.method === 'PUT' || init?.method === 'DELETE') {
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
    await queue.retry({ kind: 'page', id: page.pageId });
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

/** The folder's metadata as the server has it now, or null once it's gone. */
async function folderNow(ctx: ClientContext, spaceId: SpaceId, folderId: FolderId) {
  const { folders } = await spaces.loadStructure(ctx, spaceId);
  return folders.find((folder) => folder.id === folderId)?.metadata ?? null;
}

const nameOf = (metadata: Awaited<ReturnType<typeof folderNow>>) =>
  metadata?.opened.kind === 'current' ? metadata.opened.metadata.name : null;

// Folder renames and deletes made offline (#330): sent in order with the
// rest, refused as gone when the folder or page is, and a rename over
// someone else's as a conflict, with both names to choose from.
describe('renames and deletes made offline', () => {
  /** `device()` with a folder on the server, and its metadata as the tree shows it. */
  async function withFolder() {
    const made = await device();
    const folderId = await spaces.createFolder(made.ctx, {
      spaceId: made.spaceId,
      parentId: null,
      name: 'Trips',
    });
    const current = await folderNow(made.ctx, made.spaceId, folderId);
    if (!current) throw new Error('No folder');
    return { ...made, folderId, current };
  }

  it('rename a folder once, with the renames since folded in, and fold one made offline into its entry', async () => {
    const { ctx, queue, spaceId, folderId, current } = await withFolder();
    await queue.rename({ spaceId, folderId, current, changes: { name: 'Holidays' } });
    await queue.rename({ spaceId, folderId, current, changes: { emoji: '🏖️' } });
    expect(await queue.entries()).toHaveLength(1);
    // A folder made offline takes its rename into its own entry.
    const made = await queue.newFolder({
      spaceId,
      parentId: null,
      metadata: newFolderMetadata('Draft'),
    });
    await queue.rename({ spaceId, folderId: made.id, current, changes: { name: 'Ideas' } });
    expect((await queue.entries()).map((entry) => entry.kind)).toEqual(['rename', 'folder']);

    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    const now = await folderNow(ctx, spaceId, folderId);
    expect(now?.opened.kind === 'current' && now.opened.metadata).toMatchObject({
      name: 'Holidays',
      emoji: '🏖️',
    });
    expect(nameOf(await folderNow(ctx, spaceId, made.id))).toBe('Ideas');
  });

  it('land a rename whose answer was lost once', async () => {
    const { ctx, queue, spaceId, folderId, current, losing } = await withFolder();
    await queue.rename({ spaceId, folderId, current, changes: { name: 'Holidays' } });
    const path = structureRoutes.updateMetadata.path.replace(':spaceId', spaceId);
    expect(await queue.send(losing(path))).toBe('offline');
    // Sent again, `stale-head` is its own landed version.
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect(nameOf(await folderNow(ctx, spaceId, folderId))).toBe('Holidays');
  });

  it('wait as a conflict over someone else’s rename, and go on top of it once the person keeps their own', async () => {
    const { ctx, queue, spaceId, folderId, current } = await withFolder();
    await queue.rename({ spaceId, folderId, current, changes: { name: 'Mine' } });
    // Meanwhile, from another device.
    await spaces.updateMetadata(ctx, {
      spaceId,
      subject: { kind: 'folder', folderId },
      current,
      changes: { name: 'Theirs' },
    });

    expect(await queue.send(ctx)).toBe('sent');
    const [stopped] = await queue.entries();
    expect(stopped?.failure).toEqual({ kind: 'conflict' });
    expect(nameOf(await folderNow(ctx, spaceId, folderId))).toBe('Theirs');

    const theirs = await folderNow(ctx, spaceId, folderId);
    if (!theirs) throw new Error('No folder');
    await queue.renameOnTop(folderId, theirs);
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect(nameOf(await folderNow(ctx, spaceId, folderId))).toBe('Mine');
  });

  it('stop a rename of a folder gone meanwhile as gone', async () => {
    const { ctx, queue, spaceId, folderId, current } = await withFolder();
    await queue.rename({ spaceId, folderId, current, changes: { name: 'Holidays' } });
    await pages.deleteNode(ctx, { spaceId, nodeId: folderId });
    expect(await queue.send(ctx)).toBe('sent');
    expect((await queue.entries())[0]?.failure).toEqual({ kind: 'gone' });
  });

  it('send a draft before the delete made after it, so it goes to the trash with the page', async () => {
    const { ctx, queue, spaceId, page, based, draft, payload } = await device();
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('last words'),
      seen: null,
    });
    await queue.delete({ spaceId, id: page.pageId, node: 'page', name: 'Plan' });
    expect((await queue.waiting(page.pageId)).map((entry) => entry.kind)).toEqual([
      'page',
      'delete',
    ]);

    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect((await trash.loadTrash(ctx)).map((item) => item.nodeId)).toEqual([page.pageId]);
    await trash.restoreDeleted(ctx, page.pageId);
    expect((await draft()).markdown).toBe('last words');
  });

  it('land a delete whose answer was lost once', async () => {
    const { ctx, queue, spaceId, page, losing } = await device();
    await queue.delete({ spaceId, id: page.pageId, node: 'page', name: 'Plan' });
    const path = pageRoutes.deleteNode.path
      .replace(':spaceId', spaceId)
      .replace(':nodeId', page.pageId);
    expect(await queue.send(losing(path))).toBe('offline');
    // Sent again, `not-found` is its own delete, landed.
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect((await trash.loadTrash(ctx)).map((item) => item.nodeId)).toEqual([page.pageId]);
  });

  it('stop a delete of what someone deleted meanwhile as gone', async () => {
    const { ctx, queue, spaceId, page } = await device();
    await queue.delete({ spaceId, id: page.pageId, node: 'page', name: 'Plan' });
    await pages.deleteNode(ctx, { spaceId, nodeId: page.pageId });
    expect(await queue.send(ctx)).toBe('sent');
    expect((await queue.entries())[0]).toMatchObject({ kind: 'delete', failure: { kind: 'gone' } });
  });

  it('rename, then trash, a folder whose request to make it lost its answer', async () => {
    const { ctx, queue, spaceId, current } = await withFolder();
    // The app's own create landed, but got no answer (`PageWriter.newFolder`).
    const folderId = newId(FolderIdSchema);
    const metadata = newFolderMetadata('New folder');
    await spaces.createFolderAs(ctx, { spaceId, parentId: null, folderId, metadata });
    await queue.newFolder({ spaceId, parentId: null, metadata, folderId, tried: true });
    await queue.rename({ spaceId, folderId, current, changes: { name: 'Recipes' } });
    expect(await queue.send(ctx)).toBe('sent');
    expect(nameOf(await folderNow(ctx, spaceId, folderId))).toBe('Recipes');

    // Made the same way, then deleted offline: it may be on the server, so it goes to the trash.
    const again = newId(FolderIdSchema);
    await spaces.createFolderAs(ctx, { spaceId, parentId: null, folderId: again, metadata });
    await queue.newFolder({ spaceId, parentId: null, metadata, folderId: again, tried: true });
    expect(await queue.delete({ spaceId, id: again, node: 'folder', name: 'New folder' })).toBe(
      'waiting',
    );
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect((await trash.loadTrash(ctx)).map((item) => item.nodeId)).toEqual([again]);
  });

  it('drop a folder made offline, and what was made in it, without sending anything', async () => {
    const { ctx, queue, spaceId } = await device();
    const folder = await queue.newFolder({
      spaceId,
      parentId: null,
      metadata: newFolderMetadata('Trips'),
    });
    const inner = await queue.newFolder({
      spaceId,
      parentId: folder.id,
      metadata: newFolderMetadata('Gear'),
    });
    await queue.newPage({
      spaceId,
      parentId: inner.id,
      payload: newPayload({ title: 'Tent', markdown: '' }),
    });
    expect(await queue.delete({ spaceId, id: folder.id, node: 'folder', name: 'Trips' })).toBe(
      'dropped',
    );
    expect(await queue.entries()).toEqual([]);
    expect(await queue.send(ctx)).toBe('sent');
    const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
    expect(tree.folders).toEqual([]);
  });
});

// Moves within a space and publishing made offline (#331): sent in order
// after the changes they need, a lost answer told by where the item is, or
// by the publication's recorded ID, and a move across a share's edge, or a
// publish of a page that changed or got a public link, stopped with why.
describe('moves and publishes made offline', () => {
  const parentNow = async (ctx: ClientContext, spaceId: SpaceId, id: string) => {
    const tree = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
    return [...tree.folders, ...tree.pages].find((node) => node.id === id)?.parentId;
  };
  const published = async (ctx: ClientContext, page: pages.PageRef) => {
    const { heads } = await pages.loadPage(ctx, page.pageId);
    if (!heads.publishedHead) return null;
    const opened = await pages.openRevisionOf(ctx, page, 'published', heads.publishedHead);
    return opened.opened.kind === 'current'
      ? { markdown: opened.opened.payload.markdown, count: heads.publishedCount }
      : null;
  };

  it('move a page after its draft, into a folder made offline, landing a lost answer once', async () => {
    const { ctx, queue, spaceId, page, based, draft, losing, payload } = await device();
    const folder = await queue.newFolder({
      spaceId,
      parentId: null,
      metadata: newFolderMetadata('Trips'),
    });
    // A folder made offline moves in its own entry.
    const inner = await queue.newFolder({
      spaceId,
      parentId: null,
      metadata: newFolderMetadata('Gear'),
    });
    await queue.move({ spaceId, id: inner.id, node: 'folder', name: 'Gear', parentId: folder.id });
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('moved words'),
      seen: null,
    });
    await queue.move({ spaceId, id: page.pageId, node: 'page', name: 'Plan', parentId: inner.id });
    expect((await queue.entries()).map((entry) => entry.kind)).toEqual([
      'folder',
      'folder',
      'page',
      'move',
    ]);

    const path = sharingRoutes.move.path
      .replace(':spaceId', spaceId)
      .replace(':nodeId', page.pageId);
    expect(await queue.send(losing(path))).toBe('offline');
    expect(await parentNow(ctx, spaceId, page.pageId)).toBe(inner.id);
    // Sent again, it is where it was asked to go: landed.
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect(await parentNow(ctx, spaceId, inner.id)).toBe(folder.id);
    expect((await draft()).markdown).toBe('moved words');
  });

  it('stop a move across a shared folder’s edge, or into a folder gone meanwhile', async () => {
    const { ctx, queue, spaceId, page } = await device();
    const shared = await spaces.createFolder(ctx, { spaceId, parentId: null, name: 'Shared' });
    await sharing.shareFolder(ctx, {
      preview: await sharing.previewShare(ctx, { spaceId, rootId: shared }),
      people: [],
    });
    await queue.move({ spaceId, id: page.pageId, node: 'page', name: 'Plan', parentId: shared });
    expect(await queue.send(ctx)).toBe('sent');
    const [across] = await queue.entries();
    expect(across?.failure).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('who can read it'),
    });
    expect(await parentNow(ctx, spaceId, page.pageId)).toBeNull();

    await queue.discard({ kind: 'move', id: page.pageId });
    const gone = await spaces.createFolder(ctx, { spaceId, parentId: null, name: 'Old' });
    await queue.move({ spaceId, id: page.pageId, node: 'page', name: 'Plan', parentId: gone });
    await pages.deleteNode(ctx, { spaceId, nodeId: gone });
    expect(await queue.send(ctx)).toBe('sent');
    expect((await queue.entries())[0]).toMatchObject({ kind: 'move', failure: { kind: 'gone' } });
  });

  it('publish the draft as it stood when Publish was pressed, before what was typed after', async () => {
    const { ctx, queue, page, based, draft, payload } = await device();
    const first = await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('ready words'),
      seen: null,
    });
    await queue.publish({ page, title: 'Plan', draftHead: based });
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('half typed'),
      seen: first,
    });

    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect(await published(ctx, page)).toEqual({ markdown: 'ready words', count: 1 });
    const now = await draft();
    expect(now.markdown).toBe('half typed');
    // On top of the draft it published, which went first.
    const { heads } = await pages.loadPage(ctx, page.pageId);
    const history = await pages.loadHistory(ctx, page);
    const publication = history.find((version) => version.revisionId === heads.publishedHead);
    expect(now.basedOn).toBe(publication?.basedOn);
  });

  it('publish the draft after its change, and once when the answer was lost', async () => {
    const { ctx, queue, page, based, losing, payload } = await device();
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('all done'),
      seen: null,
    });
    await queue.publish({ page, title: 'Plan', draftHead: based });
    const path = pageRoutes.publish.path.replace(':pageId', page.pageId);
    expect(await queue.send(losing(path))).toBe('offline');
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect(await published(ctx, page)).toEqual({ markdown: 'all done', count: 1 });
  });

  it('send the draft a publish saved first, whose answer was lost, as the page’s own when published again', async () => {
    const { ctx, queue, page, based, draft, losing, payload } = await device();
    const ready = await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('ready'),
      seen: null,
    });
    await queue.publish({ page, title: 'Plan', draftHead: based });
    const more = await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('more'),
      seen: ready,
    });
    const path = pageRoutes.saveDraft.path.replace(':pageId', page.pageId);
    // The draft as it stood lands, but its answer is lost.
    expect(await queue.send(losing(path))).toBe('offline');
    expect((await draft()).markdown).toBe('ready');

    // Typed on, and published again.
    await queue.saveDraft({
      page,
      basedOn: based,
      region: null,
      payload: payload('final'),
      seen: more,
    });
    await queue.publish({ page, title: 'Plan', draftHead: based });
    expect(await queue.send(ctx)).toBe('sent');
    expect(await queue.entries()).toEqual([]);
    expect(await published(ctx, page)).toEqual({ markdown: 'final', count: 1 });
  });

  it('stop a publish of a page changed meanwhile, or given a public link, with why', async () => {
    const { ctx, queue, page, based } = await device();
    await queue.publish({ page, title: 'Plan', draftHead: based });
    // Meanwhile, from another device.
    await pages.editDraft(ctx, page, { markdown: 'someone else’s words' });
    expect(await queue.send(ctx)).toBe('sent');
    expect((await queue.entries())[0]?.failure).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('changed after you pressed Publish'),
    });
    expect(await published(ctx, page)).toBeNull();

    await queue.discard({ kind: 'publish', id: page.pageId });
    await pages.publishPage(ctx, page);
    await links.turnOn(ctx, page.pageId);
    const head = (await pages.loadPage(ctx, page.pageId)).heads.draftHead;
    if (!head) throw new Error('No draft');
    await queue.publish({ page, title: 'Plan', draftHead: head });
    expect(await queue.send(ctx)).toBe('sent');
    expect((await queue.entries())[0]?.failure).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining('public link'),
    });
    expect((await published(ctx, page))?.count).toBe(1);
  });
});
