// The app's copy and move between spaces (protocol section 10), against the
// real server: the preview, links between copied pages, and a move that
// finds its source changed at the finish and seals that page again.
import {
  copyOperations as copies,
  linkTableOf,
  pageOperations as pages,
  PageId as PageIdSchema,
  publicLinkOperations as links,
  spaceOperations,
  utf8,
  type ClientContext,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { copyRoutes } from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, lyingServer, shareFolder, type Answer } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/**
 * Alice's library: a folder Notes holding Budget, and Plan, which links to
 * Budget by wikilink and by address, and to Elsewhere, a page beside Notes;
 * Plan is published with a file, then edited. Stay, beside Notes too, links
 * to Plan. Her board has a folder Pinned that Carol reads and Dave edits and
 * publishes in, and a folder Drafts that Bob edits without publishing.
 */
async function world() {
  const [alice, bob, carol, dave] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await spaceOperations.createSpace(alice.ctx, { name: 'Library' });
  const notes = await spaceOperations.createFolder(alice.ctx, {
    spaceId: lib,
    parentId: null,
    name: 'Notes',
  });
  const budget = await pages.createPage(alice.ctx, {
    spaceId: lib,
    parentId: notes,
    title: 'Budget',
    markdown: 'the budget',
  });
  const elsewhere = await pages.createPage(alice.ctx, {
    spaceId: lib,
    parentId: null,
    title: 'Elsewhere',
  });
  const plan = await pages.createPage(alice.ctx, {
    spaceId: lib,
    parentId: notes,
    title: 'Plan',
    markdown: `See [[Budget]], [the budget](/s/${lib}/p/${budget}) and [[Elsewhere]].`,
  });
  const page = { spaceId: lib, pageId: plan };
  const map = await pages.uploadAttachment(alice.ctx, page, {
    name: 'map.txt',
    mediaType: 'text/plain',
    bytes: utf8('the map'),
  });
  await pages.editDraft(alice.ctx, page, { attachments: [map] });
  await pages.publishPage(alice.ctx, page);
  await pages.editDraft(alice.ctx, page, { title: 'Plan', attachments: [map] });
  await pages.createPage(alice.ctx, {
    spaceId: lib,
    parentId: null,
    title: 'Stay',
    markdown: 'Back to [[Plan]].',
  });
  const board = await spaceOperations.createSpace(alice.ctx, { name: 'Board' });
  const folder = (name: string) =>
    spaceOperations.createFolder(alice.ctx, { spaceId: board, parentId: null, name });
  const pinned = await folder('Pinned');
  const drafts = await folder('Drafts');
  const boardShare = await shareFolder(alice.ctx, {
    spaceId: board,
    rootId: pinned,
    people: [await invite(alice, carol, 'reader'), await invite(alice, dave, 'editor', true)],
  });
  await shareFolder(alice.ctx, {
    spaceId: board,
    rootId: drafts,
    people: [await invite(alice, bob, 'editor')],
  });
  // Bob edits Notes, so he may copy it.
  await shareFolder(alice.ctx, {
    spaceId: lib,
    rootId: notes,
    people: [await invite(alice, bob, 'editor'), await invite(alice, dave, 'editor')],
  });
  return {
    alice,
    bob,
    carol,
    dave,
    lib,
    notes,
    budget,
    elsewhere,
    plan,
    page,
    board,
    pinned,
    drafts,
    boardShare,
  };
}

const ref = (spaceId: SpaceId, pageId: string) => ({ spaceId, pageId: PageIdSchema.parse(pageId) });

async function current(ctx: ClientContext, page: { spaceId: SpaceId; pageId: PageId }) {
  const { heads } = await pages.loadPage(ctx, page.pageId);
  if (!heads.draftHead) throw new Error('expected a draft');
  const { opened } = await pages.openRevisionOf(ctx, page, 'draft', heads.draftHead);
  if (opened.kind !== 'current') throw new Error('expected a current payload');
  return { heads, payload: opened.payload };
}

describe('copying a folder into another space', () => {
  it('previews it, then copies it with its links between its own pages', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    expect(preview.nodes.map((n) => n.name)).toEqual(['Notes', 'Budget', 'Plan']);
    expect(preview.bringsPublished).toBe(true);
    expect(preview.unpublished).toEqual([]);
    // Alice owns the board: who reads there, verified.
    expect(preview.audience?.kind).toBe('verified');
    const people = preview.audience?.kind === 'verified' ? preview.audience.people : [];
    expect(people.map((p) => p.identityId).sort()).toEqual(
      [w.alice, w.carol, w.dave].map((p) => p.vault.identity.public.id).sort(),
    );
    expect(people.find((p) => p.identityId === w.carol.vault.identity.public.id)?.reach).toBe(
      'published',
    );
    // Elsewhere stays behind, in a space the copy isn't in.
    expect(preview.links?.map((l) => l.text)).toEqual(['Elsewhere']);
    expect(preview.ends).toBeNull();

    const progress: string[] = [];
    const made = await copies.makeCopy(w.alice.ctx, preview, {
      onProgress: (p) => progress.push(`${p.stage} ${p.sent}/${p.total}`),
    });
    expect(progress.at(-1)).toBe('finishing 3/3');
    const plan = ref(w.board, made.copies.get(w.plan) ?? '');
    const budget = made.copies.get(w.budget);
    const { heads, payload } = await current(w.dave.ctx, plan);
    // Links between copied pages name the copies; the address too.
    expect(linkTableOf(payload).get('budget')).toBe(budget);
    expect(linkTableOf(payload).has('elsewhere')).toBe(false);
    expect(payload.markdown).toContain(`(/s/${w.board}/p/${budget})`);
    expect(payload.markdown).not.toContain(w.lib);
    // Its draft differs from its publication, as the source's did.
    expect(heads.draftChanges).toBe(true);
    const { opened } = await pages.openRevisionOf(
      w.carol.ctx,
      plan,
      'published',
      heads.publishedHead ?? ('' as never),
    );
    if (opened.kind !== 'current') throw new Error('expected a publication');
    const [map] = opened.payload.attachments;
    if (!map) throw new Error('expected the map');
    expect(
      new TextDecoder().decode(await pages.readAttachment(w.carol.ctx, plan, 'published', map)),
    ).toBe('the map');
    // The source is as it was.
    expect((await current(w.alice.ctx, w.page)).payload.markdown).toContain(`/s/${w.lib}/p/`);
  });

  it('within one space keeps links to pages beside it', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.lib, parentId: null },
    });
    expect(preview.links).toEqual([]);
    const made = await copies.makeCopy(w.alice.ctx, preview);
    const { payload } = await current(w.alice.ctx, ref(w.lib, made.copies.get(w.plan) ?? ''));
    expect(linkTableOf(payload).get('elsewhere')).toBe(w.elsewhere);
    expect(linkTableOf(payload).get('budget')).toBe(made.copies.get(w.budget));
  });

  it('shows someone who doesn’t own the destination only its share, and what arrives unpublished', async () => {
    const w = await world();
    const daves = await copies.previewCopy(w.dave.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    expect(daves.audience).toEqual({
      kind: 'unlisted',
      region: { kind: 'share', spaceId: w.board, shareId: w.boardShare },
      shareId: w.boardShare,
    });
    // Bob can't publish in Drafts: Plan arrives with its draft alone.
    const bobs = await copies.previewCopy(w.bob.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.board, parentId: w.drafts },
    });
    expect(bobs.bringsPublished).toBe(false);
    expect(bobs.unpublished.map((p) => p.pageId)).toEqual([w.plan]);
    const made = await copies.makeCopy(w.bob.ctx, bobs);
    const { heads } = await current(w.bob.ctx, ref(w.board, made.nodeId));
    expect(heads.publishedHead).toBeNull();
    // Nor does he move it: only an owner of its space does.
    const move = copies.previewCopy(w.bob.ctx, {
      kind: 'move',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.board, parentId: w.drafts },
    });
    expect(await rejection(move)).toBe('forbidden');
    // And the server refuses one sent anyway, leaving nothing.
    const sent = { ...bobs, kind: 'move' as const, copyId: 'bobs-move', bringsPublished: false };
    expect(await rejection(copies.makeCopy(w.bob.ctx, sent))).toBe('forbidden');
    expect(
      await t.db.select().from(schema.copies).where(eq(schema.copies.id, 'bobs-move')),
    ).toEqual([]);
  });

  it('is made by an agent within its picks, with no preview, and never moves', async () => {
    const w = await world();
    const agent = await enrolledAgent(t, w.dave, {
      picks: [
        { spaceId: w.lib, folderId: w.notes, role: 'editor' },
        { spaceId: w.board, folderId: w.pinned, role: 'editor', canPublish: true },
      ],
    });
    const preview = await copies.previewCopy(agent.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    expect(preview.audience).toBeNull();
    const made = await copies.makeCopy(agent.ctx, preview);
    expect((await current(w.dave.ctx, ref(w.board, made.nodeId))).payload.title).toBe('Plan');
    expect(
      await rejection(
        copies.previewCopy(agent.ctx, {
          kind: 'move',
          source: { spaceId: w.lib, nodeId: w.plan },
          destination: { spaceId: w.board, parentId: w.pinned },
        }),
      ),
    ).toBe('forbidden');
  });
});

describe('moving into another space', () => {
  it('previews what it ends, and seals again a page edited before the finish', async () => {
    const w = await world();
    await links.turnOn(w.alice.ctx, w.plan);
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'move',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    expect(preview.ends?.publicLinks).toEqual([w.plan]);
    expect(preview.ends?.shares.map((s) => s.members.length)).toEqual([2]);
    // Stay links to Plan, which leaves.
    expect(preview.inbound.map((p) => p.title)).toEqual(['Stay']);
    // Bob edits Notes, and isn't in Pinned.
    expect(preview.losses.map((l) => l.identityId)).toContain(w.bob.vault.identity.public.id);

    // Plan is edited just before the first finish reaches the server.
    let edited = false;
    const finishing: Answer = async (input, send) => {
      if (!edited) {
        edited = true;
        await pages.editDraft(w.alice.ctx, w.page, { markdown: 'edited at the last moment' });
      }
      return send(input);
    };
    const { ctx, sent } = lyingServer(w.alice.ctx, new Map([[copyRoutes.finish, finishing]]));
    const made = await copies.makeCopy(ctx, preview);
    expect(sent.filter((route) => route === copyRoutes.finish)).toHaveLength(2);
    const plan = ref(w.board, made.copies.get(w.plan) ?? '');
    expect((await current(w.dave.ctx, plan)).payload.markdown).toBe('edited at the last moment');
    expect(await rejection(pages.loadPage(w.alice.ctx, w.plan))).toBe('not-found');
  });

  it('ends, and leaves nothing behind, when what moves gains a page meanwhile', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'move',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: null },
    });
    const adding: Answer = async (input, send) => {
      await pages.createPage(w.alice.ctx, { spaceId: w.lib, parentId: w.notes, title: 'Late' });
      return send(input);
    };
    const { ctx } = lyingServer(w.alice.ctx, new Map([[copyRoutes.finish, adding]]));
    expect(await rejection(copies.makeCopy(ctx, preview))).toBe('stale-head');
    expect(
      await t.db.select().from(schema.copies).where(eq(schema.copies.id, preview.copyId)),
    ).toEqual([]);
    const top = preview.nodes[0]?.nodeId ?? '';
    expect(await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, top))).toEqual([]);
    expect((await current(w.alice.ctx, w.page)).payload.title).toBe('Plan');
  });
});
