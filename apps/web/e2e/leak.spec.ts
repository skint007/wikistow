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
    return {
      local: entries(localStorage),
      session: entries(sessionStorage),
      indexedDb: (await indexedDB.databases()).map((db) => db.name),
      wrappingKey: wrappingKey && {
        algorithm: wrappingKey.algorithm.name,
        extractable: wrappingKey.extractable,
      },
      caches: await caches.keys(),
    };
  });
  const cookies = await page.context().cookies();
  return { ...stored, cookies: cookies.map(({ name, value }) => ({ name, value })) };
}

/**
 * The browser keeps the theme, the editor last picked, the server's last
 * restore it has seen (none here), the folders open in each space's tree
 * (their IDs), scroll positions and session cookie, and
 * none of `secrets`. While the vault is open, the tab
 * also keeps its unlock: the vault key sealed in sessionStorage, under a
 * wrapping key in IndexedDB that no script can read out. Locking forgets both.
 */
async function expectNothingStored(
  page: Page,
  secrets: readonly string[],
  { open, editor }: { open: boolean; editor?: 'visual' },
) {
  const stored = await browserStorage(page);
  const { installationId } = await (await page.request.get('/api/installation')).json();
  const expanded = Object.keys(stored.local).filter((key) =>
    key.startsWith(`wikistow.expanded.${installationId}.`),
  );
  expect(stored.local).toEqual({
    'wikistow.theme': expect.any(String),
    ...(editor ? { 'wikistow.editor': editor } : {}),
    [`wikistow.restore.${installationId}`]: '',
    // Folder IDs only.
    ...Object.fromEntries(
      expanded.map((key) => [key, expect.stringMatching(/^\[("[\w-]+",?)*\]$/)]),
    ),
  });
  // The router's scroll positions, by visit, and the kept unlock.
  expect(Object.keys(stored.session).sort()).toEqual([
    expect.stringMatching(/^tsr-scroll-restoration-v1/),
    ...(open ? ['wikistow.vault'] : []),
  ]);
  expect(stored.indexedDb).toEqual(open ? ['wikistow-vault'] : []);
  expect(stored.wrappingKey).toEqual(
    open ? { algorithm: 'AES-GCM', extractable: false } : undefined,
  );
  expect(stored.caches).toEqual([]);
  expect(stored.cookies.map((c) => c.name)).toEqual([
    expect.stringMatching(/^better-auth\.session_token$/),
  ]);
  const all = JSON.stringify(stored);
  expect(secrets.filter((secret) => all.includes(secret))).toEqual([]);
}

/**
 * Decrypted pages, the keys that open them, the search index built from
 * them and a Markdown export live only in memory, apart from the vault key
 * the tab keeps sealed for a refresh. After a whole page flow, a search and
 * an export, the browser's storage holds the theme choice, the editor
 * picked, the last restore seen, the open folders' IDs, the router's
 * scroll positions, the session cookie and that sealed copy, and nothing
 * typed.
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
  const check = (open = true) => expectNothingStored(page, secrets, { open, editor: 'visual' });
  // While the vault is open, once search has indexed it, and after it locks.
  await check();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  const search = page.getByRole('dialog', { name: 'Search' });
  await expect(search.getByRole('status')).toHaveText(
    'Search the titles and text of every page you can read.',
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
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  // Forgetting the kept unlock finishes a moment after the page locks.
  await expect(() => check(false)).toPass();
});
