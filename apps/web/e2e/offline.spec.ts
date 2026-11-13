import type { Page } from '@playwright/test';
import { expect, pick, test } from './fixtures';
import { folderMenu, newFolder } from './sharing';
import {
  adminTab,
  expectSource,
  fillSource,
  memberWithVault,
  newPage,
  PASSPHRASE,
  sameAccountElsewhere,
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
    const copy = page.getByRole('menuitem', { name: 'Copy to…' });
    await expect(copy).toHaveAttribute('aria-disabled', 'true');
    await expect(copy).toHaveAttribute('data-hint', 'Needs the connection');
    // Pressed anyway, it does nothing.
    await copy.click({ force: true });
    await expect(copy).toBeVisible();
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
 * A draft edited offline is saved on this device and sent when the server
 * answers (ADR 0009, decision 7). Someone saved the draft meanwhile, from
 * another device: it comes back as the usual conflict, listed in the
 * shell, and opens with the offline text as the unsaved changes. Nothing
 * is overwritten until the person chooses: Merge… combines the two from
 * the draft the offline edit was based on, kept on this device (ADR 0013),
 * and the change waiting here takes the merged draft and is sent.
 */
test('a draft edited offline that someone changed meanwhile comes back as a conflict, and merges', async ({
  page,
  context,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const { email } = await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Packing list');
  const base = '- tent\n- stove\n\nLeave at nine.\n';
  await fillSource(page, base);
  await waitForSave(page);
  // Kept from its first opening; loaded afresh, the keeper keeps its draft.
  await watchKeeping(page);
  await page.reload();
  await expectSource(page, base);
  await expect(page.locator('html')).toHaveAttribute('data-keeping', 'done', { timeout: 30_000 });
  const other = await sameAccountElsewhere(freshPage, email, page.url());
  await expectSource(other, base);

  await context.setOffline(true);
  const mine = '- tent\n- stove\n- matches\n\nLeave at nine.\n';
  await fillSource(page, mine);
  await expect(saveStatus(page)).toHaveText('Saved on this device', { timeout: 15_000 });
  const offline = page.getByRole('status').filter({ hasText: 'Offline' });
  await expect(offline).toBeVisible();
  await expect(offline).toHaveAttribute(
    'data-hint',
    /Changes are saved on this device and sent when you’re back online\.$/,
  );

  // Meanwhile, on the other device.
  const theirs = '- tent\n- stove\n\nLeave at ten.\n';
  await fillSource(other, theirs);
  await waitForSave(other);

  await context.setOffline(false);
  await expect(offline).toBeHidden({ timeout: 15_000 });
  const note = page.getByRole('region', { name: 'Changes made offline' });
  await expect(note).toContainText('1 page changed while you were offline needs a choice', {
    timeout: 30_000,
  });
  // Nothing was overwritten.
  await other.reload();
  await expectSource(other, theirs);

  // Opened from the note, the draft view shows the offline text, unsaved, with the usual choice.
  await page.goto('/');
  await note.getByRole('link', { name: 'Packing list' }).click();
  await expect(page.getByRole('alert')).toContainText('Your changes are not saved yet');
  await expectSource(page, mine);
  await page.getByRole('button', { name: 'Merge…' }).click();
  // Each side changed its own part, so it goes straight to the review.
  await expect(
    page.getByText('1 of your changes and 1 of your other version’s combined.'),
  ).toBeVisible();
  await expect(page.getByText('Saving makes these changes to your other version.')).toBeVisible();
  const changes = page.getByRole('list', { name: 'Changes' });
  await expect(changes.getByRole('insertion')).toHaveText([/matches/]);
  await page.getByRole('button', { name: 'Save merged draft' }).click();
  const merged = '- tent\n- stove\n- matches\n\nLeave at ten.\n';
  await expectSource(page, merged);
  await waitForSave(page);
  await expect(note).toBeHidden();
  await other.reload();
  await expectSource(other, merged);
});

/**
 * A folder renamed, and a folder and a page deleted, offline (#330): the
 * sidebar shows them so at once and after loading again offline, the
 * delete says it goes once back online, and back online they reach the
 * server, the deleted ones in the trash.
 */
test('a folder renamed and a folder and page deleted offline go once back online', async ({
  page,
  context,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newFolder(page, 'Trips');
  await newFolder(page, 'Old notes');
  await newPage(page, 'Bread');
  await fillSource(page, 'Flour and rye.');
  await waitForSave(page);
  await watchKeeping(page);
  await page.reload();
  await expectSource(page, 'Flour and rye.');
  await expect(page.locator('html')).toHaveAttribute('data-keeping', 'done', { timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);

  await context.setOffline(true);
  const tree = page.getByRole('tree');
  // The app finds it is offline on its next request.
  await tree.getByRole('treeitem', { name: /Old notes/ }).click();
  const offline = page.getByRole('status').filter({ hasText: 'Offline' });
  await expect(offline).toBeVisible();
  const waiting = 'Saved on this device, not sent yet';

  await test.step('rename a folder', async () => {
    await folderMenu(page, 'Trips', 'Rename…');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('saved on this device and sent when you’re back online');
    await dialog.getByLabel('Name').fill('Holidays');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    const renamed = tree.getByRole('treeitem', { name: /Holidays/ });
    await expect(renamed).toContainText(waiting);
    await expect(tree.getByRole('treeitem', { name: /Trips/ })).toBeHidden();
  });

  await test.step('delete a folder and a page', async () => {
    await folderMenu(page, 'Old notes', 'Delete folder');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('it goes to the trash once you’re back online');
    await dialog.getByRole('button', { name: 'Move to trash' }).click();
    await expect(tree.getByRole('treeitem', { name: /Old notes/ })).toBeHidden();

    await tree.getByRole('treeitem', { name: 'Bread' }).click();
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Delete page' }).click();
    await expect(dialog).toContainText('it goes to the trash once you’re back online');
    await dialog.getByRole('button', { name: 'Move to trash' }).click();
    await expect(tree.getByRole('treeitem', { name: 'Bread' })).toBeHidden();
  });

  await test.step('loaded again offline, they stay so', async () => {
    await page.reload();
    await expect(offline).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: /Holidays/ })).toBeVisible();
    await expect(tree.getByRole('treeitem', { name: /Old notes/ })).toBeHidden();
    await expect(tree.getByRole('treeitem', { name: 'Bread' })).toBeHidden();
  });

  await context.setOffline(false);
  await expect(offline).toBeHidden({ timeout: 15_000 });
  await expect(tree.getByRole('treeitem', { name: /Holidays/ })).not.toContainText(waiting, {
    timeout: 30_000,
  });
  await page.reload();
  await expect(tree.getByRole('treeitem', { name: /Holidays/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /Old notes/ })).toBeHidden();
  await page.getByRole('link', { name: 'Trash' }).click();
  await expect(page.getByText('Old notes')).toBeVisible();
  await expect(page.getByText('Bread')).toBeVisible();
});

/**
 * A page moved and published offline (#331): the sidebar shows it in its
 * new place at once, marked, and the page says its publish waits, which
 * can be cancelled until it is sent. Back online, both reach the server:
 * the page is in its folder, and readers see what was published.
 */
test('a page moved and published offline goes once back online', async ({
  page,
  context,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newFolder(page, 'Trips');
  await newPage(page, 'Bread');
  await fillSource(page, 'Flour and rye.');
  await waitForSave(page);
  await watchKeeping(page);
  await page.reload();
  await expectSource(page, 'Flour and rye.');
  await expect(page.locator('html')).toHaveAttribute('data-keeping', 'done', { timeout: 30_000 });
  await page.evaluate(() => navigator.serviceWorker.ready);

  await context.setOffline(true);
  const tree = page.getByRole('tree');
  // The app finds it is offline on its next request.
  await tree.getByRole('treeitem', { name: /Trips/ }).click();
  const offline = page.getByRole('status').filter({ hasText: 'Offline' });
  await expect(offline).toBeVisible();
  await tree.getByRole('treeitem', { name: 'Bread' }).click();
  const bread = tree.getByRole('treeitem', { name: /^Bread/ });

  await test.step('move it into a folder', async () => {
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Move “Bread”' });
    await pick(dialog.getByLabel('Folder'), 'Trips');
    await expect(dialog).toContainText('saved on this device and sent when you’re back online');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(bread).toHaveAttribute('aria-level', '2');
    await expect(bread).toContainText('Saved on this device, not sent yet');
  });

  await test.step('publish it, cancel, and publish again', async () => {
    // Never published, it opens as its draft.
    await expectSource(page, 'Flour and rye.');
    const publish = page.getByRole('button', { name: 'Publish', exact: true });
    const waits = page.getByText('Publish waits to be sent');
    await publish.click();
    await expect(waits).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(waits).toBeHidden();
    await publish.click();
    await expect(waits).toBeVisible();
  });

  await context.setOffline(false);
  await expect(offline).toBeHidden({ timeout: 15_000 });
  await expect(page.getByText('Publish waits to be sent')).toBeHidden({ timeout: 30_000 });
  await expect(bread).not.toContainText('Saved on this device', { timeout: 30_000 });
  // Loaded afresh, as readers see it.
  await page.goto(new URL(page.url()).pathname);
  await expect(bread).toHaveAttribute('aria-level', '2');
  await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
  await expect(page.getByText(/Published v1$/)).toBeVisible();
  await expect(page.getByText('Flour and rye.')).toBeVisible();
});
