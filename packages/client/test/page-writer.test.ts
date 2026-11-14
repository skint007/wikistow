// Where the page writer sends each write (ADR 0009, decision 7): to the
// server, or into this device's queue offline, online while what it writes
// on has a change waiting, and after a request that got no answer, under
// the IDs it was sent with. A refusal is the caller's to show, and nothing
// is queued. Over a queue in memory and a fake server.
import { describe, expect, it } from 'vite-plus/test';
import {
  ApiError,
  createPageWriter,
  FolderId,
  generateIdentity,
  IdentityId,
  InstallationId,
  keptOperations,
  memoryKeptStore,
  newFolderMetadata,
  newId,
  newPayload,
  OWNER_REGION,
  PageId,
  RevisionId,
  SpaceId,
  sealAttachment,
  type pageOperations,
  type ServerWrites,
} from '../src/index.ts';

type Connection = 'online' | 'offline' | 'no answer' | 'refused';

/** A writer over a fresh queue, with a server that records what it's asked. */
async function writerOn(connection: Connection) {
  const installationId = newId(InstallationId);
  const identity = generateIdentity({ id: newId(IdentityId), kind: 'human' });
  const kept = await keptOperations.KeptContent.open(memoryKeptStore(), {
    identity,
    installationId,
  });
  const queue = kept.queue;
  const asked: (keyof ServerWrites)[] = [];
  // The IDs the last request was sent with.
  const sent: {
    pageId?: PageId;
    revisionId?: RevisionId;
    folderId?: FolderId;
    markdown?: string | undefined;
  } = {};
  const answer = <T>(call: keyof ServerWrites, value: T): Promise<T> => {
    asked.push(call);
    if (connection === 'no answer') return Promise.reject(new ApiError(0, 'network', 'No answer'));
    if (connection === 'refused') return Promise.reject(new ApiError(404, 'not-found', 'Gone'));
    return Promise.resolve(value);
  };
  const server: ServerWrites = {
    createPage: ({ pageId, revisionId, markdown }) => {
      Object.assign(sent, { pageId, revisionId, markdown });
      return answer('createPage', pageId);
    },
    createFolder: ({ folderId }) => {
      sent.folderId = folderId;
      return answer('createFolder', undefined);
    },
    saveDraft: ({ revisionId = newId(RevisionId), payload }) => {
      sent.revisionId = revisionId;
      return answer('saveDraft', {
        revisionId,
        repaired: false,
        region: OWNER_REGION,
        payload,
        inUse: payload,
        renamed: [],
        linksKept: false,
      });
    },
    uploadAttachment: (page, file) =>
      answer(
        'uploadAttachment',
        sealAttachment({ target: { installationId, ...page, audience: 'draft' }, ...file }).ref,
      ),
    uploadBlob: () => answer('uploadBlob', undefined),
    updateMetadata: () => answer('updateMetadata', undefined),
    deleteNode: () => answer('deleteNode', undefined),
  };
  const writer = createPageWriter({ queue, server, isOnline: () => connection !== 'offline' });
  return { writer, queue, sent, calls: () => asked };
}

const file = { name: 'a.txt', mediaType: 'text/plain', bytes: new Uint8Array([1, 2, 3]) };

/** A page the server has, and its draft. */
const pageOnServer = () => {
  const page: pageOperations.PageRef = { spaceId: newId(SpaceId), pageId: newId(PageId) };
  return {
    page,
    basedOn: newId(RevisionId),
    payload: newPayload({ title: 'Lisbon', markdown: 'Hi' }),
  };
};

const CONNECTIONS: Connection[] = ['online', 'offline', 'no answer', 'refused'];
const cases = CONNECTIONS.flatMap((connection) =>
  [false, true].map((waiting) => ({ connection, waiting })),
);

// Where a write goes: the server alone, the queue alone (the server never
// asked), the queue after the server was asked and didn't answer, or
// nowhere, as the server refused it.
const where = ({ connection, waiting }: { connection: Connection; waiting: boolean }) => {
  if (connection === 'offline' || waiting) return 'queue';
  return connection === 'online' ? 'server' : connection === 'no answer' ? 'lost' : 'refused';
};

describe('the page writer', () => {
  describe.each(cases)('$connection, with a change waiting: $waiting', (row) => {
    const expected = where(row);

    it('saves a draft', async () => {
      const { writer, queue, sent, calls } = await writerOn(row.connection);
      const { page, basedOn, payload } = pageOnServer();
      let seen: number | null = null;
      if (row.waiting) {
        seen = await queue.saveDraft({ page, basedOn, region: null, payload, seen: null });
      }
      const drafts = writer.draft(page, { seen });
      const next = { ...payload, markdown: 'Hi again' };

      const saving = drafts.save({ basedOn, payload: next });

      if (expected === 'refused') {
        await expect(saving).rejects.toMatchObject({ code: 'not-found' });
        expect(calls()).toEqual(['saveDraft']);
        expect(await queue.entries()).toEqual([]);
        return;
      }
      const written = await saving;
      const entry = await queue.entry(page.pageId);
      if (expected === 'server') {
        expect(calls()).toEqual(['saveDraft']);
        expect(entry).toBeNull();
        expect(written.linksKept).toBe(false);
        return;
      }
      // Into the queue, shown as saved on its base, as typed.
      expect(written).toMatchObject({ revisionId: basedOn, payload: next, linksKept: true });
      expect(entry).toMatchObject({ kind: 'page', basedOn, payload: { markdown: 'Hi again' } });
      if (expected === 'queue') {
        expect(calls()).toEqual([]);
        expect(entry).toMatchObject({ sending: null });
      } else {
        // Kept under the revision ID it was sent with, to be sent again under it.
        expect(calls()).toEqual(['saveDraft']);
        expect(entry).toMatchObject({ sending: { revisionId: sent.revisionId } });
      }
      // The next save goes on top of what's waiting.
      expect(await drafts.waitingHead()).toBe(basedOn);
    });

    it('makes a page', async () => {
      const { writer, queue, sent, calls } = await writerOn(row.connection);
      const spaceId = newId(SpaceId);
      const parentId = row.waiting
        ? (await queue.newFolder({ spaceId, parentId: null, metadata: newFolderMetadata('Trips') }))
            .id
        : newId(FolderId);

      const making = writer.newPage({ spaceId, parentId, title: 'Lisbon' });

      if (expected === 'refused') {
        await expect(making).rejects.toMatchObject({ code: 'not-found' });
        expect(calls()).toEqual(['createPage']);
        expect(await queue.entries()).toEqual([]);
        return;
      }
      const pageId = await making;
      const entry = await queue.entry(pageId);
      if (expected === 'server') {
        expect(calls()).toEqual(['createPage']);
        expect(sent.pageId).toBe(pageId);
        expect(entry).toBeNull();
        return;
      }
      expect(entry).toMatchObject({
        kind: 'page',
        spaceId,
        newPage: { parentId },
        payload: { title: 'Lisbon' },
      });
      if (expected === 'queue') {
        expect(calls()).toEqual([]);
      } else {
        // The page's ID and its first draft's are the ones the request used.
        expect(calls()).toEqual(['createPage']);
        expect(sent.pageId).toBe(pageId);
        expect(entry).toMatchObject({
          newPage: { revisionId: sent.revisionId },
          sending: { revisionId: sent.revisionId },
        });
      }
    });

    it('makes a page with its first draft’s text, and names that draft', async () => {
      const { writer, queue, sent } = await writerOn(row.connection);
      const spaceId = newId(SpaceId);
      const parentId = row.waiting
        ? (await queue.newFolder({ spaceId, parentId: null, metadata: newFolderMetadata('Trips') }))
            .id
        : newId(FolderId);

      const making = writer.newPageDraft({ spaceId, parentId, title: 'Lisbon', markdown: 'Hi' });

      if (expected === 'refused') {
        await expect(making).rejects.toMatchObject({ code: 'not-found' });
        return;
      }
      const { pageId, revisionId } = await making;
      const entry = await queue.entry(pageId);
      if (expected === 'server') {
        expect(sent).toMatchObject({ pageId, revisionId, markdown: 'Hi' });
        expect(entry).toBeNull();
      } else {
        expect(entry).toMatchObject({
          newPage: { revisionId },
          payload: { title: 'Lisbon', markdown: 'Hi' },
        });
      }
      // A save on top of it goes where the page is.
      const drafts = writer.draft({ spaceId, pageId }, { seen: null });
      const basedOn = (await drafts.waitingHead()) ?? revisionId;
      expect(basedOn).toBe(revisionId);
      await drafts.save({
        basedOn,
        payload: newPayload({ title: 'Lisbon', markdown: 'Hi there' }),
      });
      if (expected !== 'server') {
        expect(await queue.entry(pageId)).toMatchObject({ payload: { markdown: 'Hi there' } });
      }
    });

    it('makes a folder', async () => {
      const { writer, queue, sent, calls } = await writerOn(row.connection);
      const spaceId = newId(SpaceId);
      const parentId = row.waiting
        ? (await queue.newFolder({ spaceId, parentId: null, metadata: newFolderMetadata('Trips') }))
            .id
        : null;

      const making = writer.newFolder({ spaceId, parentId, name: 'Photos' });

      if (expected === 'refused') {
        await expect(making).rejects.toMatchObject({ code: 'not-found' });
        expect(calls()).toEqual(['createFolder']);
        expect(await queue.entries()).toEqual([]);
        return;
      }
      const folderId = await making;
      const entry = await queue.entry(folderId);
      if (expected === 'server') {
        expect(calls()).toEqual(['createFolder']);
        expect(sent.folderId).toBe(folderId);
        expect(entry).toBeNull();
        return;
      }
      expect(entry).toMatchObject({ kind: 'folder', spaceId, parentId });
      if (expected === 'queue') {
        expect(calls()).toEqual([]);
      } else {
        // Under the ID the request used.
        expect(calls()).toEqual(['createFolder']);
        expect(sent.folderId).toBe(folderId);
      }
    });

    it('adds a file', async () => {
      const { writer, queue, calls } = await writerOn(row.connection);
      const { page, basedOn, payload } = pageOnServer();
      if (row.waiting) await queue.saveDraft({ page, basedOn, region: null, payload, seen: null });

      const added = writer.attach(page, file);

      if (expected === 'lost' || expected === 'refused') {
        // A file is no change to send later: it fails, as the upload did.
        await expect(added).rejects.toBeInstanceOf(ApiError);
        expect(calls()).toEqual(['uploadAttachment']);
        return;
      }
      const ref = await added;
      if (expected === 'server') {
        expect(calls()).toEqual(['uploadAttachment']);
        expect(await queue.held([ref])).toEqual([]);
      } else {
        // Sealed for the draft now, and kept here until a save naming it lands.
        expect(calls()).toEqual([]);
        expect(await queue.held([ref])).toEqual([ref]);
      }
    });
  });

  it('uploads files the queue holds before a save online, and lets go of them after', async () => {
    const { writer, queue, calls } = await writerOn('online');
    const { page, basedOn, payload } = pageOnServer();
    // Added while the page's draft saved into the queue, which has been sent since.
    const ref = await queue.attach(page, file);
    const drafts = writer.draft(page, { seen: null });

    await drafts.save({ basedOn, payload: { ...payload, attachments: [ref] } });

    expect(calls()).toEqual(['uploadBlob', 'saveDraft']);
    await expect.poll(() => queue.held([ref])).toEqual([]);
  });

  it('tells a conflict with another window’s change from one with the server', async () => {
    const { writer, queue } = await writerOn('online');
    const { page, basedOn, payload } = pageOnServer();
    const drafts = writer.draft(page, { seen: null });
    // Another window saved into the page's change after this one opened.
    await queue.saveDraft({ page, basedOn, region: null, payload, seen: null });

    await expect(drafts.save({ basedOn, payload })).rejects.toMatchObject({ code: 'stale-head' });
    expect(drafts.conflictWithDevice()).toBe(true);

    // Taking its head, the next save goes on top of it.
    expect(await drafts.waitingHead()).toBe(basedOn);
    expect(drafts.conflictWithDevice()).toBe(false);
    await drafts.save({ basedOn, payload: { ...payload, markdown: 'Mine' } });
    expect(await queue.entry(page.pageId)).toMatchObject({ payload: { markdown: 'Mine' } });
  });
});
