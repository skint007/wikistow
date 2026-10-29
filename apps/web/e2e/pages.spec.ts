import type { Page } from '@playwright/test';
import { expect, secretsOnServer, serverSnapshot, signIn, test } from './fixtures';
import {
  adminTab,
  choosePassphrase,
  expectSource,
  MARKERS,
  memberWithVault,
  newPage,
  PASSPHRASE,
  PNG,
  saveStatus,
  waitForSave,
} from './vault';

const editor = (page: Page) => page.locator('#page-source');

/**
 * The same person in a second browser, on `url`. Loading a page's address
 * asks for the passphrase first (a new tab keeps no unlock), then returns
 * there.
 */
async function sameAccountElsewhere(freshPage: () => Promise<Page>, email: string, url: string) {
  const other = await freshPage();
  await signIn(other, email);
  await other.getByRole('heading', { name: 'Unlock your vault' }).waitFor();
  await other.goto(url);
  await other.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await other.getByRole('button', { name: 'Unlock' }).click();
  await other.waitForURL(url);
  return other;
}

async function lockVault(page: Page) {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
}

async function unlockVault(page: Page) {
  await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

test('a page goes from private draft to publication, with an attachment, history, and restore', async ({
  page,
  freshPage,
  admin,
}) => {
  const { email, recoveryKey } = await memberWithVault(
    page,
    await adminTab(freshPage, admin.email),
  );

  // A folder, then a page inside it, from the folder's menu.
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill(MARKERS.folder);
  await page.getByRole('button', { name: 'Create folder' }).click();
  const folder = page.getByRole('treeitem', { name: new RegExp(MARKERS.folder) });
  await expect(folder).toBeVisible();
  await folder.hover();
  await page.getByRole('button', { name: `Actions for ${MARKERS.folder}` }).click();
  await page.getByRole('menuitem', { name: 'New page here' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill(MARKERS.title);
  await page.getByRole('button', { name: 'Create page' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(page.getByText('Not published yet')).toBeVisible();

  // Typing saves on its own.
  await editor(page).fill(`## Notes\n\n${MARKERS.published}`);
  await waitForSave(page);
  await page.locator('input[type=file]').setInputFiles({
    name: MARKERS.attachment,
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByRole('list').filter({ hasText: MARKERS.attachment })).toBeVisible();
  await waitForSave(page);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByRole('heading', { name: MARKERS.title, level: 1 })).toBeVisible();
  await expect(page.getByText('Published v1')).toBeVisible();
  await expect(page.getByText(MARKERS.published)).toBeVisible();
  const image = page.getByRole('img', { name: MARKERS.attachment });
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);

  // A private edit leaves the publication alone until it is published.
  await page.getByRole('button', { name: 'Edit' }).click();
  await editor(page).fill(`## Notes\n\n${MARKERS.private}`);
  await waitForSave(page);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(MARKERS.published)).toBeVisible();
  await expect(page.getByRole('button', { name: /Draft has changes/ })).toBeVisible();
  await expect(page.getByText(MARKERS.private)).toHaveCount(0);

  await page.getByRole('button', { name: /Draft has changes/ }).click();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v2')).toBeVisible();

  // History shows both; restoring the first makes it the draft again.
  await page.getByRole('button', { name: 'History' }).click();
  const sheet = page.getByRole('dialog', { name: 'History' });
  await expect(sheet.getByText('Version 2')).toBeVisible();
  await sheet.getByRole('button', { name: 'Restore as draft' }).click();
  await expectSource(page, new RegExp(MARKERS.published));
  await expect(page.getByRole('list').filter({ hasText: MARKERS.attachment })).toBeVisible();
  await waitForSave(page);

  // None of it reached the server readable; the account's email, stored as is, shows the search works.
  const { rows, blobs } = await serverSnapshot();
  expect(rows['revisions']?.length).toBeGreaterThan(0);
  expect(blobs.length).toBeGreaterThan(0);
  expect(await secretsOnServer([email])).toEqual([email]);
  expect(
    await secretsOnServer([
      ...Object.values(MARKERS),
      PASSPHRASE,
      recoveryKey,
      recoveryKey.replaceAll('-', ''),
    ]),
  ).toEqual([]);
});

test('the vault locks, unlocks with the passphrase, and recovers with the key', async ({
  page,
  freshPage,
  admin,
}) => {
  const { recoveryKey } = await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Kept safe');
  await editor(page).fill('locked away');
  await waitForSave(page);

  // A refresh keeps the tab unlocked; locking forgets that, so a refresh after asks.
  await page.reload();
  await expect(page.getByRole('treeitem', { name: 'Kept safe' })).toBeVisible();
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await expect(page.getByText('locked away')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();

  await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('treeitem', { name: 'Kept safe' })).toBeVisible();

  // Forgotten passphrase: the recovery key opens it, then a new passphrase is set.
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
  await page.getByRole('link', { name: 'Use your recovery key instead' }).click();
  await page.getByLabel('Recovery key').fill(recoveryKey);
  await page.getByRole('button', { name: 'Continue' }).click();
  const fresh = 'a brand new vault passphrase';
  await choosePassphrase(page, fresh);
  await page.getByRole('button', { name: 'Save passphrase' }).click();
  await expect(page.getByRole('treeitem', { name: 'Kept safe' })).toBeVisible();

  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
  await page.getByLabel('Vault passphrase').fill(fresh);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('treeitem', { name: 'Kept safe' })).toBeVisible();
});

test('two tabs editing one draft never overwrite each other', async ({
  page,
  freshPage,
  admin,
}) => {
  // Two browsers each unlock the vault at the real key-derivation cost.
  test.slow();
  const { email } = await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Shared draft');
  await editor(page).fill('first');
  await waitForSave(page);
  const other = await sameAccountElsewhere(freshPage, email, page.url());
  await editor(other).fill('second, from the other tab');
  await waitForSave(other);

  await editor(page).fill('first, edited further');
  await expect(page.getByRole('alert')).toContainText('Someone else saved this draft');
  await page.getByRole('button', { name: 'Save mine on top' }).click();
  await waitForSave(page);
  await other.reload();
  await expectSource(other, 'first, edited further');
});

test('typing carries on through autosaves without losing a keystroke or focus', async ({
  page,
  freshPage,
  admin,
}) => {
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Typed in bursts');
  await editor(page).click();
  // Each pause is long enough to start a save, and the next burst follows at once.
  let typed = '';
  for (const burst of ['one ', 'two ', 'three ', 'four']) {
    await page.keyboard.type(burst, { delay: 20 });
    typed += burst;
    await expect(saveStatus(page)).not.toHaveText('Unsaved changes');
  }
  await waitForSave(page);
  await expectSource(page, typed);
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type(' and more');
  await expectSource(page, `${typed} and more`);
  await waitForSave(page);

  await page.reload();
  await expectSource(page, `${typed} and more`);
});

test('locking, leaving or closing the page saves what was just typed, or asks first', async ({
  page,
  freshPage,
  admin,
}) => {
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Somewhere else');
  await newPage(page, 'Typed then locked');
  await editor(page).fill('typed a moment before locking');
  // Well inside the second before autosave would run.
  await expect(saveStatus(page)).toHaveText('Unsaved changes');
  await lockVault(page);
  await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await unlockVault(page);
  await expectSource(page, 'typed a moment before locking');

  // Inside the autosave wait: saved on the way out, no question.
  const asked: string[] = [];
  page.on('dialog', (dialog) => asked.push(dialog.type()));
  await editor(page).fill('saved on the way out');
  await page.getByRole('treeitem', { name: 'Somewhere else' }).click();
  await expect(page.locator('#page-title')).toHaveValue('Somewhere else');
  await page.goBack();
  await expectSource(page, 'saved on the way out');
  expect(asked).toEqual([]);

  await editor(page).fill('typed just before closing');
  await expect(saveStatus(page)).toHaveText('Unsaved changes');
  const closing = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await closing;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  expect(page.isClosed()).toBe(false);
});

test('a long page list scrolls in the sidebar, never the window', async ({
  page,
  freshPage,
  admin,
}) => {
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await page.setViewportSize({ width: 1280, height: 420 });
  // Drafts, so each row carries the unpublished dot and its sr-only text.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await newPage(page, `Draft ${n}`);
  const overflows = await page.evaluate(() => {
    const tree = document.querySelector('[role=tree]')!;
    const window = document.documentElement;
    return {
      tree: tree.scrollHeight > tree.clientHeight,
      window: window.scrollHeight > window.clientHeight,
    };
  });
  expect(overflows).toEqual({ tree: true, window: false });
});
