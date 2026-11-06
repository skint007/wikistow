// New pages and folders under a folder made offline that is still only on
// this device (ADR 0009, decision 7): they go into the queue under it, online
// too, since the server doesn't know the folder yet and would refuse them.
import {
  createApiClient,
  FolderKeyring,
  generateIdentity,
  IdentityId,
  InstallationId,
  keptOperations,
  memoryKeptStore,
  MemoryKeyVersionMarks,
  newContactsPayloads,
  newFolderMetadata,
  newId,
  RevisionCache,
  SpaceId,
  TrustStore,
  type ClientContext,
} from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { connection } from '../src/data/connection.ts';
import { makeFolder, makePage } from '../src/data/offline-changes.ts';

/**
 * A session online whose queue is in memory, counting what the server is
 * asked. The server answers `not-found`, as it does for a parent it doesn't know.
 */
async function device() {
  const installationId = newId(InstallationId);
  const identity = generateIdentity({ id: newId(IdentityId), kind: 'human' });
  const asked: string[] = [];
  const ctx: ClientContext = {
    api: createApiClient({
      fetch: async (url) => {
        asked.push(String(url));
        return Response.json(
          { error: { code: 'not-found', message: 'Not found' } },
          { status: 404 },
        );
      },
    }),
    installationId,
    identity,
    trust: new TrustStore(installationId),
    contacts: {
      book: { record: null, sealed: null, payloads: newContactsPayloads(), mark: null },
      pending: [],
    },
    keyring: new FolderKeyring(),
    revisions: new RevisionCache(),
    marks: new MemoryKeyVersionMarks(),
    spaces: new Map(),
    keptContent: await keptOperations.KeptContent.open(memoryKeptStore(), {
      identity,
      installationId,
    }),
  };
  const queue = ctx.keptContent?.queue;
  if (!queue) throw new Error('The session keeps nothing');
  return { ctx, queue, asked };
}

describe('making pages and folders online', () => {
  it('queues them under a folder made offline and not sent yet', async () => {
    expect(connection.get().online).toBe(true);
    const { ctx, queue, asked } = await device();
    const spaceId = newId(SpaceId);
    const trips = await queue.newFolder({
      spaceId,
      parentId: null,
      metadata: newFolderMetadata('Trips'),
    });

    const pageId = await makePage(ctx, { spaceId, parentId: trips.id, title: 'Lisbon' });
    const folderId = await makeFolder(ctx, { spaceId, parentId: trips.id, name: 'Photos' });

    expect(asked).toEqual([]);
    expect(await queue.entry(pageId)).toMatchObject({
      kind: 'page',
      spaceId,
      newPage: { parentId: trips.id },
      payload: { title: 'Lisbon' },
    });
    expect(await queue.entry(folderId)).toMatchObject({
      kind: 'folder',
      spaceId,
      parentId: trips.id,
    });
  });
});
