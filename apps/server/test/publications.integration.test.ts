// Publishing chosen versions of a page into a page in another space
// (protocol section 13): what goes, who can read it, and who may send it.
import {
  moveOperations,
  newId,
  PageId as PageIdSchema,
  pageOperations as pages,
  publicationOperations as pubs,
  sharingOperations as sharing,
  spaceOperations,
  utf8,
  type ClientContext,
  type FolderId,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/client';
import { publicationRoutes, type RouteDef } from '@wikistow/contracts';
import { fileBlobStore, schema, sweepBlobs } from '@wikistow/server';
import { eq, inArray } from 'drizzle-orm';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import {
  find,
  invite,
  library,
  lyingServer,
  shareFolder,
  type Answer,
  type Person,
} from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * Alice's library (a shared folder holding a page published with two
 * attachments, and a newer draft) and her board, another space whose
 * folder is shared too. Erin reads the library's folder, Frank edits it
 * without publishing, and Dave publishes there; Carol reads the board, and
 * Dave and Frank publish there.
 */
async function world() {
  const [alice, carol, dave, erin, frank] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(alice);
  const { page } = lib;
  const attach = (name: string, body: string) =>
    pages.uploadAttachment(alice.ctx, page, {
      name,
      mediaType: 'text/plain',
      bytes: utf8(body),
    });
  const map = await attach('map.txt', 'the map of the source');
  const notes = await attach('notes.txt', 'notes kept at the source');
  await pages.editDraft(alice.ctx, page, {
    markdown: 'published words, see [[Budget]] and [the plan](/s/elsewhere/p/other)',
    attachments: [map, notes],
  });
  await pages.publishPage(alice.ctx, page);
  await pages.editDraft(alice.ctx, page, { markdown: 'draft words, not yet published' });
  const sourceShare = await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [
      await invite(alice, erin, 'reader'),
      await invite(alice, dave, 'editor', true),
      await invite(alice, frank, 'editor'),
    ],
  });
  const board = await spaceOperations.createSpace(alice.ctx, { name: 'Board' });
  const pinned = await spaceOperations.createFolder(alice.ctx, {
    spaceId: board,
    parentId: null,
    name: 'Pinned',
  });
  const boardShare = await shareFolder(alice.ctx, {
    spaceId: board,
    rootId: pinned,
    people: [
      await invite(alice, carol, 'reader'),
      await invite(alice, dave, 'editor', true),
      await invite(alice, frank, 'editor', true),
    ],
  });
  const heads = (await pages.loadPage(alice.ctx, page.pageId)).heads;
  if (!heads.draftHead || !heads.publishedHead) throw new Error('expected both heads');
  return {
    alice,
    carol,
    dave,
    erin,
    frank,
    lib,
    page,
    board,
    pinned,
    sourceShare,
    boardShare,
    published: heads.publishedHead,
    draft: heads.draftHead,
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** Preview and publish, as the dialog does once the person confirms. */
async function publish(
  ctx: ClientContext,
  w: { page: pages.PageRef; board: SpaceId; pinned: FolderId | null },
  {
    revisionId,
    audience = 'published',
    pick = ['map.txt'],
    parentId = w.pinned,
  }: {
    revisionId: RevisionId;
    audience?: 'draft' | 'published';
    pick?: string[];
    parentId?: FolderId | null;
  },
) {
  const preview = await pubs.previewPublication(ctx, {
    source: w.page,
    revisionId,
    audience,
    spaceId: w.board,
    parentId,
  });
  const attachmentIds = new Set(
    preview.attachments.filter((a) => pick.includes(a.name)).map((a) => a.id),
  );
  return { preview, ...(await pubs.publishToSpace(ctx, { preview, attachmentIds })) };
}

const copyOf = (w: World, pageId: PageId) => ({ spaceId: w.board, pageId });

const storedOf = async (pageId: PageId) =>
  t.db
    .select({ id: schema.revisions.id, sealed: schema.revisions.sealed })
    .from(schema.revisions)
    .where(eq(schema.revisions.pageId, pageId));

describe('publishing into another space', () => {
  it('copies the chosen version and attachments for the destination’s readers', async () => {
    const w = await world();
    const { pageId, revisionId } = await publish(w.alice.ctx, w, {
      revisionId: w.published,
    });
    const copy = copyOf(w, pageId);
    const info = await pages.loadPage(w.carol.ctx, pageId);
    expect(info.heads.publishedHead).toBe(revisionId);
    const opened = await pages.openRevisionOf(w.carol.ctx, copy, 'published', revisionId);
    if (opened.opened.kind !== 'current') throw new Error('expected a current payload');
    const { payload } = opened.opened;
    expect(payload.title).toBe('Plan');
    expect(payload.markdown).toContain('published words');
    expect(payload.attachments.map((a) => a.name)).toEqual(['map.txt']);
    const [map] = payload.attachments;
    if (!map) throw new Error('expected the map');
    expect(text(await pages.readAttachment(w.carol.ctx, copy, 'published', map))).toBe(
      'the map of the source',
    );
  });

  it('holds only the versions sent to it, each under the destination’s published key', async () => {
    const w = await world();
    const first = await publish(w.alice.ctx, w, { revisionId: w.published });
    const copy = copyOf(w, first.pageId);
    // Publishing or editing the source sends nothing.
    await pages.publishPage(w.alice.ctx, w.page);
    await pages.editDraft(w.alice.ctx, w.page, { markdown: 'a later draft' });
    expect(await pages.loadHistory(w.carol.ctx, copy)).toHaveLength(1);

    // A draft sent explicitly is the next version, for readers too.
    const draft = (await pages.loadPage(w.alice.ctx, w.page.pageId)).heads.draftHead;
    if (!draft) throw new Error('expected a draft');
    const second = await publish(w.alice.ctx, w, { revisionId: draft, audience: 'draft' });
    expect(second.preview.destination.state).toBe('existing');
    expect(second.pageId).toBe(first.pageId);
    const history = await pages.loadHistory(w.carol.ctx, copy);
    expect(history.map((v) => v.revisionId)).toEqual([second.revisionId, first.revisionId]);
    const latest = await pages.openRevisionOf(w.carol.ctx, copy, 'published', second.revisionId);
    expect(latest.opened.kind === 'current' && latest.opened.payload.markdown).toBe(
      'a later draft',
    );
  });

  it('lets only someone who can publish the source, and publish where it goes, send it', async () => {
    const w = await world();
    // Carol reads the board, but not the source.
    expect(await rejection(publish(w.carol.ctx, w, { revisionId: w.published }))).toBe('not-found');
    // Not into the source's own space.
    expect(
      await rejection(
        publish(
          w.alice.ctx,
          { ...w, board: w.lib.spaceId, pinned: null },
          { revisionId: w.published },
        ),
      ),
    ).toBe('forbidden');
    // Frank edits the source without publishing there, so he can't take
    // even its publication elsewhere, though he publishes on the board.
    expect(await rejection(publish(w.frank.ctx, w, { revisionId: w.published }))).toBe('forbidden');

    // Dave publishes the source, and on the board. He may send its draft.
    const { pageId } = await publish(w.dave.ctx, w, {
      revisionId: w.draft,
      audience: 'draft',
    });

    // Erin only reads the source. Made a publisher on the board, she still
    // can't open a publication of it there, send to the one there, or learn
    // whether there is one: readers can't copy a page out.
    await sharing.addMember(w.alice.ctx, {
      spaceId: w.board,
      shareId: w.boardShare,
      person: await find(w.alice, w.erin),
      role: 'editor',
      canPublish: true,
    });
    expect(await rejection(publish(w.erin.ctx, w, { revisionId: w.published }))).toBe('forbidden');
    const pinned = (await spaceOperations.loadTree(w.erin.ctx, w.board)).folders.find(
      (f) => f.id === w.pinned,
    );
    expect(
      await rejection(
        w.erin.api.call(publicationRoutes.open, {
          body: {
            sourcePageId: w.page.pageId,
            destinationSpaceId: w.board,
            pageId: newId(PageIdSchema),
            parentId: w.pinned,
            permissionVersion: pinned?.permissionVersion ?? 0,
          },
        }),
      ),
    ).toBe('forbidden');
    // Her app, told by the server that the page is Dave's copy, builds the
    // next version of it from what she reads; the server takes none.
    const told = lyingServer(
      w.erin.ctx,
      new Map<RouteDef, Answer>([
        [publicationRoutes.lookup, async () => ({ publication: { state: 'live', pageId } })],
      ]),
    ).ctx;
    expect(await rejection(publish(told, w, { revisionId: w.published, pick: [] }))).toBe(
      'forbidden',
    );
    expect(await storedOf(pageId)).toHaveLength(1);

    // Dave, with his publish rights on the board taken away, can't open a
    // publication there.
    await sharing.setPublishRights(w.alice.ctx, {
      spaceId: w.board,
      shareId: w.boardShare,
      identityId: w.dave.vault.identity.public.id,
      canPublish: false,
    });
    expect(
      await rejection(
        w.dave.api.call(publicationRoutes.open, {
          body: {
            sourcePageId: w.page.pageId,
            destinationSpaceId: w.board,
            pageId: newId(PageIdSchema),
            parentId: w.pinned,
            permissionVersion: pinned?.permissionVersion ?? 0,
          },
        }),
      ),
    ).toBe('forbidden');
    // And the server refuses a publication into the source's own space itself.
    expect(
      await rejection(
        w.alice.api.call(publicationRoutes.open, {
          body: {
            sourcePageId: w.page.pageId,
            destinationSpaceId: w.lib.spaceId,
            pageId: newId(PageIdSchema),
            parentId: null,
            permissionVersion: 1,
          },
        }),
      ),
    ).toBe('forbidden');
  });

  it('lets someone who publishes the source end a copy they can’t see, and then publish there', async () => {
    const w = await world();
    // Alice publishes at the top of the board, outside the share, where
    // Dave can't see it.
    const { pageId } = await publish(w.alice.ctx, w, {
      revisionId: w.published,
      parentId: null,
    });
    // Dave, who publishes the source and in the board's shared folder, is
    // told only that the copy is somewhere he can't publish: never which page.
    expect(
      await w.dave.api.call(publicationRoutes.lookup, {
        params: { pageId: w.page.pageId, spaceId: w.board },
      }),
    ).toEqual({ publication: { state: 'blocked' } });
    await expect(publish(w.dave.ctx, w, { revisionId: w.published })).rejects.toBeInstanceOf(
      pubs.PublishedElsewhere,
    );
    const pinned = (await spaceOperations.loadTree(w.dave.ctx, w.board)).folders.find(
      (f) => f.id === w.pinned,
    );
    const refused = await w.dave.api
      .call(publicationRoutes.open, {
        body: {
          sourcePageId: w.page.pageId,
          destinationSpaceId: w.board,
          pageId: newId(PageIdSchema),
          parentId: w.pinned,
          permissionVersion: pinned?.permissionVersion ?? 0,
        },
      })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'stale-head', detail: {} });
    expect(JSON.stringify(refused)).not.toContain(pageId);
  });

  it('tells only the source’s publishers where it is published, and of a copy they can’t publish at only the space', async () => {
    const w = await world();
    const onBoard = await publish(w.alice.ctx, w, { revisionId: w.published });
    // Into a space of Alice's own too, where nobody else has access.
    const own = await spaceOperations.createSpace(w.alice.ctx, { name: 'Own' });
    const inOwn = await publish(
      w.alice.ctx,
      { ...w, board: own, pinned: null },
      { revisionId: w.published, pick: [] },
    );
    // And an opening in a third that never got its version.
    const other = await spaceOperations.createSpace(w.alice.ctx, { name: 'Other' });
    const started = await pubs.previewPublication(w.alice.ctx, {
      source: w.page,
      revisionId: w.published,
      audience: 'published',
      spaceId: other,
      parentId: null,
    });
    const dropped = lyingServer(
      w.alice.ctx,
      new Map<RouteDef, Answer>([
        [
          publicationRoutes.send,
          async () => {
            throw new Error('the connection dropped');
          },
        ],
      ]),
    );
    await expect(
      pubs.publishToSpace(dropped.ctx, { preview: started, attachmentIds: new Set() }),
    ).rejects.toThrow('the connection dropped');
    const opened = started.destination.pageId;

    const list = (who: { api: Person['api'] }) =>
      who.api.call(publicationRoutes.list, { params: { pageId: w.page.pageId } });
    expect(await list(w.alice)).toEqual({
      publications: [
        { state: 'live', spaceId: w.board, pageId: onBoard.pageId, parentId: w.pinned },
        { state: 'live', spaceId: own, pageId: inOwn.pageId, parentId: null },
        { state: 'pending', spaceId: other, pageId: opened, parentId: null },
      ],
    });

    // Dave publishes the source, and in the board's shared folder. Of
    // Alice's own space he learns only that a copy there stops him, and of
    // the opening, nothing.
    const daves = await list(w.dave);
    expect(daves).toEqual({
      publications: [
        { state: 'live', spaceId: w.board, pageId: onBoard.pageId, parentId: w.pinned },
        { state: 'blocked', spaceId: own },
      ],
    });
    expect(JSON.stringify(daves)).not.toContain(inOwn.pageId);
    // Without publish rights on the board, the copy there stops him too.
    await sharing.setPublishRights(w.alice.ctx, {
      spaceId: w.board,
      shareId: w.boardShare,
      identityId: w.dave.vault.identity.public.id,
      canPublish: false,
    });
    expect(await list(w.dave)).toEqual({
      publications: [
        { state: 'blocked', spaceId: w.board },
        { state: 'blocked', spaceId: own },
      ],
    });

    // Erin reads the source, and Frank edits it without publishing: neither
    // learns where it went. Carol can't see it at all. Nor can an agent of
    // Alice's that only reads it.
    expect(await rejection(list(w.erin))).toBe('forbidden');
    expect(await rejection(list(w.frank))).toBe('forbidden');
    expect(await rejection(list(w.carol))).toBe('not-found');
    const reading = await enrolledAgent(t, w.alice, {
      picks: [{ spaceId: w.lib.spaceId, folderId: w.lib.shared, role: 'reader' }],
    });
    expect(await rejection(list(reading))).toBe('forbidden');

    // Once Dave can't publish the source, he doesn't learn where it went.
    await sharing.setPublishRights(w.alice.ctx, {
      spaceId: w.lib.spaceId,
      shareId: w.sourceShare,
      identityId: w.dave.vault.identity.public.id,
      canPublish: false,
    });
    expect(await rejection(list(w.dave))).toBe('forbidden');
  });

  it('ends where a deleted page went, leaving the copy readable', async () => {
    const w = await world();
    const onBoard = await publish(w.alice.ctx, w, { revisionId: w.published });
    await pages.deleteNode(w.alice.ctx, { spaceId: w.lib.spaceId, nodeId: w.page.pageId });
    // The copy stays for its readers, ended, and its publishers there detach
    // it to edit it.
    const copy = copyOf(w, onBoard.pageId);
    const [row] = await t.db
      .select({ detachedAt: schema.publications.detachedAt })
      .from(schema.publications)
      .where(eq(schema.publications.destinationPageId, onBoard.pageId));
    expect(row?.detachedAt).toBeInstanceOf(Date);
    expect(
      (await pages.openRevisionOf(w.carol.ctx, copy, 'published', onBoard.revisionId)).opened,
    ).toMatchObject({ kind: 'current', payload: { title: 'Plan' } });
    const { revisionId: draft } = await pubs.detachPublication(w.dave.ctx, copy);
    expect((await pages.loadPage(w.dave.ctx, onBoard.pageId)).heads.draftHead).toBe(draft);
  });

  it('refuses a version prepared before access there changed, and sends it once looked at again', async () => {
    const w = await world();
    const first = await publish(w.alice.ctx, w, { revisionId: w.published });
    const preview = await pubs.previewPublication(w.alice.ctx, {
      source: w.page,
      revisionId: w.published,
      audience: 'published',
      spaceId: w.board,
      parentId: w.pinned,
    });
    // Erin joins the board after Alice looked at who reads it there.
    await sharing.addMember(w.alice.ctx, {
      spaceId: w.board,
      shareId: w.boardShare,
      person: await find(w.alice, w.erin),
      role: 'reader',
    });
    expect(
      await rejection(pubs.publishToSpace(w.alice.ctx, { preview, attachmentIds: new Set() })),
    ).toBe('permission-version');
    expect(await storedOf(first.pageId)).toHaveLength(1);
    const again = await publish(w.alice.ctx, w, { revisionId: w.published, pick: [] });
    expect(again.preview.audience.people.map((p) => p.identityId)).toContain(
      w.erin.vault.identity.public.id,
    );
    expect(await storedOf(first.pageId)).toHaveLength(2);
  });

  it('can’t be edited as a draft until it is detached, and then is a page of its own', async () => {
    const w = await world();
    const { pageId, revisionId } = await publish(w.alice.ctx, w, { revisionId: w.published });
    const copy = copyOf(w, pageId);
    // Dave's app refuses to write a first draft straight to the copy.
    expect(await rejection(pages.editDraft(w.dave.ctx, copy, { markdown: 'x' }))).toBe('not-found');
    // Readers can't detach it, nor editors who can't publish there.
    expect(await rejection(pubs.detachPublication(w.carol.ctx, copy))).toBe('not-found');
    await sharing.addMember(w.alice.ctx, {
      spaceId: w.board,
      shareId: w.boardShare,
      person: await find(w.alice, w.erin),
      role: 'editor',
    });
    expect(await rejection(pubs.detachPublication(w.erin.ctx, copy))).toBe('forbidden');

    const { revisionId: draft } = await pubs.detachPublication(w.dave.ctx, copy);
    const opened = await pages.openRevisionOf(w.dave.ctx, copy, 'draft', draft);
    if (opened.opened.kind !== 'current') throw new Error('expected a current payload');
    expect(opened.opened.payload.attachments.map((a) => a.name)).toEqual(['map.txt']);
    const [map] = opened.opened.payload.attachments;
    if (!map) throw new Error('expected the map');
    expect(text(await pages.readAttachment(w.dave.ctx, copy, 'draft', map))).toBe(
      'the map of the source',
    );
    // Now it is edited like any page, and readers still see its publication.
    await pages.editDraft(w.dave.ctx, copy, { markdown: 'edited on the board' });
    expect((await pages.loadPage(w.carol.ctx, pageId)).heads.publishedHead).toBe(revisionId);
  });

  it('goes only where its publisher chose, whatever opening someone left in another folder', async () => {
    const w = await world();
    // Dave opens a publication into the shared folder, which Carol reads,
    // and his send never arrives.
    const dropped = lyingServer(
      w.dave.ctx,
      new Map([
        [
          publicationRoutes.send,
          async () => {
            throw new Error('the connection dropped');
          },
        ],
      ]),
    );
    const left = await pubs.previewPublication(w.dave.ctx, {
      source: w.page,
      revisionId: w.published,
      audience: 'published',
      spaceId: w.board,
      parentId: w.pinned,
    });
    await expect(
      pubs.publishToSpace(dropped.ctx, {
        preview: left,
        attachmentIds: new Set(left.attachments.map((a) => a.id)),
      }),
    ).rejects.toThrow('the connection dropped');

    // Alice, who could publish there too, chooses the top of the board,
    // which only she reads, and sends her draft.
    const { preview, pageId } = await publish(w.alice.ctx, w, {
      revisionId: w.draft,
      audience: 'draft',
      parentId: null,
    });
    expect(preview.destination).toMatchObject({
      state: 'new',
      parentId: null,
      region: { kind: 'owner' },
    });
    expect(pageId).not.toBe(left.destination.pageId);
    expect((await pages.loadPage(w.alice.ctx, pageId)).parentId).toBeNull();
    // Nobody in the shared folder reads it, and Dave's opening is gone.
    expect(await rejection(pages.loadPage(w.carol.ctx, pageId))).toBe('not-found');
    expect(await rejection(pages.loadPage(w.dave.ctx, pageId))).toBe('not-found');
    expect(
      await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, left.destination.pageId)),
    ).toEqual([]);
  });

  it('is swept a day after it was opened and never sent, unless someone is still at it', async () => {
    const w = await world();
    const store = fileBlobStore(t.blobDir);
    // Openings cut off before their first version, each with both
    // attachments uploaded for it.
    const cutOff = async (spaceId: SpaceId) => {
      const dropped = lyingServer(
        w.alice.ctx,
        new Map([
          [
            publicationRoutes.send,
            async () => {
              throw new Error('the connection dropped');
            },
          ],
        ]),
      );
      const preview = await pubs.previewPublication(w.alice.ctx, {
        source: w.page,
        revisionId: w.published,
        audience: 'published',
        spaceId,
        parentId: null,
      });
      await expect(
        pubs.publishToSpace(dropped.ctx, {
          preview,
          attachmentIds: new Set(preview.attachments.map((a) => a.id)),
        }),
      ).rejects.toThrow('the connection dropped');
      return preview.destination.pageId;
    };
    const abandoned = await cutOff(w.board);
    const busy = await cutOff(await spaceOperations.createSpace(w.alice.ctx, { name: 'Busy' }));
    const third = await spaceOperations.createSpace(w.alice.ctx, { name: 'Third' });
    const copy = await publish(
      w.alice.ctx,
      { ...w, board: third, pinned: null },
      {
        revisionId: w.published,
      },
    );
    const uploads = async (pageId: PageId) =>
      t.db.select().from(schema.blobs).where(eq(schema.blobs.pageId, pageId));
    const files = (await uploads(abandoned)).map((b) => b.hash);
    expect(files).toHaveLength(2);

    // A day on: the abandoned one and its uploads are old; the busy one's
    // uploads came in just now; the copy, opened as long ago, has a version.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await t.db
      .update(schema.publications)
      .set({ createdAt: old })
      .where(inArray(schema.publications.destinationPageId, [abandoned, busy, copy.pageId]));
    await t.db
      .update(schema.blobs)
      .set({ createdAt: old })
      .where(eq(schema.blobs.pageId, abandoned));
    for (const hash of files) {
      const path = join(t.blobDir, 'objects', hash.slice(0, 2), hash);
      await utimes(path, old, old);
    }

    const { openings } = await sweepBlobs(t.db, store);
    expect(openings).toBe(1);
    expect(await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, abandoned))).toEqual(
      [],
    );
    expect(await uploads(abandoned)).toEqual([]);
    for (const hash of files) expect(await store.get(hash)).toBeNull();
    expect(await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, busy))).toHaveLength(1);
    expect(await uploads(busy)).toHaveLength(2);
    expect(
      await pages.loadHistory(w.alice.ctx, { spaceId: third, pageId: copy.pageId }),
    ).toHaveLength(1);
  });

  it('moves like any page, and later versions follow it', async () => {
    const w = await world();
    const { pageId } = await publish(w.alice.ctx, w, { revisionId: w.published });
    const copy = copyOf(w, pageId);
    // Out of the shared folder, to the top of the board: Carol loses it.
    const move = await moveOperations.previewMove(w.alice.ctx, {
      spaceId: w.board,
      nodeId: pageId,
      parentId: null,
    });
    expect(move.crossing).toBe(true);
    await moveOperations.moveNode(w.alice.ctx, { preview: move });
    expect(await rejection(pages.loadPage(w.carol.ctx, pageId))).toBe('not-found');
    // The next version goes where it is now, sealed to the board's owners.
    const next = await publish(w.alice.ctx, w, { revisionId: w.published });
    expect(next.preview.destination).toMatchObject({
      state: 'existing',
      pageId,
      parentId: null,
      region: { kind: 'owner' },
    });
    expect(next.preview.audience.people.map((p) => p.identityId)).toEqual([
      w.alice.vault.identity.public.id,
    ]);
    const opened = await pages.openRevisionOf(w.alice.ctx, copy, 'published', next.revisionId);
    expect(opened.region).toEqual({ kind: 'owner' });
    expect(await pages.loadHistory(w.alice.ctx, copy)).toHaveLength(2);
  });

  it('lets an agent publish where both its picks and its person allow', async () => {
    const w = await world();
    // An agent of Alice's that only reads at the source publishes nothing
    // from there, not even what readers see.
    const reading = await enrolledAgent(t, w.alice, {
      picks: [
        { spaceId: w.lib.spaceId, folderId: w.lib.shared, role: 'reader' },
        { spaceId: w.board, folderId: w.pinned, role: 'editor', canPublish: true },
      ],
    });
    expect(await rejection(publish(reading.ctx, w, { revisionId: w.published }))).toBe('forbidden');
    // Dave's agent may publish at the source until Dave may not.
    const daves = await enrolledAgent(t, w.dave, {
      picks: [
        { spaceId: w.lib.spaceId, folderId: w.lib.shared, role: 'editor', canPublish: true },
        { spaceId: w.board, folderId: w.pinned, role: 'editor', canPublish: true },
      ],
    });
    await publish(daves.ctx, w, { revisionId: w.published });
    const daveAt = (spaceId: SpaceId, shareId: World['boardShare'], canPublish: boolean) =>
      sharing.setPublishRights(w.alice.ctx, {
        spaceId,
        shareId,
        identityId: w.dave.vault.identity.public.id,
        canPublish,
      });
    await daveAt(w.lib.spaceId, w.sourceShare, false);
    expect(await rejection(publish(daves.ctx, w, { revisionId: w.published }))).toBe('forbidden');
  });
});
