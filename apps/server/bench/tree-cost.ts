// The tree benchmark uses real encrypted heads and HTTP routes, like sharing-cost.
// WIKISTOW_BENCH names the JSON output file; without it, nothing runs.
// Run it with the `bench` project (wikistow/benchmarks/tree.md).
import {
  newId,
  newPayload,
  PageId,
  pageOperations as pages,
  RevisionId,
  sealRevisionV2,
  spaceOperations,
  type ClientContext,
  type SpaceId,
} from '@wikistow/client';
import { pageRoutes } from '@wikistow/contracts';
import { fetchRevisions, humanActor, schema } from '@wikistow/server';
import { writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault } from '../test/support/content.ts';
import { createTestApp, type TestApp } from '../test/support/harness.ts';
import { invite, lyingServer, shareFolder, type Person } from '../test/support/sharing.ts';

const BENCH = process.env['WIKISTOW_BENCH'] ?? '';
// Four kilobytes of Markdown, with paragraphs and a short checklist.
const BODY =
  '# Household notes\n\nRemember to water the plants and check the boiler.\n\n- Check the lights\n- Put out the bins\n\n'.repeat(
    38,
  );
let t: TestApp;
beforeAll(async () => {
  if (BENCH) t = await createTestApp();
});
afterAll(() => (BENCH ? t.drop() : undefined));

/**
 * Seed a space as the app would have written it: per page, one real v2
 * draft and its publication, both sealed to the owner.
 */
async function seed(owner: Person, spaceId: SpaceId, count: number) {
  for (let start = 0; start < count; start += 100) {
    const nodes: (typeof schema.nodes.$inferInsert)[] = [];
    const revisions: (typeof schema.revisions.$inferInsert)[] = [];
    const envelopes: (typeof schema.keyEnvelopes.$inferInsert)[] = [];
    const heads: (typeof schema.pageHeads.$inferInsert)[] = [];
    for (let i = start; i < Math.min(start + 100, count); i++) {
      const pageId = newId(PageId);
      const draftId = newId(RevisionId);
      const publishedId = newId(RevisionId);
      for (const [revisionId, audience, basedOn] of [
        [draftId, 'draft', null],
        [publishedId, 'published', draftId],
      ] as const) {
        const sealed = sealRevisionV2({
          author: owner.ctx.identity,
          target: {
            installationId: owner.ctx.installationId,
            spaceId,
            pageId,
            revisionId,
            audience,
            basedOn,
          },
          payload: newPayload({ title: `Page ${i}`, markdown: BODY }),
          recipients: [owner.ctx.identity.public],
        });
        revisions.push({
          id: revisionId,
          pageId,
          spaceId,
          audience,
          basedOn,
          authorIdentityId: owner.ctx.identity.public.id,
          authorKeyVersion: owner.ctx.identity.public.keyVersion,
          authorAccountId: owner.id,
          sealed: sealed.revision,
          payloadSize: sealed.revision.payload.ciphertext.length,
          ...(audience === 'draft' ? { draftSeq: 1 } : { publishedSeq: 1 }),
        });
        envelopes.push(
          ...sealed.envelopes.map((envelope) => ({
            subjectKind: 'revision' as const,
            subjectId: revisionId,
            recipientIdentityId: envelope.recipientId,
            recipientKeyVersion: envelope.recipientKeyVersion,
            envelope,
          })),
        );
      }
      nodes.push({ id: pageId, spaceId, parentId: null, kind: 'page' });
      heads.push({
        pageId,
        draftHead: draftId,
        publishedHead: publishedId,
        draftCount: 1,
        publishedCount: 1,
      });
    }
    await t.db.insert(schema.nodes).values(nodes);
    await t.db.insert(schema.revisions).values(revisions);
    await t.db.insert(schema.keyEnvelopes).values(envelopes);
    await t.db.insert(schema.pageHeads).values(heads);
  }
}

type Batch = ReturnType<typeof pageRoutes.fetchRevisions.response.parse>;
type Served = Batch['revisions'][number];

/**
 * Count revision bodies downloaded during a complete operation, including
 * deferred batches. With `replay`, revisions it served before are served
 * again at once, so only the client's own work is timed.
 */
async function timed<T>(
  ctx: ClientContext,
  action: (ctx: ClientContext) => Promise<T>,
  replay?: ReadonlyMap<string, Served>,
) {
  let fetched = 0;
  let requests = 0;
  let revisionBytes = 0;
  const served = new Map<string, Served>();
  const watched = lyingServer(
    ctx,
    new Map([
      [
        pageRoutes.fetchRevisions,
        async (input, send) => {
          const { ids } = pageRoutes.fetchRevisions.body.parse(input.body);
          const response: Batch = replay
            ? {
                revisions: ids.map((id) => {
                  const recorded = replay.get(id);
                  if (!recorded) throw new Error('A revision the recorded load never got');
                  return recorded;
                }),
                deferred: [],
              }
            : await send<Batch>(input);
          for (const entry of response.revisions)
            served.set(entry.revision.record.revisionId, entry);
          fetched += response.revisions.length;
          requests += 1;
          revisionBytes += new TextEncoder().encode(JSON.stringify(response)).byteLength;
          return response;
        },
      ],
    ]),
  );
  const started = performance.now();
  const result = await action(watched.ctx);
  const ms = Math.round(performance.now() - started);
  return { ms, fetched, requests, revisionBytes, result, served };
}

/** The server's revision batch route alone, called directly in batches of 200, one after another. */
async function serverOnly(person: Person, ids: readonly string[]) {
  const started = performance.now();
  for (let start = 0; start < ids.length; start += 200) {
    let pending = ids.slice(start, start + 200);
    while (pending.length > 0) {
      const { deferred } = await fetchRevisions(t.db, humanActor(person.id), pending, () => {});
      pending = deferred;
    }
  }
  return Math.round(performance.now() - started);
}

const RUNS = 3;
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * Cold and warm tree loads by `person`, each the median of `RUNS`: the
 * whole load, the server's batch route alone, and the client's work alone
 * with every batch answered at once.
 */
async function loads(person: Person, spaceId: SpaceId, count: number) {
  const cold = [];
  const clientOnly = [];
  const warm = [];
  const server = [];
  for (let run = 0; run < RUNS; run++) {
    person.ctx.revisions.clear();
    const {
      result: tree,
      served,
      ...load
    } = await timed(person.ctx, (ctx) => spaceOperations.loadTree(ctx, spaceId));
    expect(tree.pages).toHaveLength(count);
    expect(tree.pages.every((page) => page.title?.startsWith('Page '))).toBe(true);
    expect(load.fetched).toBe(count);
    cold.push(load);
    const {
      result: _warmTree,
      served: _none,
      ...again
    } = await timed(person.ctx, (ctx) => spaceOperations.loadTree(ctx, spaceId));
    expect(again.fetched).toBe(0);
    warm.push(again.ms);
    person.ctx.revisions.clear();
    const replayed = await timed(
      person.ctx,
      (ctx) => spaceOperations.loadTree(ctx, spaceId),
      served,
    );
    clientOnly.push(replayed.ms);
    const heads = tree.pages.flatMap((page) => {
      const head = page.draftHead ?? page.publishedHead;
      return head ? [head] : [];
    });
    server.push(await serverOnly(person, heads));
  }
  const [first] = cold;
  if (!first) throw new Error('expected a load');
  return {
    coldMs: median(cold.map((load) => load.ms)),
    requests: first.requests,
    revisionBytes: first.revisionBytes,
    serverMs: median(server),
    clientMs: median(clientOnly),
    warmMs: median(warm),
  };
}

describe.skipIf(!BENCH)('the cost of loading titles and saving a draft', () => {
  it(
    'measures cold and warm trees at 200 and 2,000 pages for an owner, an editor and a reader, plus autosave',
    { timeout: 30 * 60 * 1000 },
    async () => {
      const owner = await personWithVault(t);
      const editor = await personWithVault(t);
      const reader = await personWithVault(t);
      const results = [];
      for (const count of [200, 2000]) {
        const spaceId = await spaceOperations.createSpace(owner.ctx, { name: `${count} pages` });
        const started = performance.now();
        await seed(owner, spaceId, count);
        const seedMs = Math.round(performance.now() - started);
        const ownerLoads = await loads(owner, spaceId, count);
        const tree = await spaceOperations.loadTree(owner.ctx, spaceId);
        const first = tree.pages[0];
        if (!first?.draftHead) throw new Error('expected a draft');
        const page = { spaceId, pageId: first.id };
        const basedOn = first.draftHead;
        const base = await pages.openRevisionOf(owner.ctx, page, 'draft', first.draftHead);
        const {
          result: reloaded,
          served: _served,
          ...autosave
        } = await timed(owner.ctx, async (ctx) => {
          await pages.saveDraft(ctx, {
            page,
            basedOn,
            basedOnRegion: base.region,
            payload: newPayload({ title: 'Page renamed', markdown: `${BODY}\nA new note.` }),
          });
          return spaceOperations.loadTree(ctx, spaceId);
        });
        expect(autosave.fetched).toBe(0);
        expect(reloaded.pages.find((entry) => entry.id === first.id)?.title).toBe('Page renamed');

        // The whole space shared with an editor, who loads drafts, and a reader, who loads publications.
        const shareStarted = performance.now();
        await shareFolder(owner.ctx, {
          spaceId,
          rootId: null,
          people: [await invite(owner, editor, 'editor'), await invite(owner, reader, 'reader')],
        });
        const shareMs = Math.round(performance.now() - shareStarted);
        const editorLoads = await loads(editor, spaceId, count);
        const readerLoads = await loads(reader, spaceId, count);
        results.push({
          pages: count,
          markdownBytes: new TextEncoder().encode(BODY).byteLength,
          seedMs,
          shareMs,
          owner: ownerLoads,
          autosave,
          editor: editorLoads,
          reader: readerLoads,
        });
      }
      await writeFile(BENCH, JSON.stringify(results, null, 2));
    },
  );
});
