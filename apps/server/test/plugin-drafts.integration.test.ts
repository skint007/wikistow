// Plugin drafts on the server (ADR 0004, D2): only their owner reaches a
// draft or its build's files, an 11th draft needs `replaces`, and a draft
// keeps within the workshop's limits. Agents are refused with every other
// people-only route in agents.integration.test.ts.
import { ApiError, createApiClient } from '@wikistow/client';
import { pluginDraftRoutes } from '@wikistow/contracts';
import { pluginHash } from '@wikistow/plugin-sdk/files';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { signedInPerson } from './support/accounts.ts';
import { Browser, createTestApp, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

type Person = Awaited<ReturnType<typeof signedInPerson>>;

const api = (person: Person) => createApiClient({ fetch: person.browser.fetch });

const MANIFEST = JSON.stringify({
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  api: 1,
  ui: 'ui.js',
});

const create = (
  person: Person,
  body: {
    files?: { path: string; text: string }[];
    binary?: { path: string; data: string }[];
    replaces?: string;
  } = {},
) => api(person).call(pluginDraftRoutes.createDraft, { body });

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof ApiError ? error.code : String(error)),
  );

const status = async (person: Person | Browser, path: string, method = 'GET', json?: unknown) =>
  (
    await ('browser' in person ? person.browser : person).request(path, {
      method,
      ...(json === undefined ? {} : { json }),
    })
  ).status;

describe('plugin drafts', () => {
  let ann: Person;
  let bob: Person;
  beforeAll(async () => {
    [ann, bob] = await Promise.all([signedInPerson(t), signedInPerson(t)]);
  });

  it('are their owner’s alone, and so are their builds’ files', async () => {
    const { draft } = await create(ann, {
      files: [
        { path: 'wikistow-plugin.json', text: MANIFEST },
        { path: 'src/ui.tsx', text: 'export {};' },
      ],
    });
    expect(draft).toMatchObject({ name: 'Notes', from: null, files: 2 });

    const built = { 'wikistow-plugin.json': MANIFEST, 'ui.js': 'export const v = 1;' };
    const hash = await pluginHash(
      new Map(Object.entries(built).map(([path, text]) => [path, new TextEncoder().encode(text)])),
    );
    const build = {
      files: Object.entries(built).map(([path, text]) => ({
        path,
        data: Buffer.from(text).toString('base64url'),
      })),
    };
    expect(
      await api(ann).call(pluginDraftRoutes.putDraftBuild, {
        params: { draftId: draft.id },
        body: build,
      }),
    ).toEqual({ hash });

    // Its owner fetches the build under `draft-<hash>` and its manifest's ID,
    // with the library's headers.
    const url = pluginDraftRoutes.draftFileUrl('notes', hash, 'ui.js');
    const file = await ann.browser.request(url);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(built['ui.js']);
    expect(Object.fromEntries(file.headers)).toMatchObject({
      'content-type': 'text/javascript',
      'content-security-policy': "default-src 'none'",
      'cache-control': 'private, max-age=31536000, immutable',
    });
    expect(await status(ann, pluginDraftRoutes.draftFileUrl('other', hash, 'ui.js'))).toBe(404);
    // A draft build isn't a library version.
    expect(await status(ann, `/plugins/notes/${hash}/ui.js`)).toBe(404);

    // Nobody else lists, reads, changes, builds or deletes it, or fetches its files.
    const path = `/api/plugin-drafts/${draft.id}`;
    expect((await api(bob).call(pluginDraftRoutes.listDrafts)).drafts).toEqual([]);
    expect(await status(bob, path)).toBe(404);
    expect(await status(bob, `${path}/changes`, 'POST', { put: [], remove: ['src/ui.tsx'] })).toBe(
      404,
    );
    expect(await status(bob, `${path}/build`, 'PUT', build)).toBe(404);
    expect(await status(bob, path, 'DELETE')).toBe(404);
    expect(await status(bob, url)).toBe(404);
    expect(await status(new Browser(t.app), url)).toBe(401);

    const kept = await api(ann).call(pluginDraftRoutes.getDraft, { params: { draftId: draft.id } });
    expect(kept.files.map((f) => f.path)).toEqual(['src/ui.tsx', 'wikistow-plugin.json']);

    // Deleting it takes its build.
    expect(await status(ann, path, 'DELETE')).toBe(200);
    expect(await status(ann, url)).toBe(404);
    expect(await status(ann, path)).toBe(404);
  });

  it('are ten at most, and an eleventh replaces one its owner names', async () => {
    const carol = await signedInPerson(t);
    const made: string[] = [];
    for (let i = 0; i < pluginDraftRoutes.MAX_DRAFTS; i++)
      made.push((await create(carol)).draft.id);
    expect(await errorCode(create(carol))).toBe('draft-limit');

    // Not someone else's draft.
    const bobs = (await create(bob)).draft.id;
    expect(await errorCode(create(carol, { replaces: bobs }))).toBe('not-found');
    expect(await status(bob, `/api/plugin-drafts/${bobs}`)).toBe(200);

    const [oldest = ''] = made;
    await create(carol, { replaces: oldest });
    const left = (await api(carol).call(pluginDraftRoutes.listDrafts)).drafts.map((d) => d.id);
    expect(left).toHaveLength(pluginDraftRoutes.MAX_DRAFTS);
    expect(left).not.toContain(oldest);
  });

  it('keep within the workshop’s limits, or nothing changes', async () => {
    const { draft } = await create(ann, { files: [{ path: 'a.ts', text: 'a' }] });
    const change = (put: { path: string; text: string }[], remove: string[] = []) =>
      errorCode(
        api(ann).call(pluginDraftRoutes.changeDraft, {
          params: { draftId: draft.id },
          body: { put, remove },
        }),
      );
    const path = `/api/plugin-drafts/${draft.id}/changes`;

    // Plain paths of a text kind.
    for (const bad of ['../a.ts', '.hidden.ts', 'a/b/c/d/e/f/g.ts', 'a.png', 'a']) {
      expect(await status(ann, path, 'POST', { put: [{ path: bad, text: '' }] }), bad).toBe(400);
    }
    expect(await change([{ path: 'a.ts/b.ts', text: '' }])).toBe('invalid-request');
    // 256 KB a file, in UTF-8.
    expect(await change([{ path: 'big.ts', text: 'é'.repeat(128 * 1024 + 1) }])).toBe(
      'payload-too-large',
    );
    // 200 files.
    const many = Array.from({ length: 200 }, (_, i) => ({ path: `f/${i}.ts`, text: '' }));
    expect(await change(many)).toBe('payload-too-large');
    expect(await change(many.slice(1))).toBe('ok');
    expect(await change([{ path: 'b.ts', text: '' }])).toBe('payload-too-large');
    expect(await change([{ path: 'b.ts', text: '' }], ['a.ts'])).toBe('ok');
    // 4 MB in all.
    const quarter = 'x'.repeat(250 * 1024);
    expect(
      await errorCode(
        create(ann, {
          files: Array.from({ length: 17 }, (_, i) => ({ path: `${i}.ts`, text: quarter })),
        }),
      ),
    ).toBe('payload-too-large');

    const kept = await api(ann).call(pluginDraftRoutes.getDraft, { params: { draftId: draft.id } });
    expect(kept.draft.files).toBe(200);
    expect(kept.files.filter((f) => !f.path.startsWith('f/')).map((f) => f.path)).toEqual(['b.ts']);
  });

  it('hold fonts and images under public/ as bytes, read apart from the text (#313)', async () => {
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
    // Not UTF-8, with a NUL: what a text column couldn't hold.
    const font = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0xff, 0xfe]);
    const { draft } = await create(ann, {
      files: [{ path: 'wikistow-plugin.json', text: MANIFEST }],
      binary: [{ path: 'public/font.woff2', data: b64(font) }],
    });
    expect(draft).toMatchObject({ files: 2, size: MANIFEST.length + font.length });
    const params = { draftId: draft.id };
    const texts = async () =>
      (await api(ann).call(pluginDraftRoutes.getDraft, { params })).files.map((f) => f.path);
    const binary = async () =>
      (await api(ann).call(pluginDraftRoutes.getDraftBinaryFiles, { params })).files;
    // An older app reads the draft's text as before.
    expect(await texts()).toEqual(['wikistow-plugin.json']);
    expect(await binary()).toEqual([{ path: 'public/font.woff2', data: b64(font) }]);

    const put = (path: string, size: number) =>
      errorCode(
        api(ann).call(pluginDraftRoutes.putDraftBinaryFile, {
          params,
          body: { path, data: b64(new Uint8Array(size)) },
        }),
      );
    const binaryPath = `/api/plugin-drafts/${draft.id}/binary-files`;
    // Fonts and images, under public/ only, and never as text.
    for (const bad of ['src/logo.png', 'logo.png', 'public/logo.bmp', 'public/a.ts']) {
      expect(await status(ann, binaryPath, 'POST', { path: bad, data: '' }), bad).toBe(400);
    }
    expect(
      await status(ann, `/api/plugin-drafts/${draft.id}/changes`, 'POST', {
        put: [{ path: 'public/logo.png', text: '' }],
      }),
    ).toBe(400);
    // 1 MB a font or image.
    expect(await put('public/logo.png', 1024 * 1024 + 1)).toBe('payload-too-large');
    expect(await put('public/logo.png', 1024 * 1024)).toBe('ok');
    expect((await binary()).map((f) => f.path)).toEqual(['public/font.woff2', 'public/logo.png']);
    // Nobody else reads or adds them.
    expect(await status(bob, binaryPath)).toBe(404);
    expect(await status(bob, binaryPath, 'POST', { path: 'public/a.png', data: '' })).toBe(404);

    // The changes route removes them.
    await api(ann).call(pluginDraftRoutes.changeDraft, {
      params,
      body: { remove: ['public/logo.png'] },
    });
    expect((await binary()).map((f) => f.path)).toEqual(['public/font.woff2']);

    // A library version's source/ gives them back as bytes.
    const css = '@font-face { font-family: Serif; src: url(font.woff2); }';
    const manifest = JSON.stringify({
      id: 'serif-fonts',
      name: 'Serif',
      version: '1.0.0',
      api: 1,
      styles: ['serif.css'],
    });
    const built = {
      'wikistow-plugin.json': manifest,
      'serif.css': css,
      'font.woff2': font,
      'source/wikistow-plugin.json': manifest,
      'source/public/serif.css': css,
      'source/public/font.woff2': font,
    };
    const uploaded = await ann.browser.request('/api/plugins', {
      method: 'POST',
      json: {
        files: Object.entries(built).map(([path, data]) => ({
          path,
          data: b64(typeof data === 'string' ? new TextEncoder().encode(data) : data),
        })),
      },
    });
    expect(uploaded.status).toBe(201);
    const hash = await pluginHash(
      new Map(
        Object.entries(built).map(([path, data]) => [
          path,
          typeof data === 'string' ? new TextEncoder().encode(data) : data,
        ]),
      ),
    );
    const copy = await api(ann).call(pluginDraftRoutes.createDraft, {
      body: { from: { pluginId: 'serif-fonts', hash } },
    });
    const from = { draftId: copy.draft.id };
    expect(
      (await api(ann).call(pluginDraftRoutes.getDraft, { params: from })).files.map((f) => f.path),
    ).toEqual(['public/serif.css', 'wikistow-plugin.json']);
    expect(
      (await api(ann).call(pluginDraftRoutes.getDraftBinaryFiles, { params: from })).files,
    ).toEqual([{ path: 'public/font.woff2', data: b64(font) }]);
  });

  it('keep their workshop apart from the draft, within its limit, until cleared or deleted (#314)', async () => {
    const cal = await signedInPerson(t);
    const { draft } = await create(cal);
    const params = { draftId: draft.id };
    const read = () => api(cal).call(pluginDraftRoutes.getDraftWorkshop, { params });
    const keep = (workshop: unknown, revision: number) =>
      api(cal).call(pluginDraftRoutes.putDraftWorkshop, {
        params,
        body: {
          workshop: pluginDraftRoutes.putDraftWorkshop.body.shape.workshop.parse(workshop),
          revision,
        },
      });
    expect(await read()).toEqual({ workshop: null, revision: 0 });

    const kept = { kept: 1, messages: [{ role: 'user', text: 'Make a clock' }], made: 2 };
    expect(await keep(kept, 0)).toEqual({ revision: 1 });
    expect(await read()).toEqual({ workshop: kept, revision: 1 });
    // Keeping it leaves the draft where it was in the list.
    expect((await api(cal).call(pluginDraftRoutes.getDraft, { params })).draft).toEqual(draft);
    // A device that read revision 0 doesn't keep its own over another's.
    expect(await errorCode(keep({ kept: 1, messages: [] }, 0))).toBe('stale-head');
    // Another person's draft is not found, as a missing one is.
    expect(await errorCode(api(bob).call(pluginDraftRoutes.getDraftWorkshop, { params }))).toBe(
      'not-found',
    );
    expect(
      await errorCode(
        api(bob).call(pluginDraftRoutes.putDraftWorkshop, {
          params,
          body: { workshop: 1, revision: 1 },
        }),
      ),
    ).toBe('not-found');

    // Past the limit it is refused, and what was kept stays.
    const long = 'x'.repeat(pluginDraftRoutes.MAX_DRAFT_WORKSHOP_BYTES);
    expect(await errorCode(keep({ text: long }, 1))).toBe('payload-too-large');
    expect(await read()).toEqual({ workshop: kept, revision: 1 });

    // Clear conversation forgets it, whatever the revision; the draft stays.
    await api(cal).call(pluginDraftRoutes.clearDraftWorkshop, { params });
    expect(await read()).toEqual({ workshop: null, revision: 2 });
    expect(await keep(kept, 2)).toEqual({ revision: 3 });
    await api(cal).call(pluginDraftRoutes.deleteDraft, { params });
    expect(await errorCode(read())).toBe('not-found');
  });
});
