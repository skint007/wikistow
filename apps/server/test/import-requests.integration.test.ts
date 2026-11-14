// How many requests an import sends for each folder, page and attachment
// (#399), and that sending fewer keeps what it makes and how it resumes.
// Sent one after another, each request costs a round trip, so the count
// is what a large import's time is made of.
import {
  createApiClient,
  importOperations,
  openSession,
  pageOperations as pages,
  readObsidianVault,
  sharingOperations,
  spaceOperations,
  type ClientContext,
  type Fetch,
  type ImportFile,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import type { importRoutes } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { z } from 'zod';
import { personWithVault } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { invite, shareFolder } from './support/sharing.ts';

let t: TestApp;
let person: Awaited<ReturnType<typeof personWithVault>>;
beforeAll(async () => {
  t = await createTestApp();
  person = await personWithVault(t);
});
afterAll(() => t.drop());

const file = (path: string, text: string): ImportFile => {
  const bytes = new TextEncoder().encode(text);
  return { path, size: bytes.length, read: async () => bytes };
};

const vault = (files: ImportFile[]) =>
  readObsidianVault([file('.obsidian/app.json', '{}'), ...files]);

// A request by its method and route, its IDs left out.
const routeOf = (url: string, init: RequestInit) =>
  `${init.method ?? 'GET'} ${new URL(url, 'http://x').pathname.replace(/\/[A-Za-z0-9_-]{16,}/g, '/:id')}`;

/** `ctx` sending through `send`, a stand-in for the network, and the requests it sent. */
function through(ctx: ClientContext, send: Fetch) {
  const sent: string[] = [];
  const api = createApiClient({
    fetch: (url, init) => {
      sent.push(routeOf(url, init));
      return send(url, init);
    },
  });
  return { ctx: { ...ctx, api }, sent };
}

const BATCH = 'POST /api/spaces/:id/import';
type BatchBody = z.input<typeof importRoutes.batch.body>;

/**
 * `send` as a server from before the batch route answers: its installation
 * says nothing of batches, and the route isn't there.
 */
const older =
  (send: Fetch): Fetch =>
  async (url, init) => {
    const route = routeOf(url, init);
    if (route === BATCH) {
      return Response.json({ error: { code: 'not-found', message: 'Not found' } }, { status: 404 });
    }
    const res = await send(url, init);
    if (route !== 'GET /api/installation') return res;
    const { importBatches: _, ...rest } = (await res.json()) as Record<string, unknown>;
    return Response.json(rest, { status: res.status });
  };

/** Import `files`, a vault, into a new space, and the requests the import sent. */
async function importCounted(files: ImportFile[], { before = false } = {}) {
  const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Imported' });
  const fetch = person.browser.fetch;
  const { ctx, sent } = through(person.ctx, before ? older(fetch) : fetch);
  const source = await vault(files);
  const summary = await importOperations.importNotes(ctx, { scope: { spaceId }, source });
  return { spaceId, summary, sent };
}

const byRoute = (sent: readonly string[]) => {
  const counts: Record<string, number> = {};
  for (const route of sent) counts[route] = (counts[route] ?? 0) + 1;
  return counts;
};

/** The requests `more` sent that `base` didn't, by route. */
function added(base: readonly string[], more: readonly string[]) {
  const before = byRoute(base);
  const diff: Record<string, number> = {};
  for (const [route, n] of Object.entries(byRoute(more))) {
    const extra = n - (before[route] ?? 0);
    if (extra !== 0) diff[route] = extra;
  }
  return diff;
}

/** The page published as `pageId`, as a reader, by default its owner, gets it. */
async function publication(spaceId: SpaceId, pageId: PageId, ctx = person.ctx) {
  const page = { spaceId, pageId };
  const { heads } = await pages.loadPage(ctx, pageId);
  if (!heads.publishedHead) throw new Error('expected a publication');
  const version = await pages.openRevisionOf(ctx, page, 'published', heads.publishedHead);
  if (version.opened.kind !== 'current') throw new Error('expected the current format');
  return { page, payload: version.opened.payload };
}

const pageIdOf = (summary: importOperations.ImportSummary, path: string) => {
  const found = summary.pages.find((p) => p.path === path);
  if (!found) throw new Error(`${path} was not imported`);
  return found.pageId;
};

describe('an import', () => {
  it('sends its folders and pages in batches', async () => {
    const plain = file('Notes/A.md', 'Plain words.');
    const base = await importCounted([plain]);
    const plainPage = await importCounted([plain, file('Notes/B.md', 'More words.')]);
    const eleven = await importCounted(
      Array.from({ length: 11 }, (_, i) => file(`Notes/${i}.md`, `Words ${i}.`)),
    );
    const linking = await importCounted([plain, file('Notes/C.md', 'See [[A]].')]);
    const attached = await importCounted([
      plain,
      file('Notes/C.md', 'See [[A]]. ![[photo.png]]'),
      file('photo.png', 'PNG bytes'),
    ]);
    const folder = await importCounted([plain, file('Other/B.md', 'More words.')]);

    // One batch makes its folder, and one makes its page and publishes it,
    // with nothing sent alone; where to write is asked once, at the top.
    const writes = Object.entries(byRoute(base.sent)).filter(([route]) => route.startsWith('POST'));
    expect(Object.fromEntries(writes)).toEqual({ [BATCH]: 2 });
    expect(byRoute(base.sent)['GET /api/spaces/:id/target']).toBe(1);
    // Another page, or another folder, goes in the same batches.
    expect(added(base.sent, plainPage.sent)).toEqual({});
    expect(added(plainPage.sent, folder.sent)).toEqual({});
    // Ten pages a batch.
    expect(added(base.sent, eleven.sent)).toEqual({ [BATCH]: 1 });
    // One that links is made in the first, then saved and published in a
    // second, so its link has a page to name.
    expect(added(base.sent, linking.sent)).toEqual({ [BATCH]: 1 });
    // An attachment's copies for the draft and for readers.
    expect(added(linking.sent, attached.sent)).toEqual({ 'PUT /api/pages/:id/blobs': 2 });

    // What readers get is what the notes say, the file too.
    expect(attached.summary).toMatchObject({ attachments: 1, unresolved: [], skipped: [] });
    expect(attached.summary.pages.map((p) => p.path)).toEqual(['Notes/A.md', 'Notes/C.md']);
    expect(folder.summary.folders).toBe(2);
    const { page, payload } = await publication(
      attached.spaceId,
      pageIdOf(attached.summary, 'Notes/C.md'),
    );
    expect(payload.markdown).toBe('See [[A]]. ![[photo.png]]');
    const [ref] = payload.attachments;
    if (!ref) throw new Error('expected an attachment');
    const bytes = await pages.readAttachment(person.ctx, page, 'published', ref);
    expect(new TextDecoder().decode(bytes)).toBe('PNG bytes');
    const other = await publication(folder.spaceId, pageIdOf(folder.summary, 'Other/B.md'));
    expect(other.payload.markdown).toBe('More words.');
    const tree = await spaceOperations.loadTree(person.ctx, eleven.spaceId);
    expect(tree.pages.filter((p) => p.publishedHead !== null)).toHaveLength(11);
  });

  it('on a server without batches, sends few requests for each folder, page and attachment', async () => {
    const plain = file('Notes/A.md', 'Plain words.');
    const options = { before: true };
    const base = await importCounted([plain], options);
    const plainPage = await importCounted([plain, file('Notes/B.md', 'More words.')], options);
    const linking = await importCounted([plain, file('Notes/C.md', 'See [[A]].')], options);
    const attached = await importCounted(
      [plain, file('Notes/C.md', 'See [[A]]. ![[photo.png]]'), file('photo.png', 'PNG bytes')],
      options,
    );
    const folder = await importCounted([plain, file('Other/B.md', 'More words.')], options);
    expect(base.sent).not.toContain(BATCH);

    // Before #399, each page took 8: a write-target lookup for each of
    // create, save and publish, the page and its draft fetched again to
    // publish, and an attachment 3, its draft copy downloaded to seal for
    // readers. A folder took 2.
    // A note that names nothing is made with its body, then published.
    expect(added(base.sent, plainPage.sent)).toEqual({
      'POST /api/spaces/:id/pages': 1,
      'POST /api/pages/:id/publications': 1,
    });
    // One that links is made empty first, so its link has a page to name.
    expect(added(base.sent, linking.sent)).toEqual({
      'POST /api/spaces/:id/pages': 1,
      'POST /api/pages/:id/drafts': 1,
      'POST /api/pages/:id/publications': 1,
    });
    // An attachment's copies for the draft and for readers.
    expect(added(linking.sent, attached.sent)).toEqual({ 'PUT /api/pages/:id/blobs': 2 });
    // Making it. Where to write in it is the answer it was made with.
    expect(added(plainPage.sent, folder.sent)).toEqual({ 'POST /api/spaces/:id/folders': 1 });

    // What readers get is what the notes say, the file too.
    expect(attached.summary).toMatchObject({ attachments: 1, unresolved: [], skipped: [] });
    const { page, payload } = await publication(
      attached.spaceId,
      pageIdOf(attached.summary, 'Notes/C.md'),
    );
    expect(payload.markdown).toBe('See [[A]]. ![[photo.png]]');
    const [ref] = payload.attachments;
    if (!ref) throw new Error('expected an attachment');
    const bytes = await pages.readAttachment(person.ctx, page, 'published', ref);
    expect(new TextDecoder().decode(bytes)).toBe('PNG bytes');
    const plainOne = await publication(base.spaceId, pageIdOf(base.summary, 'Notes/A.md'));
    expect(plainOne.payload.markdown).toBe('Plain words.');
  });

  it('cut short, is finished by running it again, each page made once', async () => {
    const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Resumed' });
    const plain = Array.from({ length: 11 }, (_, i) =>
      file(`Notes/${String(i).padStart(2, '0')}.md`, `Words ${i}.`),
    );
    const source = await vault([
      ...plain,
      file('Notes/L.md', 'See [[00]]. ![[photo.png]]'),
      file('photo.png', 'PNG bytes'),
    ]);
    const stop = new AbortController();
    const first = importOperations.importNotes(person.ctx, {
      scope: { spaceId },
      source,
      signal: stop.signal,
      // Once the first batch of pages lands: the next isn't sent.
      onProgress: ({ phase, done }) => {
        if (phase === 'pages' && done === 10) stop.abort();
      },
    });
    await expect(first).rejects.toBeInstanceOf(importOperations.ImportStopped);
    expect(await spaceOperations.loadTree(person.ctx, spaceId)).toMatchObject({
      pages: { length: 10 },
    });

    const again = await importOperations.importNotes(person.ctx, { scope: { spaceId }, source });
    expect(again.existing).toBe(10);
    expect(again.pages.map((p) => p.path)).toEqual(['Notes/10.md', 'Notes/L.md']);
    const tree = await spaceOperations.loadTree(person.ctx, spaceId);
    expect(tree.pages).toHaveLength(12);
    expect(tree.pages.every((p) => p.publishedHead !== null)).toBe(true);
    const l = await publication(spaceId, pageIdOf(again, 'Notes/L.md'));
    expect(l.payload.markdown).toBe('See [[00]]. ![[photo.png]]');
  });

  it('on a server without batches, cut short, is finished by running it again', async () => {
    const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Resumed alone' });
    const source = await vault([
      file('Notes/A.md', 'Plain words.'),
      file('Notes/B.md', 'More plain words.'),
      file('Notes/C.md', 'See [[A]].'),
      file('Notes/D.md', 'See [[B]]. ![[photo.png]]'),
      file('photo.png', 'PNG bytes'),
    ]);
    const { ctx } = through(person.ctx, older(person.browser.fetch));
    const stop = new AbortController();
    const first = importOperations.importNotes(ctx, {
      scope: { spaceId },
      source,
      signal: stop.signal,
      // After the first page is made and published.
      onProgress: ({ phase, done }) => {
        if (phase === 'pages' && done === 1) stop.abort();
      },
    });
    await expect(first).rejects.toBeInstanceOf(importOperations.ImportStopped);

    const again = await importOperations.importNotes(ctx, { scope: { spaceId }, source });
    expect(again.existing).toBe(1);
    expect(again.pages.map((p) => p.path)).toEqual(['Notes/B.md', 'Notes/C.md', 'Notes/D.md']);
    const tree = await spaceOperations.loadTree(person.ctx, spaceId);
    expect(tree.pages).toHaveLength(4);
    expect(tree.pages.every((p) => p.publishedHead !== null)).toBe(true);
    const d = await publication(spaceId, pageIdOf(again, 'Notes/D.md'));
    expect(d.payload.markdown).toBe('See [[B]]. ![[photo.png]]');
  });

  it.each([
    { server: 'with batches', before: false },
    { server: 'without batches', before: true },
  ])(
    'sends a change again when its answer is lost, and makes it once ($server)',
    async ({ before }) => {
      const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Lossy' });
      const source = await vault([
        file('Notes/A.md', 'Plain words.'),
        file('Notes/C.md', 'See [[A]].'),
      ]);
      // The server gets the first of each change and makes it; its answer never arrives.
      const lost = new Set<string>();
      const keys: (string | null)[] = [];
      const sent: string[] = [];
      const lossy: Fetch = async (url, init) => {
        const route = routeOf(url, init);
        const res = await person.browser.fetch(url, init);
        if (route.startsWith('POST') && route !== 'POST /api/revisions/batch') {
          const key = new Headers(init.headers).get('idempotency-key');
          keys.push(key);
          sent.push(route);
          if (!lost.has(key ?? '')) {
            lost.add(key ?? '');
            throw new TypeError('connection reset');
          }
        }
        return res;
      };
      const { ctx } = through(person.ctx, before ? older(lossy) : lossy);
      const summary = await importOperations.importNotes(ctx, { scope: { spaceId }, source });

      // Each change was sent twice, under its one key.
      expect(byRoute(sent)).toEqual(
        before
          ? {
              'POST /api/spaces/:id/folders': 2,
              'POST /api/spaces/:id/pages': 4,
              'POST /api/pages/:id/drafts': 2,
              'POST /api/pages/:id/publications': 4,
            }
          : // The folder, the pages, then C saved and published.
            { [BATCH]: 6 },
      );
      expect(keys.every((key) => key?.startsWith('import:'))).toBe(true);
      expect(keys.length).toBe(2 * new Set(keys).size);
      expect(summary.pages).toHaveLength(2);
      const tree = await spaceOperations.loadTree(person.ctx, spaceId);
      expect(tree.pages).toHaveLength(2);
      expect(tree.pages.every((p) => p.publishedHead !== null)).toBe(true);
    },
  );

  it.each([
    // Its pages made, Z published with them: all sealed again.
    { when: 'its first batch', before: false, route: BATCH, nth: 1 },
    // A saved and published: sealed again, A from its draft fetched afresh.
    { when: 'its second batch', before: false, route: BATCH, nth: 2 },
    // Without batches, Z's publish is refused and sent again alone.
    { when: 'a publish', before: true, route: 'POST /api/pages/:id/publications', nth: 1 },
  ])('finishes when its folder is shared just before $when', async ({ before, route, nth }) => {
    const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Shared midway' });
    const folderId = await spaceOperations.createFolder(person.ctx, {
      spaceId,
      parentId: null,
      name: 'Inbox',
    });
    const reader = await personWithVault(t);
    const member = await invite(person, reader, 'reader');
    const source = await vault([
      file('A.md', 'See [[Z]]. ![[photo.png]]'),
      file('Z.md', 'Plain words.'),
      file('photo.png', 'PNG bytes'),
    ]);
    // Shared, by its owner's other app, after the import sealed what it
    // sends next and before the server gets it: the server refuses it, as
    // where it goes moved into a share.
    let seen = 0;
    const sharing: Fetch = async (url, init) => {
      if (routeOf(url, init) === route && ++seen === nth) {
        await shareFolder(person.ctx, { spaceId, rootId: folderId, people: [member] });
      }
      return person.browser.fetch(url, init);
    };
    const { ctx, sent } = through(person.ctx, before ? older(sharing) : sharing);
    const summary = await importOperations.importNotes(ctx, {
      scope: { spaceId, folderId },
      source,
    });
    expect(summary).toMatchObject({ attachments: 1, unresolved: [], skipped: [] });
    expect(summary.pages).toHaveLength(2);
    // The refused one, and the same sealed again.
    expect(sent.filter((r) => r === route).length).toBeGreaterThan(nth);

    // Its member reads both, the file too.
    const z = await publication(spaceId, pageIdOf(summary, 'Z.md'), reader.ctx);
    expect(z.payload.markdown).toBe('Plain words.');
    const a = await publication(spaceId, pageIdOf(summary, 'A.md'), reader.ctx);
    const [ref] = a.payload.attachments;
    if (!ref) throw new Error('expected an attachment');
    const bytes = await pages.readAttachment(reader.ctx, a.page, 'published', ref);
    expect(new TextDecoder().decode(bytes)).toBe('PNG bytes');
  });

  it('finishes when another app rotates its share between batches', async () => {
    const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Rotated midway' });
    const folderId = await spaceOperations.createFolder(person.ctx, {
      spaceId,
      parentId: null,
      name: 'Inbox',
    });
    const reader = await personWithVault(t);
    const member = await invite(person, reader, 'reader');
    const shareId = await shareFolder(person.ctx, { spaceId, rootId: folderId, people: [member] });
    // The owner's phone, whose new key this app learns of only when told.
    const phone = await openSession(person.api, person.vault);
    const source = await vault([file('A.md', 'See [[Z]].'), file('Z.md', 'Plain words.')]);
    let batches = 0;
    const rotating: Fetch = async (url, init) => {
      if (routeOf(url, init) === BATCH && ++batches === 2) {
        await sharingOperations.rotateKeys(phone, { spaceId, shareId });
      }
      return person.browser.fetch(url, init);
    };
    const { ctx } = through(person.ctx, rotating);
    const summary = await importOperations.importNotes(ctx, {
      scope: { spaceId, folderId },
      source,
    });
    expect(summary.pages).toHaveLength(2);
    const a = await publication(spaceId, pageIdOf(summary, 'A.md'), reader.ctx);
    expect(a.payload.markdown).toBe('See [[Z]].');
  });

  it('lands a batch whole or not at all, and makes nothing twice', async () => {
    const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Whole' });
    const source = await vault([file('A.md', 'Plain words.'), file('C.md', 'See [[A]].')]);
    // Every batch the import sends, as sent.
    const batches: { url: string; init: RequestInit }[] = [];
    const capture =
      (change?: (body: BatchBody) => void): Fetch =>
      async (url, init) => {
        if (routeOf(url, init) !== BATCH) return person.browser.fetch(url, init);
        if (typeof init.body !== 'string') throw new Error('expected a JSON body');
        const body = JSON.parse(init.body) as BatchBody;
        change?.(body);
        const sent = { ...init, body: JSON.stringify(body) };
        batches.push({ url, init: sent });
        return person.browser.fetch(url, sent);
      };

    // A's publication isn't its writer's: the batch is refused, and A,
    // made in it before, isn't made, nor C after.
    const forged = through(
      person.ctx,
      capture((body) => {
        const published = body.pages.find((page) => page.publish)?.publish;
        if (published) {
          const { signature } = published.revision;
          published.revision.signature = `${signature.slice(0, -2)}${signature.endsWith('AA') ? 'BA' : 'AA'}`;
        }
      }),
    );
    await expect(
      importOperations.importNotes(forged.ctx, { scope: { spaceId }, source }),
    ).rejects.toMatchObject({ code: 'bad-signature' });
    expect((await spaceOperations.loadTree(person.ctx, spaceId)).pages).toHaveLength(0);

    batches.length = 0;
    const { ctx } = through(person.ctx, capture());
    await importOperations.importNotes(ctx, { scope: { spaceId }, source });
    const [made, saved] = batches;
    if (!made || !saved) throw new Error('expected two batches');
    const resend = (
      { url, init }: { url: string; init: RequestInit },
      to: { spaceId?: SpaceId; key?: string } = {},
    ) => {
      const headers = new Headers(init.headers);
      headers.set('idempotency-key', to.key ?? `test:${crypto.randomUUID()}`);
      const where = to.spaceId ? url.replace(spaceId, to.spaceId) : url;
      return person.browser.fetch(where, { ...init, headers });
    };
    // Sent again under a new key, its versions are the ones stored: nothing new.
    const again = await resend(made);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ pages: [{}, {}] });
    expect(await resend(saved)).toMatchObject({ status: 200 });
    const tree = await spaceOperations.loadTree(person.ctx, spaceId);
    expect(tree.pages).toHaveLength(2);

    // Into another space: its versions name this one, and its pages are here.
    const elsewhere = await spaceOperations.createSpace(person.ctx, { name: 'Elsewhere' });
    const wrong = await resend(made, { spaceId: elsewhere });
    expect(await wrong.json()).toMatchObject({ error: { code: 'binding-mismatch' } });
    const notHere = await resend(saved, { spaceId: elsewhere });
    expect(await notHere.json()).toMatchObject({ error: { code: 'not-found' } });
    expect((await spaceOperations.loadTree(person.ctx, elsewhere)).pages).toHaveLength(0);
  });
});
