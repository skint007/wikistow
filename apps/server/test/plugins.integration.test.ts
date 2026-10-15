// The plugin library on the server (ADR 0002, PR 1): what an upload must
// be, its limits, who owns an ID and may remove it, and the headers a
// library file is served with.
import { createApiClient } from '@wikistow/client';
import { pluginRoutes } from '@wikistow/contracts';
import { pluginHash } from '@wikistow/plugin-sdk/files';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { signedInPerson } from './support/accounts.ts';
import { Browser, createTestApp, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

type Person = Awaited<ReturnType<typeof signedInPerson>>;
type Files = Record<string, string | Uint8Array>;

const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? new TextEncoder().encode(data) : data;

/** A built plugin's files: its manifest, from `manifest`, and `extra`. */
const plugin = (manifest: Record<string, unknown>, extra: Files = {}): Files => ({
  'wikistow-plugin.json': JSON.stringify({ name: 'Notes', version: '1.0.0', api: 1, ...manifest }),
  ...extra,
});

const notes = (version = '1.0.0') =>
  plugin(
    { id: 'notes', version, script: 'script.js', styles: ['style.css'], access: 'read' },
    { 'script.js': `export const v = '${version}';`, 'style.css': 'p{}', 'icons/a.svg': '<svg/>' },
  );

const upload = (person: Person | Browser, files: Files) =>
  ('browser' in person ? person.browser : person).request('/api/plugins', {
    method: 'POST',
    json: {
      files: Object.entries(files).map(([path, data]) => ({
        path,
        data: Buffer.from(bytesOf(data)).toString('base64url'),
      })),
    },
  });

const hashOf = (files: Files) =>
  pluginHash(new Map(Object.entries(files).map(([path, data]) => [path, bytesOf(data)])));

/** The library as `person` sees it, through the API client and its contract. */
const list = async (person: Person) =>
  (await createApiClient({ fetch: person.browser.fetch }).call(pluginRoutes.listPlugins)).plugins;

const remove = (person: Person, path: string) =>
  person.browser.request(`/api/plugins/${path}`, { method: 'DELETE' });

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

const stored = (hash: string) =>
  stat(join(t.blobDir, 'plugins', hash)).then(
    () => true,
    () => false,
  );

describe('the plugin library', () => {
  let ann: Person;
  let bob: Person;
  let admin: Person;
  beforeAll(async () => {
    [ann, bob, admin] = await Promise.all([
      signedInPerson(t),
      signedInPerson(t),
      signedInPerson(t, 'admin'),
    ]);
  });

  it('stores an upload under the desktop’s hash and serves its files to any member', async () => {
    const files = notes();
    const hash = await hashOf(files);
    const res = await upload(ann, files);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      pluginId: 'notes',
      version: { hash, size: expect.any(Number) },
    });
    // Uploading the same folder again answers the same version.
    expect(await (await upload(ann, files)).json()).toMatchObject({ version: { hash } });

    expect(await list(bob)).toEqual([
      expect.objectContaining({
        id: 'notes',
        mine: false,
        owner: { name: ann.email.split('@')[0] },
        versions: [expect.objectContaining({ hash })],
      }),
    ]);
    expect((await list(ann))[0]?.mine).toBe(true);

    const file = await bob.browser.request(`/plugins/notes/${hash}/script.js`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(files['script.js']);
    expect(Object.fromEntries(file.headers)).toMatchObject({
      'content-type': 'text/javascript',
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
    });
    const nested = await bob.browser.request(`/plugins/notes/${hash}/icons/a.svg`);
    expect(nested.headers.get('content-type')).toBe('image/svg+xml');
    expect(nested.headers.get('content-security-policy')).toBe("default-src 'none'");

    // Signed in only; and only under its own ID, a file it has, and a path inside it.
    expect((await new Browser(t.app).request(`/plugins/notes/${hash}/script.js`)).status).toBe(401);
    expect((await bob.browser.request(`/plugins/other/${hash}/script.js`)).status).toBe(404);
    expect((await bob.browser.request(`/plugins/notes/${hash}/missing.js`)).status).toBe(404);
    expect((await bob.browser.request(`/plugins/notes/${hash}/icons`)).status).toBe(404);
    expect((await bob.browser.request(`/plugins/notes/${hash}/%2e%2e/%2e%2e/x`)).status).toBe(404);
  });

  it('refuses what isn’t a built plugin folder', async () => {
    const refused = async (files: Files, message: RegExp) => {
      const res = await upload(ann, files);
      expect(res.status).toBe(400);
      expect(await res.text()).toMatch(message);
    };
    await refused({ 'script.js': 'x' }, /no readable wikistow-plugin\.json/);
    await refused(plugin({ id: 'bad', api: 99 }), /isn’t valid: api/);
    await refused(plugin({ id: 'bad', script: 'script.js' }), /lacks: script\.js/);
    await refused({ ...plugin({ id: 'bad' }), '../escape.js': 'x' }, /files\.1\.path/);
    await refused({ ...plugin({ id: 'bad' }), '/abs.js': 'x' }, /files\.1\.path/);
    await refused({ ...plugin({ id: 'bad' }), 'a//b.js': 'x' }, /files\.1\.path/);
    await refused({ ...plugin({ id: 'bad' }), 'x/': 'x' }, /files\.1\.path/);
    await refused({ ...plugin({ id: 'bad' }), a: 'x', 'a/b': 'y' }, /folder’s name/);
    const twice = await ann.browser.request('/api/plugins', {
      method: 'POST',
      json: {
        files: [
          ...Object.entries(plugin({ id: 'bad' })).map(([path, data]) => ({
            path,
            data: Buffer.from(bytesOf(data)).toString('base64url'),
          })),
          { path: 'x.js', data: 'eA' },
          { path: 'x.js', data: 'eQ' },
        ],
      },
    });
    expect(await errorCode(twice)).toBe('invalid-request');
    expect((await list(ann)).map((p) => p.id)).not.toContain('bad');
  });

  it('keeps a version within 10 MB and 500 files, and its script within 1 MB', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const tooBig = await upload(ann, plugin({ id: 'big' }, { 'big.bin': big }));
    expect(tooBig.status).toBe(413);

    const longScript = plugin(
      { id: 'big', script: 'script.js' },
      { 'script.js': new Uint8Array(1024 * 1024 + 1) },
    );
    const tooLong = await upload(ann, longScript);
    expect(tooLong.status).toBe(413);
    expect(await tooLong.text()).toMatch(/script may be 1 MB/);

    const many: Files = plugin({ id: 'big' });
    for (let i = 0; i < 500; i++) many[`f/${i}.txt`] = '';
    expect((await upload(ann, many)).status).toBe(400);

    // At the limits, it goes in.
    const full = plugin(
      { id: 'big', script: 'script.js' },
      {
        'script.js': new Uint8Array(1024 * 1024),
        'rest.bin': new Uint8Array(9 * 1024 * 1024 - 200),
      },
    );
    expect((await upload(ann, full)).status).toBe(201);
  }, 60_000);

  it('lets only the first uploader add versions, and the owner or an admin remove them', async () => {
    const v1 = await hashOf(notes());
    const v2files = notes('2.0.0');
    const v2 = await hashOf(v2files);

    // Bob can't take Ann's ID.
    const taken = await upload(bob, notes('9.9.9'));
    expect(taken.status).toBe(403);
    expect(await taken.text()).toMatch(/owns the plugin ID notes/);
    expect((await upload(ann, v2files)).status).toBe(201);
    expect((await list(bob)).find((p) => p.id === 'notes')?.versions.map((v) => v.hash)).toEqual([
      v2,
      v1,
    ]);

    // Nor remove anything of hers.
    expect((await remove(bob, `notes/versions/${v1}`)).status).toBe(403);
    expect((await remove(bob, 'notes')).status).toBe(403);

    // Ann removes the first version: its row and files go, and it is no longer served.
    expect(await stored(v1)).toBe(true);
    expect((await remove(ann, `notes/versions/${v1}`)).status).toBe(200);
    expect(await stored(v1)).toBe(false);
    expect((await ann.browser.request(`/plugins/notes/${v1}/script.js`)).status).toBe(404);
    expect((await remove(ann, `notes/versions/${v1}`)).status).toBe(404);
    expect((await list(bob)).find((p) => p.id === 'notes')?.versions.map((v) => v.hash)).toEqual([
      v2,
    ]);

    // An admin removes the whole plugin. The ID stays Ann's, so Bob's
    // plugin can't pose as an update of hers, and she may upload again.
    expect((await remove(admin, 'notes')).status).toBe(200);
    expect(await stored(v2)).toBe(false);
    expect((await list(bob)).map((p) => p.id)).not.toContain('notes');
    expect((await upload(bob, notes('3.0.0'))).status).toBe(403);
    expect((await upload(ann, notes('3.0.0'))).status).toBe(201);
    expect((await list(ann)).find((p) => p.id === 'notes')?.mine).toBe(true);
  });
});
