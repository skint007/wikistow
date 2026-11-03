import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { adminTab, MARKERS, memberWithVault, newPage, PASSPHRASE, PNG, waitForSave } from './vault';

/** Everything this origin keeps in the browser beyond memory. */
async function browserStorage(page: Page) {
  const stored = await page.evaluate(async () => {
    const entries = (storage: Storage) =>
      Object.fromEntries(
        Array.from({ length: storage.length }, (_, i) => storage.key(i) ?? '').map((key) => [
          key,
          storage.getItem(key),
        ]),
      );
    // The tab's kept unlock: its wrapping key, as the page can see it.
    const wrappingKey = (await indexedDB.databases()).some((db) => db.name === 'wikistow-vault')
      ? await new Promise<CryptoKey | undefined>((resolve, reject) => {
          const open = indexedDB.open('wikistow-vault');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result.transaction('keys').objectStore('keys').get('tab-unlock');
            get.onsuccess = () => {
              open.result.close();
              resolve(get.result);
            };
          };
        })
      : undefined;
    // What's kept for offline (ADR 0009): each item's name and bytes, as
    // text, so anything kept unsealed would show, and whose it is.
    const kept = (await indexedDB.databases()).some((db) => db.name === 'wikistow-kept')
      ? await new Promise<{ items: string[][]; queue: string[][]; meta: string[][] }>(
          (resolve, reject) => {
            const open = indexedDB.open('wikistow-kept');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction(['items', 'queue', 'meta']);
              const all = (store: string) => {
                const keys = tx.objectStore(store).getAllKeys();
                const values = tx.objectStore(store).getAll();
                return { keys, values };
              };
              const [items, queue, meta] = [all('items'), all('queue'), all('meta')];
              const text = (value: unknown) =>
                value instanceof Uint8Array
                  ? new TextDecoder('latin1').decode(value)
                  : value &&
                      typeof value === 'object' &&
                      'sealed' in value &&
                      value.sealed instanceof Uint8Array
                    ? new TextDecoder('latin1').decode(value.sealed)
                    : JSON.stringify(value);
              const pairs = ({ keys, values }: ReturnType<typeof all>) =>
                keys.result.map((key, i) => [
                  typeof key === 'string' ? key : '',
                  text(values.result[i]),
                ]);
              tx.oncomplete = () => {
                db.close();
                resolve({ items: pairs(items), queue: pairs(queue), meta: pairs(meta) });
              };
              tx.onerror = () => reject(tx.error);
            };
          },
        )
      : undefined;
    return {
      local: entries(localStorage),
      session: entries(sessionStorage),
      indexedDb: (await indexedDB.databases())
        .map((db) => db.name ?? '')
        .sort((a, b) => a.localeCompare(b)),
      kept,
      wrappingKey: wrappingKey && {
        algorithm: wrappingKey.algorithm.name,
        extractable: wrappingKey.extractable,
      },
      caches: await Promise.all(
        (await caches.keys()).map(async (name) => ({
          name,
          files: (await (await caches.open(name)).keys()).map(({ url }) => new URL(url).pathname),
        })),
      ),
    };
  });
  const cookies = await page.context().cookies();
  return { ...stored, cookies: cookies.map(({ name, value }) => ({ name, value })) };
}

/**
 * The browser keeps the theme, the editor last picked, the server's last
 * restore it has seen (none here), the folders open in each space's tree
 * (their IDs), the pages whose properties were opened or closed (their
 * IDs), scroll positions and session cookie, and none of `secrets`.
 * The service worker keeps the app's own files in Cache Storage.
 * Settings kept on the device once changed, such as `wikistow.idleLock`,
 * `wikistow.askBeforeMoves` (`false`) and `wikistow.showProperties`
 * (`true`), aren't set here. While the vault is open, the tab
 * also keeps its unlock: the vault key sealed in sessionStorage, under a
 * wrapping key in IndexedDB that no script can read out, and, when it is
 * `remembered`, another sealed copy in localStorage. Locking forgets them all.
 * The pages opened here are kept for offline in IndexedDB (ADR 0009), each
 * item sealed and named by a tag, with the account they belong to beside
 * them, open or locked, what unlocking offline reads (the last `/api/me`
 * answer, the vault wrapper and the installation ID, unsealed), and the
 * trust marks with the contacts record, sealed. Signing out deletes them.
 */
async function expectNothingStored(
  page: Page,
  secrets: readonly string[],
  { open, editor, remembered }: { open: boolean; editor?: 'visual'; remembered?: boolean },
) {
  const stored = await browserStorage(page);
  const { installationId } = await (await page.request.get('/api/installation')).json();
  const kept = (prefix: string) =>
    Object.keys(stored.local).filter((key) => key.startsWith(`${prefix}${installationId}.`));
  expect(stored.local).toEqual({
    'wikistow.theme': expect.any(String),
    ...(editor ? { 'wikistow.editor': editor } : {}),
    ...(remembered ? { 'wikistow.vault': expect.stringMatching(/"version":\d+}$/) } : {}),
    [`wikistow.restore.${installationId}`]: '',
    // Folder IDs only.
    ...Object.fromEntries(
      kept('wikistow.expanded.').map((key) => [key, expect.stringMatching(/^\[("[\w-]+",?)*\]$/)]),
    ),
    // Page IDs, each open or not.
    ...Object.fromEntries(
      kept('wikistow.properties.').map((key) => [
        key,
        expect.stringMatching(/^\{("[\w-]+":(true|false),?)*\}$/),
      ]),
    ),
  });
  // The router's scroll positions, by visit, and the kept unlock.
  expect(Object.keys(stored.session).sort()).toEqual([
    expect.stringMatching(/^tsr-scroll-restoration-v1/),
    ...(open ? ['wikistow.vault'] : []),
  ]);
  expect(stored.indexedDb).toEqual(open ? ['wikistow-kept', 'wikistow-vault'] : ['wikistow-kept']);
  // The index, the space, the page's versions and its image, at least.
  expect(stored.kept?.items.length).toBeGreaterThanOrEqual(4);
  expect(stored.kept?.items.every(([name]) => /^[\w-]{22}$/.test(name ?? ''))).toBe(true);
  expect(stored.kept?.queue).toEqual([]);
  expect(stored.kept?.meta.map(([key]) => key).sort()).toEqual([
    'account',
    'trust-marks',
    'unlock installation',
    'unlock me',
    'unlock vault',
  ]);
  expect(stored.wrappingKey).toEqual(
    open ? { algorithm: 'AES-GCM', extractable: false } : undefined,
  );
  // The service worker's copy of the app's own files (ADR 0009), and nothing the server answers.
  expect(stored.caches).toEqual([
    { name: expect.stringMatching(/^wikistow-app-[0-9a-f]{16}$/), files: expect.any(Array) },
  ]);
  expect(
    stored.caches
      .flatMap(({ files }) => files)
      .filter((file) => !/^\/(assets\/)?[\w.-]+$/.test(file)),
  ).toEqual([]);
  expect(stored.cookies.map((c) => c.name)).toEqual([
    expect.stringMatching(/^better-auth\.session_token$/),
  ]);
  const all = JSON.stringify(stored);
  expect(secrets.filter((secret) => all.includes(secret))).toEqual([]);
}

/**
 * Decrypted pages, the keys that open them, the search index built from
 * them and a Markdown export live only in memory, apart from the vault key
 * the tab keeps sealed for a refresh, and the browser for later visits when
 * asked to, and the pages opened, kept sealed for offline. After a whole page flow, a search and an export, the browser's
 * storage holds the theme choice, the editor picked, the last restore seen,
 * the open folders' IDs, the router's scroll positions, the session cookie
 * and those sealed copies, and nothing typed.
 */
test('the browser stores no page content or key material', async ({ page, freshPage, admin }) => {
  const { recoveryKey } = await memberWithVault(page, await adminTab(freshPage, admin.email));
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill(MARKERS.folder);
  await page.getByRole('button', { name: 'Create folder' }).click();
  await newPage(page, MARKERS.title);
  await page.locator('#page-source').fill(MARKERS.published);
  await page.locator('input[type=file]').setInputFiles({
    name: MARKERS.attachment,
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByRole('list').filter({ hasText: MARKERS.attachment })).toBeVisible();
  await waitForSave(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('img', { name: MARKERS.attachment })).toHaveAttribute(
    'src',
    /^blob:/,
  );
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#page-source').fill(MARKERS.private);
  await waitForSave(page);
  // The visual editor, picked, is remembered as a choice and holds nothing typed.
  await page.getByRole('group', { name: 'Editor' }).getByRole('button', { name: 'Visual' }).click();
  await expect(page.locator('#page-visual')).toContainText(MARKERS.private);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'History' }).getByText('Version 1')).toBeVisible();

  const secrets = [
    ...Object.values(MARKERS),
    PASSPHRASE,
    recoveryKey,
    recoveryKey.replaceAll('-', ''),
  ];
  const check = (open = true, remembered = false) =>
    expectNothingStored(page, secrets, { open, editor: 'visual', remembered });
  // While the vault is open, once the page is kept for offline, once search
  // has indexed it, and after it locks.
  await expect(() => check()).toPass();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Search' });
  await expect(search.getByRole('status')).toHaveText(
    'Search the titles and text of every page you can read. Filter by tag:soup, or by any property: status:"in progress".',
    { timeout: 30_000 },
  );
  await search.getByRole('combobox', { name: 'Search pages' }).fill('wifi hunter');
  await expect(search.getByRole('option')).toHaveCount(1);
  await expect(search.getByRole('option').locator('mark')).toHaveText(['wifi', 'hunter2']);
  await check();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  // An export is built in memory and handed to the browser to save.
  await page.getByRole('button', { name: 'Space menu' }).click();
  await page.getByRole('menuitem', { name: 'Export…' }).click();
  const exporting = page.getByRole('dialog', { name: /^Export “/ });
  const [saved] = await Promise.all([
    page.waitForEvent('download'),
    exporting.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  expect(await saved.failure()).toBeNull();
  await expect(exporting).toBeHidden();
  await check();
  // Remembered for later visits, and forgotten by the lock with the rest.
  await page.goto('/settings');
  const remember = page.getByRole('switch', { name: 'Remember unlock' });
  await remember.click();
  await expect(remember).toBeChecked();
  await check(true, true);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
  await expect(remember).not.toBeChecked();
  await expect(remember).toBeDisabled();
  // Forgetting the kept unlock finishes a moment after the page locks.
  await expect(() => check(false)).toPass();
  // Signing out deletes what was kept for offline.
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  const signedOut = await browserStorage(page);
  expect(signedOut.indexedDb).toEqual([]);
  // The sign-in page, asking whether anyone is signed in, makes nothing again.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect((await browserStorage(page)).indexedDb).toEqual([]);
});
