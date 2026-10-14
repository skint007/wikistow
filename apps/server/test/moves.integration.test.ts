// Moving pages and folders (protocol section 10).
import {
  FolderId,
  moveOperations as moves,
  pageOperations as pages,
  revisionWrapSubject,
  sharingOperations as sharing,
  spaceOperations,
  unwrapContentKey,
  type PageId,
  type RevisionId,
} from '@wikistow/client';
import {
  KeyWrap,
  pageRoutes,
  RevisionRecordV2,
  sharingRoutes,
  structureRoutes,
  type RouteDef,
} from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { asAgent, enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import {
  draftHead,
  invite,
  library,
  lyingServer,
  shareFolder,
  tampering,
  type Answer,
  type Person,
} from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const folder = (
  owner: Person,
  spaceId: Parameters<typeof spaceOperations.createFolder>[1]['spaceId'],
  parentId: FolderId | null,
  name: string,
) => spaceOperations.createFolder(owner.ctx, { spaceId, parentId, name });

const parentOf = async (nodeId: string) => {
  const [row] = await t.db
    .select({ parentId: schema.nodes.parentId })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId));
  return row?.parentId;
};

/** Every revision of a page with the share and key version it is wrapped under, if any. */
const wrapsOf = async (pageId: string) =>
  (
    await t.db
      .select({ id: schema.revisions.id, shareId: schema.revisionWraps.shareId })
      .from(schema.revisions)
      .leftJoin(schema.revisionWraps, eq(schema.revisionWraps.revisionId, schema.revisions.id))
      .where(eq(schema.revisions.pageId, pageId))
  ).sort((a, b) => a.id.localeCompare(b.id));

/**
 * Two shares in one space: `from` (folder `Shared`, holding `sub`, which
 * holds a page with a publication and a newer draft) with a reader, Rae,
 * and an editor, Ed; and `to` (folder `Other`) with a reader, Ruth, and an
 * editor, Eve. Ed is an editor of `to` too.
 */
async function twoShares() {
  const [alice, rae, ed, ruth, eve] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(alice);
  const { spaceId } = lib;
  const sub = await folder(alice, spaceId, lib.shared, 'Sub');
  const pageId = await pages.createPage(alice.ctx, {
    spaceId,
    parentId: sub,
    title: 'Moving',
    markdown: 'first words',
  });
  const page = { spaceId, pageId };
  await pages.publishPage(alice.ctx, page);
  await pages.editDraft(alice.ctx, page, { markdown: 'draft words' });
  const other = await folder(alice, spaceId, lib.above, 'Other');
  const from = await shareFolder(alice.ctx, {
    spaceId,
    rootId: lib.shared,
    people: [await invite(alice, rae, 'reader'), await invite(alice, ed, 'editor')],
  });
  const to = await shareFolder(alice.ctx, {
    spaceId,
    rootId: other,
    people: [
      await invite(alice, ruth, 'reader'),
      await invite(alice, eve, 'editor'),
      await invite(alice, ed, 'editor'),
    ],
  });
  return { alice, rae, ed, ruth, eve, lib, spaceId, sub, other, page, from, to };
}

const ids = (changes: readonly moves.AccessChange[]) =>
  changes.map((c) => [c.identityId, c.before, c.after]);

const idOf = (person: Person) => person.vault.identity.public.id;

describe('a move within one share', () => {
  it('is an editor’s to make, changes no keys, and stays inside the share', async () => {
    const { ed, rae, spaceId, lib, sub, page } = await twoShares();
    const inside = await folder(ed, spaceId, lib.shared, 'Inside');
    const before = await wrapsOf(page.pageId);
    const preview = await moves.previewMove(ed.ctx, { spaceId, nodeId: sub, parentId: inside });
    expect(preview).toMatchObject({ crossing: false, gains: [], losses: [] });
    await moves.moveNode(ed.ctx, { preview });
    expect(await parentOf(sub)).toBe(inside);
    expect(await wrapsOf(page.pageId)).toEqual(before);
    expect(await rejection(pages.loadHistory(rae.ctx, page))).toBe('no error');

    // Out of the share, or to the top of the space, is an owner's move.
    expect(
      await rejection(moves.previewMove(ed.ctx, { spaceId, nodeId: sub, parentId: lib.above })),
    ).toBe('not-found');
    const direct = await rejection(
      ed.api.call(sharingRoutes.move, {
        params: { spaceId, nodeId: sub },
        body: {
          parentId: lib.above,
          expectedParentId: inside,
          permissionVersion: preview.permissionVersion + 1,
          parentPermissionVersion: 0,
        },
      }),
    );
    expect(direct).toBe('not-found');
    // A reader moves nothing.
    expect(
      await rejection(
        rae.api.call(sharingRoutes.move, {
          params: { spaceId, nodeId: page.pageId },
          body: {
            parentId: lib.shared,
            expectedParentId: sub,
            permissionVersion: 0,
            parentPermissionVersion: 0,
          },
        }),
      ),
    ).toBe('forbidden');
  });
});

describe('a move across a share boundary', () => {
  it('shows who gains and loses, and gainers read the history while losers read nothing new', async () => {
    const { alice, rae, ed, ruth, eve, spaceId, sub, other, page, to } = await twoShares();
    const published = (await pages.loadPage(alice.ctx, page.pageId)).heads.publishedHead;
    const oldDraft = await draftHead(alice, page);
    if (!published) throw new Error('expected a publication');

    const preview = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other });
    expect(preview.crossing).toBe(true);
    expect(ids(preview.gains)).toEqual(
      expect.arrayContaining([
        [idOf(ruth), null, 'published'],
        [idOf(eve), null, 'drafts'],
      ]),
    );
    expect(preview.gains).toHaveLength(2);
    // Ed is an editor on both sides: no change.
    expect(ids(preview.losses)).toEqual([[idOf(rae), 'published', null]]);

    await moves.moveNode(alice.ctx, { preview });
    expect(await parentOf(sub)).toBe(other);
    expect((await wrapsOf(page.pageId)).every((w) => w.shareId === to)).toBe(true);

    // Ruth reads the publication that was made before she had access; Eve, the old draft.
    expect(
      (await pages.openRevisions(ruth.ctx, page, 'published', [published])).get(published)?.region,
    ).toEqual({ kind: 'share', spaceId, shareId: to });
    expect((await pages.openRevisions(eve.ctx, page, 'draft', [oldDraft])).size).toBe(1);
    expect(await rejection(pages.editDraft(eve.ctx, page, { markdown: 'by Eve' }))).toBe(
      'no error',
    );
    expect(await rejection(pages.editDraft(ed.ctx, page, { markdown: 'by Ed' }))).toBe('no error');

    // Rae is told nothing of it any more, nor sent the versions she read,
    // and her keys open nothing saved after.
    expect(await rejection(pages.loadPage(rae.ctx, page.pageId))).toBe('not-found');
    const { revisions } = await rae.api.call(pageRoutes.fetchRevisions, {
      body: { ids: [published, oldDraft] },
    });
    expect(revisions).toEqual([]);
    const { revisionId: after } = await pages.publishPage(alice.ctx, page);
    const [row] = await t.db
      .select({ sealed: schema.revisions.sealed, wrap: schema.revisionWraps.wrap })
      .from(schema.revisions)
      .innerJoin(schema.revisionWraps, eq(schema.revisionWraps.revisionId, schema.revisions.id))
      .where(eq(schema.revisions.id, after));
    const record = RevisionRecordV2.parse(
      (row?.sealed as { record?: unknown } | undefined)?.record,
    );
    expect(() =>
      unwrapContentKey({
        installationId: rae.ctx.installationId,
        subject: revisionWrapSubject(record),
        wrap: KeyWrap.parse(row?.wrap),
        keyring: rae.ctx.keyring,
        commitment: record.keyCommitment,
      }),
    ).toThrow(expect.objectContaining({ code: 'missing-key' }));
  });

  it('seals to the owners alone when it leaves the shares, and wraps when it joins one', async () => {
    const { alice, rae, spaceId, lib, sub, page, from } = await twoShares();
    const out = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: lib.above });
    expect(out.to).toEqual({ kind: 'owner' });
    expect(out.gains).toEqual([]);
    expect(ids(out.losses)).toEqual(expect.arrayContaining([[idOf(rae), 'published', null]]));
    await moves.moveNode(alice.ctx, { preview: out });
    expect((await wrapsOf(page.pageId)).every((w) => w.shareId === null)).toBe(true);
    expect(await rejection(pages.loadPage(rae.ctx, page.pageId))).toBe('not-found');
    expect(await rejection(pages.editDraft(alice.ctx, page, { markdown: 'private now' }))).toBe(
      'no error',
    );

    const back = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: lib.shared });
    expect(ids(back.gains)).toEqual(expect.arrayContaining([[idOf(rae), null, 'published']]));
    await moves.moveNode(alice.ctx, { preview: back });
    expect((await wrapsOf(page.pageId)).every((w) => w.shareId === from)).toBe(true);
    const history = await pages.loadHistory(rae.ctx, page);
    expect(history.length).toBeGreaterThan(0);
  });

  it('moves a share root within the owner region without rewrapping it', async () => {
    const { alice, rae, spaceId, lib, page } = await twoShares();
    const before = await wrapsOf(page.pageId);
    const elsewhere = await folder(alice, spaceId, null, 'Elsewhere');
    const preview = await moves.previewMove(alice.ctx, {
      spaceId,
      nodeId: lib.shared,
      parentId: elsewhere,
    });
    expect(preview.crossing).toBe(false);
    await moves.moveNode(alice.ctx, { preview });
    expect(await parentOf(lib.shared)).toBe(elsewhere);
    expect(await wrapsOf(page.pageId)).toEqual(before);
    expect(await rejection(pages.loadPage(rae.ctx, page.pageId))).toBe('no error');
  });
});

describe('a move is refused', () => {
  it('into what moves, or where it would nest a share', async () => {
    const { alice, spaceId, lib, sub, other } = await twoShares();
    const inner = await folder(alice, spaceId, sub, 'Inner');
    const send = (nodeId: string, parentId: FolderId | null, expectedParentId: FolderId | null) =>
      rejection(
        alice.api.call(sharingRoutes.move, {
          params: { spaceId, nodeId },
          body: { parentId, expectedParentId, permissionVersion: 0, parentPermissionVersion: 0 },
        }),
      );
    expect(await send(sub, inner, lib.shared)).toBe('binding-mismatch');
    // A share root never goes inside a share.
    expect(await send(lib.shared, other, lib.above)).toBe('share-nesting');
  });

  it('across a share boundary for anyone but an owner', async () => {
    const { ed, spaceId, sub, other } = await twoShares();
    // Ed edits both shares, and still can't move between them.
    expect(
      await rejection(moves.previewMove(ed.ctx, { spaceId, nodeId: sub, parentId: other })),
    ).toBe('forbidden');
    const { permissionVersion } = await ed.api.call(structureRoutes.target, {
      params: { spaceId },
      query: { nodeId: sub },
    });
    const at = await ed.api.call(structureRoutes.target, {
      params: { spaceId },
      query: { nodeId: other },
    });
    expect(
      await rejection(
        ed.api.call(sharingRoutes.move, {
          params: { spaceId, nodeId: sub },
          body: {
            parentId: other,
            expectedParentId: (await parentOf(sub)) as FolderId,
            permissionVersion,
            parentPermissionVersion: at.permissionVersion,
          },
        }),
      ),
    ).toBe('forbidden');
  });

  it('from where it no longer is, or with permissions changed since the preview', async () => {
    const { alice, spaceId, lib, sub, other } = await twoShares();
    const preview = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other });
    const inside = await folder(alice, spaceId, lib.shared, 'Inside');
    await moves.moveNode(alice.ctx, {
      preview: await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: inside }),
    });
    const moved = await moves.moveNode(alice.ctx, { preview }).catch((error: unknown) => error);
    expect(moved).toMatchObject({ code: 'stale-head', detail: { parentId: inside } });
    expect(await parentOf(sub)).toBe(inside);
  });
});

describe('a move that stops part-way', () => {
  it('leaves everything as it was, whether it stops before sending or the server refuses it', async () => {
    const { alice, rae, spaceId, sub, other, page, from } = await twoShares();
    const before = await wrapsOf(page.pageId);
    const preview = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other });

    // The connection drops while the records are scanned.
    const dropping = lyingServer(
      alice.ctx,
      new Map([
        [
          sharingRoutes.records,
          () => Promise.reject(Object.assign(new Error('dropped'), { code: 'network' })),
        ],
      ]),
    );
    expect(await rejection(moves.moveNode(dropping.ctx, { preview }))).toBe('network');
    expect(dropping.sent).not.toContain(sharingRoutes.move);

    // One wrap is for another share on its way: the server takes nothing.
    const broken = tampering(alice.ctx, sharingRoutes.move, (body) => {
      const [first, ...rest] = body['wraps'] as { wrap: Record<string, unknown> }[];
      if (!first) throw new Error('expected wraps');
      return { ...body, wraps: [{ ...first, wrap: { ...first.wrap, shareId: from } }, ...rest] };
    });
    expect(await rejection(moves.moveNode(broken, { preview }))).toBe('binding-mismatch');

    expect(await parentOf(sub)).toBe(preview.fromParentId);
    expect(await wrapsOf(page.pageId)).toEqual(before);
    expect(await rejection(pages.loadHistory(rae.ctx, page))).toBe('no error');
    // And a move from the same preview still works after.
    await moves.moveNode(alice.ctx, { preview });
    expect(await parentOf(sub)).toBe(other);
  });

  it('wraps a version someone saved meanwhile, and sends again', async () => {
    const { alice, ed, eve, spaceId, sub, other, page } = await twoShares();
    const preview = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other });
    let saved: RevisionId | null = null;
    const meanwhile = lyingServer(
      alice.ctx,
      new Map([
        [
          sharingRoutes.move,
          async (input, send) => {
            // Ed saves into the page while the move is on its way, once.
            if (!saved)
              ({ revisionId: saved } = await pages.editDraft(ed.ctx, page, {
                markdown: 'meanwhile',
              }));
            return send(input);
          },
        ],
      ]),
    );
    await moves.moveNode(meanwhile.ctx, { preview });
    expect(meanwhile.sent.filter((route) => route === sharingRoutes.move)).toHaveLength(2);
    if (!saved) throw new Error('expected the save');
    const opened = await pages.openRevisions(eve.ctx, page, 'draft', [saved]);
    expect(opened.get(saved)?.opened).toMatchObject({ payload: { markdown: 'meanwhile' } });
  });

  it('is previewed again when someone adds to what moves meanwhile', async () => {
    const { alice, ed, spaceId, sub, other } = await twoShares();
    const preview = () => moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other });
    const meanwhile = (route: RouteDef, change: () => Promise<unknown>) => {
      let changed = false;
      return lyingServer(
        alice.ctx,
        new Map<RouteDef, Answer>([
          [
            route,
            async (input, send) => {
              if (!changed) {
                changed = true;
                await change();
              }
              return send(input);
            },
          ],
        ]),
      );
    };
    const create = (title: string) =>
      pages.createPage(ed.ctx, { spaceId, parentId: sub, title, markdown: 'meanwhile' });

    // Ed adds a page while the move scans.
    let added: PageId | undefined;
    const adding = meanwhile(sharingRoutes.records, async () => (added = await create('Added')));
    const first = await preview();
    expect(await rejection(moves.moveNode(adding.ctx, { preview: first }))).toBe('stale-head');
    expect(adding.sent).not.toContain(sharingRoutes.move);
    const second = await preview();
    if (!added) throw new Error('expected the page');
    const shown = added;
    expect(second.pages.map((p) => p.id)).toContain(shown);

    await moves.moveNode(alice.ctx, { preview: second });
    expect(await parentOf(sub)).toBe(other);
  });

  it('goes under the new keys after a rotation', async () => {
    const { alice, ruth, spaceId, sub, other, page, to } = await twoShares();
    await sharing.rotateKeys(alice.ctx, { spaceId, shareId: to });
    await moves.moveNode(alice.ctx, {
      preview: await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other }),
    });
    const versions = await t.db
      .select({ keyVersion: schema.revisionWraps.keyVersion })
      .from(schema.revisionWraps)
      .innerJoin(schema.revisions, eq(schema.revisions.id, schema.revisionWraps.revisionId))
      .where(eq(schema.revisions.pageId, page.pageId));
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.every((v) => v.keyVersion === 2)).toBe(true);
    expect(await rejection(pages.loadHistory(ruth.ctx, page))).toBe('no error');
  });
});

describe('the app moving across a share boundary', () => {
  it('wraps nothing the person wasn’t shown, whatever the server scans', async () => {
    const { alice, spaceId, lib, sub, other } = await twoShares();
    const preview = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other });
    const scanned = (rootId: string) =>
      lyingServer(
        alice.ctx,
        new Map([
          [
            sharingRoutes.records,
            async (input, send) => send({ ...input, query: { ...input.query, rootId } }),
          ],
        ]),
      );
    // A scan of more than what moves: the page beside it in the share comes too.
    const more = scanned(lib.shared);
    expect(await rejection(moves.moveNode(more.ctx, { preview }))).toBe('binding-mismatch');
    expect(more.sent).not.toContain(sharingRoutes.move);
    // A scan that leaves out the page.
    const less = lyingServer(
      alice.ctx,
      new Map([
        [
          sharingRoutes.records,
          async (input, send) => {
            const answer = await send<{ records: { kind: string }[] }>(input);
            return { ...answer, records: answer.records.filter((r) => r.kind !== 'revision') };
          },
        ],
      ]),
    );
    expect(await rejection(moves.moveNode(less.ctx, { preview }))).toBe('binding-mismatch');
    expect(less.sent).not.toContain(sharingRoutes.move);
    expect(await parentOf(sub)).toBe(lib.shared);
  });
});

describe('the server, moving into the owner region', () => {
  it('refuses a record it can’t read rather than leave it without keys', async () => {
    const { alice, spaceId, lib, sub, page } = await twoShares();
    // The page's first draft, as an older app might have stored it.
    const [first] = await t.db
      .select({ id: schema.revisions.id })
      .from(schema.revisions)
      .where(and(eq(schema.revisions.pageId, page.pageId), eq(schema.revisions.draftSeq, 1)));
    if (!first) throw new Error('expected the first draft');
    await t.db.execute(sql`alter table revisions disable trigger revisions_immutable`);
    try {
      await t.db
        .update(schema.revisions)
        .set({ sealed: sql`jsonb_set(sealed, '{record,payloadHash}', '"unreadable"')` })
        .where(eq(schema.revisions.id, first.id));
    } finally {
      await t.db.execute(sql`alter table revisions enable trigger revisions_immutable`);
    }
    const before = await wrapsOf(page.pageId);
    const preview = await moves.previewMove(alice.ctx, {
      spaceId,
      nodeId: sub,
      parentId: lib.above,
    });
    expect(await rejection(moves.moveNode(alice.ctx, { preview }))).toBe('binding-mismatch');
    expect(await wrapsOf(page.pageId)).toEqual(before);
    expect(await parentOf(sub)).toBe(lib.shared);
    expect(t.logs).toContainEqual({
      level: 'warn',
      event: 'unreadable-row',
      table: 'revisions',
      rowId: first.id,
    });
  });
});

describe('agents', () => {
  it('follow their picks: a folder moved out of one leaves the agent, and a pick moved across ends', async () => {
    const { alice, ed, spaceId, lib, sub, other, page } = await twoShares();
    const agent = await enrolledAgent(t, ed, {
      picks: [{ spaceId, folderId: sub, role: 'reader' }],
    });
    const page2 = await pages.createPage(alice.ctx, {
      spaceId,
      parentId: lib.shared,
      title: 'Beside the pick',
    });
    await pages.publishPage(alice.ctx, { spaceId, pageId: page2 });
    const status = async (pageId: PageId) =>
      (await asAgent(t, agent.token, `/api/pages/${pageId}`)).status;
    await pages.publishPage(alice.ctx, page);
    expect(await status(page.pageId)).toBe(200);
    expect(await status(page2)).toBe(404);

    // The page leaves the picked folder, within the share: the agent loses it.
    await moves.moveNode(alice.ctx, {
      preview: await moves.previewMove(alice.ctx, {
        spaceId,
        nodeId: page.pageId,
        parentId: lib.shared,
      }),
    });
    expect(await status(page.pageId)).toBe(404);
    // A page moved into it, it gains.
    await moves.moveNode(ed.ctx, {
      preview: await moves.previewMove(ed.ctx, { spaceId, nodeId: page2, parentId: sub }),
    });
    expect(await status(page2)).toBe(200);

    // The picked folder moves to another share: the preview says the pick there ends, and it does.
    const across = await moves.previewMove(alice.ctx, { spaceId, nodeId: sub, parentId: other });
    expect(across.endingPicks).toEqual([
      { agentId: agent.agentId, personId: idOf(ed), name: expect.any(String) },
    ]);
    await moves.moveNode(alice.ctx, { preview: across });
    const grants = await t.db
      .select()
      .from(schema.agentGrants)
      .where(eq(schema.agentGrants.agentId, agent.agentId));
    expect(grants).toEqual([]);
    expect(await status(page2)).toBe(404);
  });
});
