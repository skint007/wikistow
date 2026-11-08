import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixtures';
import {
  adminTab,
  expectSource,
  fillSource,
  memberWithVault,
  newPage,
  PASSPHRASE,
  saveStatus,
  waitForSave,
} from './vault';

/**
 * Marks `html[data-keeping]` running while the keeper holds the kept
 * store's lock, and done once it lets go, from the next load on.
 */
async function watchKeeping(page: Page) {
  await page.addInitScript(() => {
    setInterval(() => {
      void navigator.locks.query().then(({ held = [] }) => {
        const keeping = document.documentElement.dataset;
        if (held.some((lock) => lock.name === 'wikistow-kept')) keeping['keeping'] = 'running';
        else if (keeping['keeping'] === 'running') keeping['keeping'] = 'done';
      });
    }, 10);
  });
}

/**
 * Pages opened on this browser stay readable when the server stops
 * answering (ADR 0009, decisions 4, 5, 8 and 9): the app says it is
 * offline, opens the kept pages and follows links between them, searches
 * them, and says "Needs the connection" on what waits for the server. It
 * loads again offline, and the vault opens from what the tab kept, or
 * with the passphrase against the wrapper kept. Diagrams draw, from the
 * frame's files in the browser's cache (#333). Back online, it says so
 * once the server answers, and the session goes on.
 */
test('pages opened here read, search and unlock offline', async ({
  page,
  context,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  for (const [title, text] of [
    ['Bean soup', 'Beans and stock. Serve with [[Bread]].'],
    ['Bread', 'Flour and rye, baked slowly.\n\n```mermaid\nflowchart LR\n  Knead --> Bake\n```'],
  ] as const) {
    await newPage(page, title);
    await fillSource(page, text);
    await waitForSave(page);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  }

  // Loaded afresh, the tab keeps its vault open but nothing in memory: what
  // opens offline comes from the device. Unlocking lists every space for
  // the keeper, which holds the kept store's lock while it runs: once it
  // has been held and let go, both pages are kept as published.
  await watchKeeping(page);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-keeping', 'done', { timeout: 30_000 });
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(/^2 pages, /)).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();

  // The service worker has kept the app, so it loads offline too.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.getByRole('treeitem', { name: 'Bean soup' }).click();
  const offline = page.getByRole('status').filter({ hasText: 'Offline' });
  await expect(offline).toBeVisible();
  await expect(offline).toHaveAttribute('data-hint', /^Showing what this device kept, as of /);
  await expect(page.getByText('Beans and stock.')).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();
  await expect(page.getByText(/Published$/)).toBeVisible();

  await test.step('links between kept pages open', async () => {
    await page.getByRole('link', { name: 'Bread', exact: true }).last().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
    await expect(page.getByText('Flour and rye, baked slowly.')).toBeVisible();
  });

  await test.step('what needs the server says so', async () => {
    // Drafts are saved on this device offline, so Edit works.
    await expect(page.getByRole('button', { name: 'Edit' })).not.toHaveAttribute('aria-disabled');
    await page.getByRole('button', { name: 'Page actions' }).click();
    const move = page.getByRole('menuitem', { name: 'Move to…' });
    await expect(move).toHaveAttribute('aria-disabled', 'true');
    await expect(move).toHaveAttribute('data-hint', 'Needs the connection');
    // Pressed anyway, it does nothing.
    await move.click({ force: true });
    await expect(move).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await test.step('search finds the kept pages', async () => {
    const search = page.getByRole('dialog', { name: 'Search' });
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await search.getByRole('combobox', { name: 'Search pages' }).fill('rye');
    await expect(search.getByRole('option').locator('.font-extrabold')).toHaveText(['Bread'], {
      timeout: 30_000,
    });
    await page.keyboard.press('Escape');
  });

  await test.step('loaded again offline, the vault opens as the tab kept it', async () => {
    await page.reload();
    await expect(offline).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
    await expect(page.getByText('Flour and rye, baked slowly.')).toBeVisible();
    // Nothing drawn is kept, so the diagram is drawn again, offline.
    await expect(page.getByRole('img', { name: 'Diagram' })).toBeVisible();
  });

  await test.step('locked, it unlocks offline with the passphrase', async () => {
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Lock vault' }).click();
    await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
    await page.getByLabel('Vault passphrase').fill('not the passphrase at all');
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText(/This device last unlocked online on /)).toBeVisible();
    await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
    await expect(page.getByText('Flour and rye, baked slowly.')).toBeVisible();
    await page.getByRole('treeitem', { name: 'Bean soup' }).click();
    await expect(page.getByText('Beans and stock.')).toBeVisible();
  });

  // Told the browser is online again, the app asks the server, which answers.
  await context.setOffline(false);
  await expect(offline).toBeHidden({ timeout: 15_000 });
  // What's shown loads again: offline, the published count isn't known.
  await expect(page.getByText(/Published v1$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).not.toHaveAttribute('aria-disabled');
  // What the offline unlock skipped holds, so the vault stays open.
  await page.getByRole('treeitem', { name: 'Bread' }).click();
  await expect(page.getByText('Flour and rye, baked slowly.')).toBeVisible();
});

/**
 * The same person in a second browser, on `url`, unlocked there with the
 * passphrase (a new tab keeps no unlock).
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

/**
 * A draft edited offline is saved on this device and sent when the server
 * answers (ADR 0009, decision 7). Someone saved the draft meanwhile, from
 * another device: it comes back as the usual conflict, listed in the
 * shell, and opens with the offline text as the unsaved changes. Nothing
 * is overwritten until the person chooses Save mine on top.
 */
test('a draft edited offline that someone changed meanwhile comes back as a conflict', async ({
  page,
  context,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const { email } = await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Packing list');
  await fillSource(page, 'tent');
  await waitForSave(page);
  // Kept from its first opening; loaded afresh, the keeper keeps its draft.
  await watchKeeping(page);
  await page.reload();
  await expectSource(page, 'tent');
  await expect(page.locator('html')).toHaveAttribute('data-keeping', 'done', { timeout: 30_000 });
  const other = await sameAccountElsewhere(freshPage, email, page.url());
  await expectSource(other, 'tent');

  await context.setOffline(true);
  await fillSource(page, 'tent and stove');
  await expect(saveStatus(page)).toHaveText('Saved on this device', { timeout: 15_000 });
  const offline = page.getByRole('status').filter({ hasText: 'Offline' });
  await expect(offline).toBeVisible();
  await expect(offline).toHaveAttribute(
    'data-hint',
    /Changes are saved on this device and sent when you’re back online\.$/,
  );

  // Meanwhile, on the other device.
  await fillSource(other, 'tent and tarp');
  await waitForSave(other);

  await context.setOffline(false);
  await expect(offline).toBeHidden({ timeout: 15_000 });
  const note = page.getByRole('region', { name: 'Changes made offline' });
  await expect(note).toContainText('1 page changed while you were offline needs a choice', {
    timeout: 30_000,
  });
  // Nothing was overwritten.
  await other.reload();
  await expectSource(other, 'tent and tarp');

  // Opened from the note, the draft view shows the offline text, unsaved, with the usual choice.
  await page.goto('/');
  await note.getByRole('link', { name: 'Packing list' }).click();
  await expect(page.getByRole('alert')).toContainText('Your changes are not saved yet');
  await expectSource(page, 'tent and stove');
  await page.getByRole('button', { name: 'Save mine on top' }).click();
  await waitForSave(page);
  await expect(note).toBeHidden();
  await other.reload();
  await expectSource(other, 'tent and stove');
});
