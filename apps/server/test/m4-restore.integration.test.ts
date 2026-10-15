// The Milestone 4 restore drill (wikistow.md, "Exercise a restored database
// and blob backup"; docs/operations.md). It backs up a live installation
// with scripts/backup.sh, keeps writing, restores with scripts/restore.sh
// onto another installation's database and an empty blob directory, and
// starts the real server on them. People sign in again and read with their
// own keys, and the plugin library's files come back with the rest.
// The scripts need pg_dump, pg_restore and psql 17 on PATH. Without them this fails.
import {
  createApiClient,
  inlineVaultCrypto,
  openSession,
  openVault,
  pageOperations as pages,
  spaceOperations,
  type ClientContext,
} from '@wikistow/client';
import { pluginHash } from '@wikistow/plugin-sdk/files';
import { connect, readSettings, schema } from '@wikistow/server';
import { createTestDatabase } from '@wikistow/server/testing';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm, stat, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { PASSWORD } from './support/accounts.ts';
import { PASSPHRASE, personWithVault } from './support/content.ts';
import { Browser, testAppOn, type TestApp } from './support/harness.ts';
import { script } from './support/scripts.ts';
import type { KeyHolder } from './support/opens.ts';
import { invite, shareFolder, type Person } from './support/sharing.ts';

const MARKER = 'PLAINTEXT-M4-RESTORED-PAGE-8b8b';
/** A theme plugin's files, as an upload carries them. */
const PLUGIN = Object.entries({
  'wikistow-plugin.json': JSON.stringify({
    id: 'restored',
    name: 'Restored',
    version: '1.0.0',
    api: 1,
    styles: ['style.css'],
  }),
  'style.css': 'p{}',
}).map(([path, text]) => ({ path, data: Buffer.from(text).toString('base64url') }));
/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * `url`'s database opened again, as by a server starting after a restore.
 * The restore refuses while anything else is connected, so callers close
 * their pool first, as stopping the server would.
 */
function reconnect(url: string) {
  const { db, close } = connect(url, { max: 4 });
  return { url, db, drop: close };
}

const blobPath = (app: TestApp, hash: string) =>
  join(app.blobDir, 'objects', hash.slice(0, 2), hash);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Sign in to `app` with `person`'s password and unlock their vault with the passphrase. */
async function reopen(app: TestApp, person: Person): Promise<KeyHolder & { browser: Browser }> {
  const browser = new Browser(app.app);
  const signedIn = await browser.request('/api/auth/sign-in/email', {
    method: 'POST',
    json: { email: person.email, password: PASSWORD },
  });
  expect(signedIn.status).toBe(200);
  const api = createApiClient({ fetch: browser.fetch });
  const vault = await openVault({
    api,
    crypto: inlineVaultCrypto,
    secret: { kind: 'passphrase', passphrase: PASSPHRASE },
  });
  return { identity: vault.identity, ctx: await openSession(api, vault), browser };
}

/** The published page's text and its attachment, opened with `ctx`'s own keys. */
async function readPublished(ctx: ClientContext, page: pages.PageRef) {
  const { heads } = await pages.loadPage(ctx, page.pageId);
  if (!heads.publishedHead) throw new Error('expected a publication');
  const { opened } = await pages.openRevisionOf(ctx, page, 'published', heads.publishedHead);
  if (opened.kind !== 'current') throw new Error('expected a current payload');
  const [ref] = opened.payload.attachments;
  if (!ref) throw new Error('expected an attachment');
  const file = await pages.readAttachment(ctx, page, 'published', ref);
  return { markdown: opened.payload.markdown, file: Buffer.from(file) };
}

let live: Awaited<ReturnType<typeof createTestDatabase>>;
let t: TestApp;
let restored: TestApp | undefined;
let backups: string;
beforeAll(async () => {
  live = await createTestDatabase();
  t = testAppOn(live, await mkdtemp(join(tmpdir(), 'wikistow-blobs-')));
  backups = await mkdtemp(join(tmpdir(), 'wikistow-backups-'));
});
afterAll(async () => {
  await restored?.drop();
  await t.drop();
  await rm(backups, { recursive: true, force: true });
});

describe('Milestone 4 proofs: backup and restore', () => {
  it('a restored installation keeps its ID, accounts, pages and attachments, and nothing newer', async () => {
    // Olive publishes a page with an attachment and shares its folder with Rita.
    const [olive, rita] = await Promise.all([personWithVault(t), personWithVault(t)]);
    const spaceId = await spaceOperations.createSpace(olive.ctx, { name: 'Home' });
    const folder = await spaceOperations.createFolder(olive.ctx, {
      spaceId,
      parentId: null,
      name: 'Shared',
    });
    const page = async (title: string) => ({
      spaceId,
      pageId: await pages.createPage(olive.ctx, {
        spaceId,
        parentId: folder,
        title,
        markdown: MARKER,
      }),
    });
    const plan = await page('Plan');
    const dot = await pages.uploadAttachment(olive.ctx, plan, {
      name: 'dot.png',
      mediaType: 'image/png',
      bytes: PNG,
    });
    await pages.editDraft(olive.ctx, plan, { attachments: [dot] });
    await pages.publishPage(olive.ctx, plan);
    await shareFolder(olive.ctx, {
      spaceId,
      rootId: folder,
      people: [await invite(olive, rita, 'reader')],
    });
    // And uploads a plugin to the library.
    const uploaded = await olive.browser.request('/api/plugins', {
      method: 'POST',
      json: { files: PLUGIN },
    });
    expect(uploaded.status).toBe(201);
    const pluginFile = `/plugins/restored/${await pluginHash(new Map(PLUGIN.map((f) => [f.path, Buffer.from(f.data, 'base64url')])))}/style.css`;

    // Pointed at the wrong blob directory, a backup fails rather than miss the files.
    await expect(script('backup.sh', { ...t, blobDir: backups }, [backups])).rejects.toThrow(
      /lacks \d+ file/,
    );
    const backup = await script('backup.sh', t, [backups]);
    // Written after the backup, so a restore must not have it.
    const after = await page('After');
    const later = await pages.uploadAttachment(olive.ctx, after, {
      name: 'later.png',
      mediaType: 'image/png',
      bytes: PNG,
    });

    // Another installation, as a new host's first start leaves it: migrated,
    // with its own ID, and an empty blob directory.
    const target = await createTestDatabase();
    await target.db.update(schema.settings).set({ installationId: randomUUID() });
    expect((await readSettings(target.db)).installationId).not.toBe(olive.ctx.installationId);
    let r = testAppOn(target, await mkdtemp(join(tmpdir(), 'wikistow-restored-')));
    restored = r;
    // A copy cut short in transit is refused.
    const damaged = join(backups, 'damaged');
    await cp(backup, damaged, { recursive: true });
    await truncate(join(damaged, 'blobs.tar'), 512);
    await expect(script('restore.sh', r, ['--server-stopped', damaged])).rejects.toThrow(
      /don't match SHA256SUMS/,
    );
    await target.drop();
    await script('restore.sh', r, ['--server-stopped', backup]);
    r = testAppOn(reconnect(target.url), r.blobDir);
    restored = r;

    // The same installation, which every client has pinned.
    expect((await readSettings(r.db)).installationId).toBe(olive.ctx.installationId);
    // Reported as restored, from a backup taken when its name says, so
    // clients start over from it rather than refuse it as a rollback.
    const res = await r.app.request('/api/installation');
    expect(await res.json()).toMatchObject({
      installationId: olive.ctx.installationId,
      restore: {
        restoredAt: expect.any(String),
        backupTakenAt: basename(backup).replace(
          /^wikistow-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/,
          '$1-$2-$3T$4:$5:$6.000Z',
        ),
      },
    });

    // Olive and Rita sign in with their passwords, unlock with their
    // passphrases, and open the page and its attachment with their own keys.
    const olive2 = await reopen(r, olive);
    const rita2 = await reopen(r, rita);
    expect(olive2.ctx.installationId).toBe(olive.ctx.installationId);
    for (const { ctx } of [olive2, rita2]) {
      expect(await readPublished(ctx, plan)).toEqual({ markdown: MARKER, file: PNG });
    }
    const served = await olive2.browser.request(pluginFile);
    expect(await served.text()).toBe('p{}');

    // Rolled back in place, over its own database and files, the live
    // installation loses the later page and its file, and gets back a file
    // it lost.
    await rm(blobPath(t, dot.blobHash));
    await live.drop();
    await script('restore.sh', t, ['--server-stopped', backup]);
    t = testAppOn(reconnect(live.url), t.blobDir);
    expect(await t.db.select().from(schema.nodes).where(eq(schema.nodes.id, after.pageId))).toEqual(
      [],
    );
    expect(await exists(blobPath(t, later.blobHash))).toBe(false);
    expect(await exists(blobPath(t, dot.blobHash))).toBe(true);
  }, 120_000);
});
