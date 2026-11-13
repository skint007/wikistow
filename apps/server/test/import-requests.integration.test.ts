// How many requests an import sends for each folder, page and attachment
// (#399), and that sending fewer keeps what it makes and how it resumes.
// Sent one after another, each request costs a round trip, so the count
// is what a large import's time is made of.
import {
  createApiClient,
  importOperations,
  pageOperations as pages,
  readObsidianVault,
  spaceOperations,
  type ClientContext,
  type Fetch,
  type ImportFile,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
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

/** Import `files`, a vault, into a new space, and the requests the import sent. */
async function importCounted(files: ImportFile[]) {
  const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Imported' });
  const { ctx, sent } = through(person.ctx, person.browser.fetch);
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
  it('sends few requests for each folder, page and attachment', async () => {
    const plain = file('Notes/A.md', 'Plain words.');
    const base = await importCounted([plain]);
    const plainPage = await importCounted([plain, file('Notes/B.md', 'More words.')]);
    const linking = await importCounted([plain, file('Notes/C.md', 'See [[A]].')]);
    const attached = await importCounted([
      plain,
      file('Notes/C.md', 'See [[A]]. ![[photo.png]]'),
      file('photo.png', 'PNG bytes'),
    ]);
    const folder = await importCounted([plain, file('Other/B.md', 'More words.')]);

    // Before #399, each page took 8: a write-target lookup for each of
    // create, save and publish, the page and its draft fetched again to
    // publish, and an attachment 3, its draft copy downloaded to seal for
    // readers. A folder took 2, as it still does.
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
    // Making it, and asking once where to write in it.
    expect(added(plainPage.sent, folder.sent)).toEqual({
      'GET /api/spaces/:id/target': 1,
      'POST /api/spaces/:id/folders': 1,
    });

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
    const source = await vault([
      file('Notes/A.md', 'Plain words.'),
      file('Notes/B.md', 'More plain words.'),
      file('Notes/C.md', 'See [[A]].'),
      file('Notes/D.md', 'See [[B]]. ![[photo.png]]'),
      file('photo.png', 'PNG bytes'),
    ]);
    const stop = new AbortController();
    const first = importOperations.importNotes(person.ctx, {
      scope: { spaceId },
      source,
      signal: stop.signal,
      // After the first page is published.
      onProgress: ({ phase, done }) => {
        if (phase === 'saving' && done === 1) stop.abort();
      },
    });
    await expect(first).rejects.toBeInstanceOf(importOperations.ImportStopped);

    const again = await importOperations.importNotes(person.ctx, { scope: { spaceId }, source });
    expect(again.existing).toBe(1);
    expect(again.pages.map((p) => p.path)).toEqual(['Notes/B.md', 'Notes/C.md', 'Notes/D.md']);
    const tree = await spaceOperations.loadTree(person.ctx, spaceId);
    expect(tree.pages).toHaveLength(4);
    expect(tree.pages.every((p) => p.publishedHead !== null)).toBe(true);
    const d = await publication(spaceId, pageIdOf(again, 'Notes/D.md'));
    expect(d.payload.markdown).toBe('See [[B]]. ![[photo.png]]');
  });

  it('sends a change again when its answer is lost, and makes it once', async () => {
    const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Lossy' });
    const source = await vault([
      file('Notes/A.md', 'Plain words.'),
      file('Notes/C.md', 'See [[A]].'),
    ]);
    // The server gets the first of each change and makes it; its answer never arrives.
    const lost = new Set<string>();
    const keys: (string | null)[] = [];
    const lossy: Fetch = async (url, init) => {
      const route = routeOf(url, init);
      const res = await person.browser.fetch(url, init);
      if (route.startsWith('POST') && route !== 'POST /api/revisions/batch') {
        keys.push(new Headers(init.headers).get('idempotency-key'));
        if (!lost.has(route)) {
          lost.add(route);
          throw new TypeError('connection reset');
        }
      }
      return res;
    };
    const { ctx } = through(person.ctx, lossy);
    const summary = await importOperations.importNotes(ctx, { scope: { spaceId }, source });

    expect([...lost].sort()).toEqual([
      'POST /api/pages/:id/drafts',
      'POST /api/pages/:id/publications',
      'POST /api/spaces/:id/folders',
      'POST /api/spaces/:id/pages',
    ]);
    expect(summary.pages).toHaveLength(2);
    const tree = await spaceOperations.loadTree(person.ctx, spaceId);
    expect(tree.pages).toHaveLength(2);
    // Each change had a key, and only a lost one's was sent twice.
    expect(keys.every((key) => key?.startsWith('import:'))).toBe(true);
    expect(keys.length - new Set(keys).size).toBe(4);
  });

  it('finishes when its folder is shared partway through', async () => {
    const spaceId = await spaceOperations.createSpace(person.ctx, { name: 'Shared midway' });
    const folderId = await spaceOperations.createFolder(person.ctx, {
      spaceId,
      parentId: null,
      name: 'Inbox',
    });
    const reader = await personWithVault(t);
    // A, saved first, finds the share before sending; Z, made whole, when refused.
    const source = await vault([
      file('A.md', 'See [[Z]]. ![[photo.png]]'),
      file('Z.md', 'Plain words.'),
      file('photo.png', 'PNG bytes'),
    ]);
    // Shared, by its owner's other app, once the pages are made and before
    // they are saved: where the import was told to write has moved into a
    // share, which a save finds before sending and a publish when refused.
    let shared: Promise<unknown> | undefined;
    let trees = 0;
    const sharing: Fetch = async (url, init) => {
      // The import loads the tree first to find an earlier run's, then for links.
      if (routeOf(url, init) === 'GET /api/spaces/:id/tree' && ++trees === 2) {
        shared ??= invite(person, reader, 'reader').then((member) =>
          shareFolder(person.ctx, { spaceId, rootId: folderId, people: [member] }),
        );
      }
      await shared;
      return person.browser.fetch(url, init);
    };
    const { ctx } = through(person.ctx, sharing);
    const summary = await importOperations.importNotes(ctx, {
      scope: { spaceId, folderId },
      source,
    });
    expect(summary).toMatchObject({ attachments: 1, unresolved: [], skipped: [] });
    expect(summary.pages).toHaveLength(2);

    // Its member reads both, the file too.
    const z = await publication(spaceId, pageIdOf(summary, 'Z.md'), reader.ctx);
    expect(z.payload.markdown).toBe('Plain words.');
    const a = await publication(spaceId, pageIdOf(summary, 'A.md'), reader.ctx);
    const [ref] = a.payload.attachments;
    if (!ref) throw new Error('expected an attachment');
    const bytes = await pages.readAttachment(reader.ctx, a.page, 'published', ref);
    expect(new TextDecoder().decode(bytes)).toBe('PNG bytes');
  });
});
