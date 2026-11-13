// What a device keeps for offline use (ADR 0009, step 2): the keeper over a
// fake server, and what the store holds afterwards.
import { describe, expect, it } from 'vite-plus/test';
import {
  AttachmentId,
  createApiClient,
  FolderKeyring,
  generateIdentity,
  hash,
  IdentityId,
  InstallationId,
  keptOperations,
  memoryKeptStore,
  MemoryKeyVersionMarks,
  newContactsPayloads,
  newId,
  newPayload,
  pageOperations,
  PageId,
  searchOperations,
  RevisionCache,
  RevisionId,
  SpaceId,
  TrustStore,
  utf8,
  type Audience,
  type ClientContext,
  type KeptStore,
  type PrivateIdentity,
} from '../src/index.ts';

type KeptTree = keptOperations.KeptTree;
type OpenedRevision = pageOperations.OpenedRevision;
type PageSummary = KeptTree['pages'][number];

const installationId = newId(InstallationId);
const SECRET = 'PLAINTEXT-KEPT-c0ffee';

/**
 * A server as the keeper sees it: spaces with pages, each with a published
 * version and, for an editor, a draft, some with an image. Counts what it
 * is asked for.
 */
function fakeServer(identity: PrivateIdentity) {
  const trees = new Map<SpaceId, PageSummary[]>();
  const versions = new Map<RevisionId, OpenedRevision>();
  const blobs = new Map<string, Uint8Array>();
  const asked = { versions: 0, blobs: 0 };

  function version(spaceId: SpaceId, pageId: PageId, audience: Audience, text: string) {
    const revisionId = newId(RevisionId);
    const blob = utf8(`image ${text}`);
    const blobHash = hash(blob);
    blobs.set(blobHash, blob);
    const payload = newPayload({
      title: `${text} ${SECRET}`,
      markdown: `![photo](attachment:a1) ${text} ${SECRET}`,
    });
    payload.attachments = [
      {
        id: newId(AttachmentId),
        name: 'photo.png',
        mediaType: 'image/png',
        size: blob.length,
        key: hash(utf8('key')),
        blobHash,
      },
    ];
    versions.set(revisionId, {
      record: {
        protocol: 1,
        installationId,
        spaceId,
        pageId,
        revisionId,
        audience,
        basedOn: null,
        authorId: identity.public.id,
        authorKeyVersion: 1,
        payloadHash: hash(utf8(text)),
      },
      opened: { kind: 'current', payload },
      region: { kind: 'owner' },
      keyVersion: null,
      createdAt: '2026-11-13T09:00:00.000Z',
    });
    return { revisionId, blobHash };
  }

  const server = {
    trees,
    asked,
    /** A page with a published version and a draft. */
    addPage(spaceId: SpaceId, text: string) {
      const pageId = newId(PageId);
      const published = version(spaceId, pageId, 'published', `${text} published`);
      const draft = version(spaceId, pageId, 'draft', `${text} draft`);
      const pages = trees.get(spaceId) ?? [];
      pages.push({
        id: pageId,
        parentId: null,
        permissionVersion: 1,
        draftHead: draft.revisionId,
        publishedHead: published.revisionId,
        draftChanges: true,
        position: null,
      });
      trees.set(spaceId, pages);
      return { pageId, published, draft };
    },
    /** A new draft of the page. */
    saveDraft(spaceId: SpaceId, pageId: PageId, text: string) {
      const page = trees.get(spaceId)?.find((p) => p.id === pageId);
      if (!page) throw new Error('No such page');
      page.draftHead = version(spaceId, pageId, 'draft', text).revisionId;
      return page.draftHead;
    },
    source: {
      async spaces() {
        const ids = [...trees.keys()];
        return {
          list: { spaces: [], order: { homeId: ids[0] ?? null, spaceIds: ids }, shared: [] },
          ids,
        };
      },
      async tree(spaceId: SpaceId): Promise<KeptTree | null> {
        const pages = trees.get(spaceId);
        if (!pages) return null;
        return {
          space: null,
          shares: [],
          folders: [],
          pages: structuredClone(pages),
          agentActivity: null,
        };
      },
      async versions(spaceId: SpaceId, wanted: ReadonlyMap<RevisionId, unknown>) {
        asked.versions += wanted.size;
        const found = new Map<RevisionId, () => OpenedRevision>();
        for (const id of wanted.keys()) {
          const opened = versions.get(id);
          if (opened?.record.spaceId === spaceId) found.set(id, () => structuredClone(opened));
        }
        return found;
      },
      async blob(blobHash: string) {
        asked.blobs += 1;
        const blob = blobs.get(blobHash);
        if (!blob) throw new Error('No such blob');
        return blob;
      },
    },
  };
  return server;
}

/** A session for `identity` that keeps pages in `store`, and whose API answers nothing. */
async function session(identity: PrivateIdentity, store: KeptStore): Promise<ClientContext> {
  return {
    api: createApiClient({
      fetch: async () => {
        throw new Error('The server was asked');
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
    keptContent: await keptOperations.KeptContent.open(store, { identity, installationId }),
  };
}

const person = () => generateIdentity({ id: newId(IdentityId), kind: 'human' });

describe('keeping pages for offline', () => {
  it('keeps every page sealed, and a later session reads it with no server', async () => {
    const identity = person();
    const store = memoryKeptStore();
    const server = fakeServer(identity);
    const spaceId = newId(SpaceId);
    const recipes = server.addPage(spaceId, 'Recipes');
    server.addPage(spaceId, 'Notes');
    const ctx = await session(identity, store);
    await keptOperations.keep(ctx, { scope: 'every', source: server.source });

    // Each version, image, tree and the index is its own item, and none
    // shows an ID or what it holds.
    const items = await store.items.list();
    expect(items).toHaveLength(4 + 4 + 1 + 1);
    const stored = JSON.stringify(
      await Promise.all(
        items.map(async ({ name }) => [name, [...((await store.items.read(name)) ?? [])]]),
      ),
    );
    for (const hidden of [SECRET, spaceId, recipes.pageId, recipes.draft.revisionId]) {
      expect(stored).not.toContain(hidden);
    }

    // The next session opens the draft from the device: the API throws if asked.
    const later = await session(identity, store);
    const opened = await pageOperations.openRevisionOf(
      later,
      { spaceId, pageId: recipes.pageId },
      'draft',
      recipes.draft.revisionId,
    );
    expect(opened.opened.kind === 'current' && opened.opened.payload.title).toBe(
      `Recipes draft ${SECRET}`,
    );
    // With when the server took it, as it said when it was kept.
    expect(opened.createdAt).toBe('2026-11-13T09:00:00.000Z');
    expect(await pageOperations.downloadBlob(later, recipes.draft.blobHash)).toEqual(
      utf8('image Recipes draft'),
    );
    // Asked for as another page's, or the other audience, it isn't given.
    await expect(
      pageOperations.openRevisionOf(
        later,
        { spaceId, pageId: newId(PageId) },
        'draft',
        recipes.draft.revisionId,
      ),
    ).rejects.toThrow('No answer from /api/revisions/batch');
    expect(
      await later.keptContent?.version({
        spaceId,
        pageId: recipes.pageId,
        audience: 'published',
        revisionId: recipes.draft.revisionId,
      }),
    ).toBeUndefined();
    expect((await later.keptContent?.usage())?.pages).toBe(2);

    // Someone else's vault opens none of it.
    const other = await session(person(), store);
    expect(other.keptContent?.spaceIds()).toEqual([]);
  });

  it('opens only versions it doesn’t keep, and lets go of what is replaced or gone', async () => {
    const identity = person();
    const store = memoryKeptStore();
    const server = fakeServer(identity);
    const spaceId = newId(SpaceId);
    const other = newId(SpaceId);
    const recipes = server.addPage(spaceId, 'Recipes');
    const notes = server.addPage(spaceId, 'Notes');
    server.addPage(other, 'Elsewhere');
    const ctx = await session(identity, store);
    const keep = (spaces: SpaceId[] | 'all' = 'all') =>
      keptOperations.keep(ctx, { scope: 'every', source: server.source, spaces });
    await keep();
    expect(server.asked).toEqual({ versions: 6, blobs: 6 });
    const before = (await store.items.list()).length;

    // Nothing changed: nothing is opened again.
    await keep();
    expect(server.asked).toEqual({ versions: 6, blobs: 6 });

    // A new draft replaces the old one, and its image goes with it.
    server.saveDraft(spaceId, recipes.pageId, 'Recipes again');
    await keep([spaceId]);
    expect(server.asked).toEqual({ versions: 7, blobs: 7 });
    expect((await store.items.list()).length).toBe(before);
    expect(ctx.keptContent?.hasVersion(recipes.draft.revisionId)).toBe(false);
    expect(ctx.keptContent?.hasBlob(recipes.draft.blobHash)).toBe(false);

    // A page no longer listed goes, and a space no longer listed goes whole.
    server.trees.set(
      spaceId,
      (server.trees.get(spaceId) ?? []).filter((page) => page.id !== notes.pageId),
    );
    server.trees.delete(other);
    await keep();
    expect(ctx.keptContent?.page(spaceId, notes.pageId)).toBeUndefined();
    expect(ctx.keptContent?.spaceIds()).toEqual([spaceId]);
    // The index, the space, two versions and their images.
    expect(await store.items.list()).toHaveLength(1 + 1 + 2 + 2);
  });

  it('with Pages I open, keeps only the pages opened here', async () => {
    const identity = person();
    const store = memoryKeptStore();
    const server = fakeServer(identity);
    const spaceId = newId(SpaceId);
    const recipes = server.addPage(spaceId, 'Recipes');
    const notes = server.addPage(spaceId, 'Notes');
    const ctx = await session(identity, store);
    const page = { spaceId, pageId: recipes.pageId };
    await keptOperations.keep(ctx, {
      scope: 'opened',
      source: server.source,
      spaces: [],
      opened: [page],
    });
    expect(ctx.keptContent?.page(spaceId, recipes.pageId)?.opened).toBe(true);
    expect(ctx.keptContent?.page(spaceId, notes.pageId)).toBeUndefined();

    // Kept current from then on.
    const draft = server.saveDraft(spaceId, recipes.pageId, 'Recipes again');
    await keptOperations.keep(ctx, { scope: 'opened', source: server.source });
    expect(ctx.keptContent?.hasVersion(draft)).toBe(true);
    expect(ctx.keptContent?.page(spaceId, notes.pageId)).toBeUndefined();

    // Every page keeps the rest; back to Pages I open, they go again.
    await keptOperations.keep(ctx, { scope: 'every', source: server.source });
    expect(ctx.keptContent?.page(spaceId, notes.pageId)?.opened).toBe(false);
    expect(await ctx.keptContent?.markOpened(page)).toBe(true);
    await keptOperations.keep(ctx, { scope: 'opened', source: server.source });
    expect(ctx.keptContent?.page(spaceId, notes.pageId)).toBeUndefined();
    expect(ctx.keptContent?.page(spaceId, recipes.pageId)?.versions).toHaveLength(2);
  });

  it('stops when the session ends, and keeps nothing after', async () => {
    const identity = person();
    const store = memoryKeptStore();
    const server = fakeServer(identity);
    const spaceId = newId(SpaceId);
    server.addPage(spaceId, 'Recipes');
    const ctx = await session(identity, store);
    const keeping = keptOperations.keep(ctx, {
      scope: 'every',
      source: {
        ...server.source,
        // The vault locks while the tree loads.
        tree: async (id) => {
          ctx.keptContent?.close();
          return server.source.tree(id);
        },
      },
    });
    await expect(keeping).rejects.toBeInstanceOf(keptOperations.KeepingStopped);
    // Only the space list, written before it stopped.
    expect(await store.items.list()).toHaveLength(1);
  });

  it('reads what is kept with no server: trees, page info and search (step 3)', async () => {
    const identity = person();
    const store = memoryKeptStore();
    const server = fakeServer(identity);
    const spaceId = newId(SpaceId);
    const recipes = server.addPage(spaceId, 'Recipes');
    const notes = server.addPage(spaceId, 'Notes');
    const ctx = await session(identity, store);
    // The person owns the space, and opened Recipes here only.
    const source = {
      ...server.source,
      tree: async (id: SpaceId) => {
        const tree = await server.source.tree(id);
        return (
          tree && {
            ...tree,
            space: {
              id,
              role: 'owner' as const,
              canPublish: true,
              permissionVersion: 1,
              metadata: null,
            },
          }
        );
      },
      // As a build before times kept them: none, which offline doesn't ask for.
      versions: async (id: SpaceId, wanted: ReadonlyMap<RevisionId, unknown>) =>
        new Map(
          [...(await server.source.versions(id, wanted))].map(([revisionId, open]) => [
            revisionId,
            () => ({ ...open(), createdAt: null }),
          ]),
        ),
    };
    await keptOperations.keep(ctx, {
      scope: 'opened',
      source,
      opened: [{ spaceId, pageId: recipes.pageId }],
    });

    // A later session, whose API throws if asked.
    const later = await session(identity, store);
    const asked: string[] = [];
    const call = later.api.call.bind(later.api);
    later.api.call = ((route, ...rest) => {
      asked.push(route.path);
      return call(route, ...rest);
    }) as typeof later.api.call;
    const tree = await keptOperations.keptTree(later, spaceId);
    expect(tree.pages.map((page) => [page.id, page.title])).toEqual([
      [recipes.pageId, `Recipes draft ${SECRET}`],
    ]);
    expect([...keptOperations.notKeptIn(later, spaceId)]).toEqual([notes.pageId]);
    const info = keptOperations.keptPageInfo(later, recipes.pageId);
    expect(info).toMatchObject({
      spaceId,
      role: 'owner',
      canPublish: true,
      heads: { draftHead: recipes.draft.revisionId, publishedHead: recipes.published.revisionId },
    });
    expect(() => keptOperations.keptPageInfo(later, notes.pageId)).toThrow(keptOperations.NotKept);

    const index = await searchOperations.indexSpaces(later, { from: 'kept' });
    expect(index.search('Recipes').map(({ doc }) => doc.pageId)).toEqual([recipes.pageId]);
    expect(index.search('Notes')).toEqual([]);
    expect(index.page(spaceId, recipes.pageId)?.updated).toBeNull();
    expect(asked).toEqual([]);
  });
});
