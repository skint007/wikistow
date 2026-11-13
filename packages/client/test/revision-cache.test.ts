import { pageRoutes } from '@wikistow/contracts';
import { describe, expect, it } from 'vite-plus/test';
import {
  acceptOwners,
  closeSession,
  createApiClient,
  FolderKeyring,
  keyHash,
  MemoryKeyVersionMarks,
  newContactsPayloads,
  newId,
  pageOperations as pages,
  RevisionCache,
  SpaceId,
  type ClientContext,
} from '../src/index.ts';
import { buildWorld } from './fixture/world.ts';

/** The fixture server through the operations' HTTP contract. */
function fixture() {
  const world = buildWorld();
  const { owner, server, installationId, spaceId } = world;
  // How often it was asked, and whether it answers.
  const served = { asked: 0, down: false };
  const ctx: ClientContext = {
    api: createApiClient({
      fetch: async (_url, init) => {
        served.asked += 1;
        if (served.down) throw new TypeError('Failed to fetch');
        if (typeof init.body !== 'string') throw new Error('expected a JSON request');
        const { ids } = pageRoutes.fetchRevisions.body.parse(JSON.parse(init.body));
        const revisions = ids.flatMap((revisionId) => {
          const served = server.fetchRevision(owner.id, revisionId);
          if (!served) return [];
          return [
            {
              ...served,
              wrap: null,
              meta: {
                createdAt: TAKEN,
                draftSeq: 1,
                publishedSeq: null,
                restoredFrom: null,
              },
            },
          ];
        });
        return new Response(JSON.stringify({ revisions, deferred: [] }));
      },
    }),
    installationId,
    identity: owner.identity,
    trust: owner.trust,
    contacts: {
      book: { record: null, sealed: null, payloads: newContactsPayloads(), mark: null },
      pending: [],
    },
    keyring: new FolderKeyring(),
    revisions: new RevisionCache(),
    marks: new MemoryKeyVersionMarks(),
    spaces: new Map(),
  };
  const owners = acceptOwners({
    installationId,
    spaceId,
    self: owner.identity.public,
    trust: owner.trust,
    entry: {
      spaceId,
      owners: [{ id: owner.id, keyHash: keyHash(owner.identity.public) }],
      removedOwners: [],
    },
    nameRecords: [],
    statements: [],
    envelopes: [],
    listedOwners: [owner.identity.public],
    directory: [],
  });
  ctx.spaces.set(
    spaceId,
    Promise.resolve({
      spaceId,
      owners,
      listed: [],
      permissionVersion: 1,
      statements: [],
      envelopes: [],
      refused: [],
    }),
  );
  return { world, ctx, served };
}

const TAKEN = '2026-11-13T09:30:00.000Z';

describe('opened revisions in one session', () => {
  it('come with when the server took them, and one held without is asked for again when wanted', async () => {
    const { ctx, world, served } = fixture();
    const wanted = {
      spaceId: world.spaceId,
      pageId: world.page,
      audience: 'draft' as const,
      revisionId: world.revisions.privateDraft,
    };
    const revision = await pages.openRevisionOf(ctx, wanted, wanted.audience, wanted.revisionId);
    expect(revision.createdAt).toBe(TAKEN);
    // As one kept on the device before times were.
    ctx.revisions.clear();
    const untimed = { ...revision, createdAt: null };
    ctx.revisions.put(untimed);
    const fetch = (options: pages.RevisionOptions) =>
      pages
        .fetchRevisions(ctx, world.spaceId, new Map([[wanted.revisionId, wanted]]), options)
        .then((fetched) => fetched.get(wanted.revisionId)?.());
    served.asked = 0;
    expect((await fetch({}))?.createdAt).toBeNull();
    expect(served.asked).toBe(0);
    // With no answer, the one held stands in.
    served.down = true;
    expect(await fetch({ timed: true })).toEqual(untimed);
    expect(served.asked).toBe(1);
    served.down = false;
    expect((await fetch({ timed: true }))?.createdAt).toBe(TAKEN);
    // Held with its time from then on.
    served.asked = 0;
    expect((await fetch({ timed: true }))?.createdAt).toBe(TAKEN);
    expect(served.asked).toBe(0);
  });

  it('checks space, page and audience even when the revision ID is cached', async () => {
    const { ctx, world } = fixture();
    const wanted = {
      spaceId: world.spaceId,
      pageId: world.page,
      audience: 'draft' as const,
      revisionId: world.revisions.privateDraft,
    };
    await pages.openRevisionOf(ctx, wanted, wanted.audience, wanted.revisionId);
    expect(ctx.revisions.get(wanted)).toBeDefined();
    expect(ctx.revisions.get({ ...wanted, spaceId: newId(SpaceId) })).toBeUndefined();
    expect(ctx.revisions.get({ ...wanted, pageId: world.privatePage })).toBeUndefined();
    expect(ctx.revisions.get({ ...wanted, audience: 'published' })).toBeUndefined();
    await expect(
      pages.openRevisionOf(
        ctx,
        { ...wanted, pageId: world.privatePage },
        'draft',
        wanted.revisionId,
      ),
    ).rejects.toMatchObject({ code: 'binding-mismatch' });
  });

  it('clears on lock and drops a late put, even without a generation token', async () => {
    const { ctx, world } = fixture();
    const wanted = {
      spaceId: world.spaceId,
      pageId: world.page,
      audience: 'draft' as const,
      revisionId: world.revisions.privateDraft,
    };
    const revision = await pages.openRevisionOf(ctx, wanted, wanted.audience, wanted.revisionId);
    closeSession(ctx);
    expect(ctx.revisions.get(wanted)).toBeUndefined();
    ctx.revisions.put(revision);
    ctx.revisions.clear();
    ctx.revisions.put(revision);
    expect(ctx.revisions.get(wanted)).toBeUndefined();
    // A put taken before a clear, in a cache still open, is dropped too.
    const cache = new RevisionCache();
    const generation = cache.generation;
    cache.clear();
    cache.put(revision, generation);
    expect(cache.get(wanted)).toBeUndefined();
  });
});
