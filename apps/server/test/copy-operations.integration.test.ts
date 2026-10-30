// The app's copy and move between spaces (protocol section 10), against the
// real server: the preview, links between copied pages and folders, a move
// that finds its source changed at the finish and seals that page again,
// and a copy that waits out a busy server or a lost answer, is stopped, or
// is given its IDs.
import {
  ApiError,
  copyOperations as copies,
  linkTableOf,
  newId,
  pageOperations as pages,
  PageId as PageIdSchema,
  publicationOperations as pubs,
  publicLinkOperations as links,
  spaceOperations,
  utf8,
  type ApiClient,
  type ClientContext,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { copyRoutes, pageRoutes, type RouteDef } from '@wikistow/contracts';
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

/**
 * `ctx` talking to a server that is busy once for each kind of request:
 * the first is `rate-limited`, asking for `retryAfterSeconds`, and the rest
 * are answered. `asked` counts each kind's requests, refused ones too.
 */
function busyOnce(ctx: ClientContext, retryAfterSeconds = 0) {
  const asked = new Map<string, number>();
  const busy = (kind: string) => {
    const count = (asked.get(kind) ?? 0) + 1;
    asked.set(kind, count);
    if (count === 1) {
      throw new ApiError(429, 'rate-limited', 'Too many requests', {}, { retryAfterSeconds });
    }
  };
  const { api } = ctx;
  const real = api.call as unknown as (route: RouteDef, ...rest: unknown[]) => Promise<unknown>;
  const busyApi: ApiClient = {
    call: (async (route: RouteDef, ...rest: unknown[]) => {
      busy(`${route.method} ${route.path}`);
      return real(route, ...rest);
    }) as unknown as ApiClient['call'],
    upload: async (...args) => {
      busy('upload');
      return api.upload(...args);
    },
    download: async (...args) => {
      busy('download');
      return api.download(...args);
    },
  };
  return { ctx: { ...ctx, api: busyApi }, asked };
}

const kindOf = (route: RouteDef) => `${route.method} ${route.path}`;

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

describe('copying what has no draft, or none since it was published', () => {
  it('makes a page with no draft from its publication', async () => {
    const w = await world();
    const budget = { spaceId: w.lib, pageId: w.budget };
    const { revisionId } = await pages.publishPage(w.alice.ctx, budget);
    const preview = await pubs.previewPublication(w.alice.ctx, {
      source: budget,
      revisionId,
      audience: 'published',
      spaceId: w.board,
      parentId: w.pinned,
    });
    const published = await pubs.publishToSpace(w.alice.ctx, { preview, attachmentIds: new Set() });
    // Ended without being detached: a publication, and no draft.
    await pubs.endPublication(w.alice.ctx, { source: budget, spaceId: w.board });
    const copy = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.board, nodeId: published.pageId },
      destination: { spaceId: w.lib, parentId: null },
    });
    const made = await copies.makeCopy(w.alice.ctx, copy);
    const { heads, payload } = await current(w.alice.ctx, ref(w.lib, made.nodeId));
    expect(payload.markdown).toBe('the budget');
    expect(heads.publishedHead).not.toBeNull();
    expect(heads.draftChanges).toBe(false);
  });

  it('publishes a copy on its own draft when the source was published as it is', async () => {
    const w = await world();
    await pages.publishPage(w.alice.ctx, { spaceId: w.lib, pageId: w.budget });
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    const made = await copies.makeCopy(w.alice.ctx, preview);
    const budget = ref(w.board, made.copies.get(w.budget) ?? '');
    const { heads } = await current(w.dave.ctx, budget);
    expect(heads.draftChanges).toBe(false);
    const { record } = await pages.openRevisionOf(
      w.carol.ctx,
      budget,
      'published',
      heads.publishedHead ?? ('' as never),
    );
    expect(record.basedOn).toBe(heads.draftHead);
    // Plan's draft was edited since it was published: its copy shows that.
    const plan = ref(w.board, made.copies.get(w.plan) ?? '');
    expect((await current(w.dave.ctx, plan)).heads.draftChanges).toBe(true);
  });
});

describe('a copy’s link table', () => {
  it('keeps no entry its writer can’t check, even within one share', async () => {
    const w = await world();
    // Plan's table names Elsewhere, beside Notes, outside the agent's picks.
    expect(linkTableOf((await current(w.alice.ctx, w.page)).payload).get('elsewhere')).toBe(
      w.elsewhere,
    );
    const agent = await enrolledAgent(t, w.dave, {
      picks: [{ spaceId: w.lib, folderId: w.notes, role: 'editor' }],
    });
    const preview = await copies.previewCopy(agent.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.lib, parentId: w.notes },
    });
    const made = await copies.makeCopy(agent.ctx, preview);
    const { payload } = await current(w.alice.ctx, ref(w.lib, made.nodeId));
    const table = linkTableOf(payload);
    expect(table.has('elsewhere')).toBe(false);
    expect(table.get('budget')).toBe(w.budget);
  });

  it('keeps its publication’s entries between copied pages, for readers in a share', async () => {
    const w = await world();
    const budget = ref(w.lib, w.budget);
    await pages.publishPage(w.alice.ctx, budget);
    await pages.publishPage(w.alice.ctx, w.page);
    // Budget is published under a new title since: Plan's publication finds it by its entry.
    await pages.editDraft(w.alice.ctx, budget, { title: 'Forecast' });
    await pages.publishPage(w.alice.ctx, budget);
    const published = async (ctx: ClientContext, page: { spaceId: SpaceId; pageId: PageId }) => {
      const { heads } = await pages.loadPage(ctx, page.pageId);
      const { opened } = await pages.openRevisionOf(
        ctx,
        page,
        'published',
        heads.publishedHead ?? ('' as never),
      );
      if (opened.kind !== 'current') throw new Error('expected a publication');
      return opened.payload;
    };
    expect(linkTableOf(await published(w.alice.ctx, w.page)).get('budget')).toBe(w.budget);

    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    const made = await copies.makeCopy(w.alice.ctx, preview);
    const plan = await published(w.carol.ctx, ref(w.board, made.copies.get(w.plan) ?? ''));
    expect(plan.markdown).toContain('[[Budget]]');
    expect(linkTableOf(plan).get('budget')).toBe(made.copies.get(w.budget));
  });

  it('renames no link, so its draft and publication keep the source’s text', async () => {
    const alice = await personWithVault(t);
    const space = await spaceOperations.createSpace(alice.ctx, { name: 'Notes' });
    const plan = await pages.createPage(alice.ctx, {
      spaceId: space,
      parentId: null,
      title: 'Plan',
    });
    await pages.publishPage(alice.ctx, ref(space, plan));
    const agenda = ref(
      space,
      await pages.createPage(alice.ctx, {
        spaceId: space,
        parentId: null,
        title: 'Agenda',
        markdown: 'See [[Plan]].',
      }),
    );
    await pages.publishPage(alice.ctx, agenda);
    // Plan is published under a new title since: a save of Agenda would rename its link.
    await pages.editDraft(alice.ctx, ref(space, plan), { title: 'Roadmap' });
    await pages.publishPage(alice.ctx, ref(space, plan));

    const preview = await copies.previewCopy(alice.ctx, {
      kind: 'copy',
      source: { spaceId: space, nodeId: agenda.pageId },
      destination: { spaceId: space, parentId: null },
    });
    const made = await copies.makeCopy(alice.ctx, preview);
    const copied = ref(space, made.nodeId);
    const { heads, payload } = await current(alice.ctx, copied);
    expect(payload.markdown).toBe('See [[Plan]].');
    expect(linkTableOf(payload).get('plan')).toBe(plan);
    expect(heads.draftChanges).toBe(false);
    const { opened } = await pages.openRevisionOf(
      alice.ctx,
      copied,
      'published',
      heads.publishedHead ?? ('' as never),
    );
    if (opened.kind !== 'current') throw new Error('expected a publication');
    expect(opened.payload.markdown).toBe('See [[Plan]].');
  });
});

describe('a busy server, or a lost answer', () => {
  it('copies more pages than a minute’s reads would open one by one, waiting out every limit', async () => {
    const w = await world();
    const many = await spaceOperations.createFolder(w.alice.ctx, {
      spaceId: w.lib,
      parentId: null,
      name: 'Many',
    });
    const PAGES = 40;
    let last: PageId | null = null;
    for (let i = 0; i < PAGES; i++) {
      last = await pages.createPage(w.alice.ctx, {
        spaceId: w.lib,
        parentId: many,
        title: `Page ${i}`,
        markdown: i === 0 ? 'Back to [[Plan]].' : `page ${i}, see [[Page 0]]`,
      });
    }
    // Each kind of request is refused once, rate-limited, then answered.
    const previewing = busyOnce(w.alice.ctx);
    const moving = await copies.previewCopy(previewing.ctx, {
      kind: 'move',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    // Nothing was passed over: every page that links to Plan is listed.
    expect(new Set(moving.inbound.map((p) => p.title))).toEqual(new Set(['Page 0', 'Stay']));

    const copying = busyOnce(w.alice.ctx);
    const whole = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: many },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    const made = await copies.makeCopy(copying.ctx, whole);
    expect(made.copies.size).toBe(PAGES + 1);
    // Versions are opened many to a request, not one by one.
    const fetches = copying.asked.get(kindOf(pageRoutes.fetchRevisions)) ?? 0;
    expect(fetches).toBeLessThan(10);
    for (const route of [pageRoutes.fetchRevisions, copyRoutes.records, copyRoutes.finish]) {
      expect(copying.asked.get(kindOf(route)), route.path).toBeGreaterThan(1);
    }
    const copied = ref(w.board, made.copies.get(last ?? '') ?? '');
    expect((await current(w.dave.ctx, copied)).payload.markdown).toBe(
      `page ${PAGES - 1}, see [[Page 0]]`,
    );
  });

  it('waits as long as a busy finish asks, and finishes', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    let busy = true;
    const finishing: Answer = async (input, send) => {
      if (busy) {
        busy = false;
        throw new ApiError(429, 'rate-limited', 'Busy', {}, { retryAfterSeconds: 1 });
      }
      return send(input);
    };
    const { ctx, sent } = lyingServer(w.alice.ctx, new Map([[copyRoutes.finish, finishing]]));
    const started = Date.now();
    const made = await copies.makeCopy(ctx, preview);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(sent.filter((route) => route === copyRoutes.finish)).toHaveLength(2);
    expect((await current(w.dave.ctx, ref(w.board, made.nodeId))).payload.title).toBe('Plan');
  });

  it('finishes again when the finish’s answer is lost, and cancels nothing', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'move',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    let lost = false;
    const losing: Answer = async (input, send) => {
      const answer = await send(input);
      if (!lost) {
        lost = true;
        throw new ApiError(0, 'network', 'No answer from the finish');
      }
      return answer;
    };
    const { ctx, sent } = lyingServer(w.alice.ctx, new Map([[copyRoutes.finish, losing]]));
    const made = await copies.makeCopy(ctx, preview);
    expect(sent.filter((route) => route === copyRoutes.finish)).toHaveLength(2);
    expect(sent).not.toContain(copyRoutes.cancel);
    const plan = ref(w.board, made.copies.get(w.plan) ?? '');
    expect((await current(w.dave.ctx, plan)).payload.title).toBe('Plan');
    expect(await rejection(pages.loadPage(w.alice.ctx, w.plan))).toBe('not-found');
  });
});

describe('stopping a copy, or choosing its IDs', () => {
  it('cancels a copy stopped before its finish, and leaves nothing hidden', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'move',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    // Stop is pressed while the records are on their way.
    const stop = new AbortController();
    const stopping: Answer = async (input, send) => {
      stop.abort();
      return send(input);
    };
    const { ctx, sent } = lyingServer(w.alice.ctx, new Map([[copyRoutes.records, stopping]]));
    const caught = await copies.makeCopy(ctx, preview, { signal: stop.signal }).catch((e) => e);
    expect(caught).toBeInstanceOf(copies.CopyStopped);
    expect(sent).toContain(copyRoutes.cancel);
    expect(sent).not.toContain(copyRoutes.finish);
    expect(
      await t.db.select().from(schema.copies).where(eq(schema.copies.id, preview.copyId)),
    ).toEqual([]);
    for (const { nodeId } of preview.nodes) {
      expect(await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId))).toEqual([]);
    }
    // What was to move stays where it was.
    expect((await current(w.alice.ctx, w.page)).payload.title).toBe('Plan');
  });

  it('stops between the attachments of one batch, and leaves nothing hidden', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    // Notes, Budget and Plan go in one batch. Stop is pressed while Plan's
    // first file is read, once Notes and Budget are sealed.
    const stop = new AbortController();
    const { ctx: lying, sent } = lyingServer(w.alice.ctx, new Map());
    const moved = { downloads: 0, uploads: 0 };
    const ctx: ClientContext = {
      ...lying,
      api: {
        ...lying.api,
        download: async (...args) => {
          moved.downloads += 1;
          stop.abort();
          return lying.api.download(...args);
        },
        upload: async (...args) => {
          moved.uploads += 1;
          return lying.api.upload(...args);
        },
      },
    };
    const caught = await copies.makeCopy(ctx, preview, { signal: stop.signal }).catch((e) => e);
    expect(caught).toBeInstanceOf(copies.CopyStopped);
    expect(moved).toEqual({ downloads: 1, uploads: 0 });
    expect(sent).not.toContain(copyRoutes.records);
    expect(sent).toContain(copyRoutes.cancel);
    expect(
      await t.db.select().from(schema.copies).where(eq(schema.copies.id, preview.copyId)),
    ).toEqual([]);
    for (const { nodeId } of preview.nodes) {
      expect(await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId))).toEqual([]);
    }
  });

  it('stops waiting out a busy server', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    // The records are refused for a minute, and Stop is pressed meanwhile.
    const stop = new AbortController();
    const busy: Answer = async () => {
      setTimeout(() => stop.abort(), 50);
      throw new ApiError(429, 'rate-limited', 'Busy', {}, { retryAfterSeconds: 60 });
    };
    const { ctx, sent } = lyingServer(w.alice.ctx, new Map([[copyRoutes.records, busy]]));
    const started = Date.now();
    const caught = await copies.makeCopy(ctx, preview, { signal: stop.signal }).catch((e) => e);
    expect(caught).toBeInstanceOf(copies.CopyStopped);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(sent.filter((route) => route === copyRoutes.records)).toHaveLength(1);
    expect(sent).toContain(copyRoutes.cancel);
    expect(
      await t.db.select().from(schema.copies).where(eq(schema.copies.id, preview.copyId)),
    ).toEqual([]);
  });

  it('finishes a copy stopped once its finish was sent', async () => {
    const w = await world();
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.plan },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    const stop = new AbortController();
    const stopping: Answer = async (input, send) => {
      stop.abort();
      return send(input);
    };
    const { ctx, sent } = lyingServer(w.alice.ctx, new Map([[copyRoutes.finish, stopping]]));
    const made = await copies.makeCopy(ctx, preview, { signal: stop.signal });
    expect(sent).not.toContain(copyRoutes.cancel);
    expect((await current(w.dave.ctx, ref(w.board, made.nodeId))).payload.title).toBe('Plan');
  });

  it('makes the copy and its nodes with the IDs its caller chose', async () => {
    const w = await world();
    const copyId = newId(PageIdSchema);
    const chosen = new Map<string, string>(
      [w.notes, w.budget, w.plan].map((id) => [id, newId(PageIdSchema)]),
    );
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'copy',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
      copyId,
      ids: (sourceId) => chosen.get(sourceId) ?? '',
    });
    expect(preview.copyId).toBe(copyId);
    expect(new Map(preview.nodes.map((n) => [n.sourceId, [n.nodeId, n.parentId]]))).toEqual(
      new Map<string, unknown>([
        [w.notes, [chosen.get(w.notes), w.pinned]],
        [w.budget, [chosen.get(w.budget), chosen.get(w.notes)]],
        [w.plan, [chosen.get(w.plan), chosen.get(w.notes)]],
      ]),
    );
    const made = await copies.makeCopy(w.alice.ctx, preview);
    expect(made.copies).toEqual(chosen);
    expect((await current(w.dave.ctx, ref(w.board, chosen.get(w.plan) ?? ''))).payload.title).toBe(
      'Plan',
    );
    // An ID that isn't one is refused before anything is sent.
    await expect(
      copies.previewCopy(w.alice.ctx, {
        kind: 'copy',
        source: { spaceId: w.lib, nodeId: w.plan },
        destination: { spaceId: w.board, parentId: w.pinned },
        ids: () => 'not an ID',
      }),
    ).rejects.toThrow();
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
    // Which nodes each records request carries, in order.
    const batches: string[][] = [];
    const recording: Answer = async (input, send) => {
      const { nodes } = input.body as { nodes: { nodeId: string }[] };
      batches.push(nodes.map((node) => node.nodeId));
      return send(input);
    };
    const { ctx, sent } = lyingServer(
      w.alice.ctx,
      new Map<RouteDef, Answer>([
        [copyRoutes.finish, finishing],
        [copyRoutes.records, recording],
      ]),
    );
    const made = await copies.makeCopy(ctx, preview);
    expect(sent.filter((route) => route === copyRoutes.finish)).toHaveLength(2);
    // Only Plan was sealed and sent again; the others' records stood.
    expect(batches).toEqual([preview.nodes.map((node) => node.nodeId), [made.copies.get(w.plan)]]);
    const plan = ref(w.board, made.copies.get(w.plan) ?? '');
    expect((await current(w.dave.ctx, plan)).payload.markdown).toBe('edited at the last moment');
    expect(await rejection(pages.loadPage(w.alice.ctx, w.plan))).toBe('not-found');
  });

  it('points links to the folder it moves at its copy, and lists those it can’t', async () => {
    const w = await world();
    const notes = `/s/${w.lib}/f/${w.notes}`;
    // The same address, with its first letter escaped, which reads the same.
    const escaped = `/s/${w.lib}/f/&#${w.notes.charCodeAt(0)};${w.notes.slice(1)}`;
    await pages.editDraft(w.alice.ctx, ref(w.lib, w.budget), {
      markdown: `Back to [Notes](${notes}), or [the old way](${escaped}).`,
    });
    await pages.createPage(w.alice.ctx, {
      spaceId: w.lib,
      parentId: null,
      title: 'Index',
      markdown: `All in [Notes](${notes}).`,
    });
    const preview = await copies.previewCopy(w.alice.ctx, {
      kind: 'move',
      source: { spaceId: w.lib, nodeId: w.notes },
      destination: { spaceId: w.board, parentId: w.pinned },
    });
    expect(new Set(preview.inbound.map((p) => p.title))).toEqual(new Set(['Index', 'Stay']));
    expect(preview.links?.filter((l) => l.kind === 'folder-link')).toEqual([
      { kind: 'folder-link', page: `${w.lib}/${w.notes}`, text: 'the old way', count: 1 },
    ]);
    const made = await copies.makeCopy(w.alice.ctx, preview);
    const budget = ref(w.board, made.copies.get(w.budget) ?? '');
    expect((await current(w.dave.ctx, budget)).payload.markdown).toBe(
      `Back to [Notes](/s/${w.board}/f/${made.nodeId}), or [the old way](${escaped}).`,
    );
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
