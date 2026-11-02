import { expect, test } from './fixtures';
import { adminTab, fillSource, memberWithVault, newPage, waitForSave } from './vault';

/**
 * Pages opened on this browser stay readable when the server stops
 * answering (ADR 0009, decisions 4, 8 and 9): the app says it is offline,
 * opens the kept pages and follows links between them, searches them, and
 * says "Needs the connection" on what waits for the server. Back online,
 * it says so once the server answers. The vault was unlocked online:
 * unlocking offline is a later step.
 */
test('pages opened here read and search offline', async ({ page, context, freshPage, admin }) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  for (const [title, text] of [
    ['Bean soup', 'Beans and stock. Serve with [[Bread]].'],
    ['Bread', 'Flour and rye, baked slowly.'],
  ] as const) {
    await newPage(page, title);
    await fillSource(page, text);
    await waitForSave(page);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  }

  // Both are kept once the keeper has followed the last publication: it
  // starts soon after the server tells of it, and holds the kept store's
  // lock while it runs.
  await page.waitForTimeout(1_000);
  await expect
    .poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.length ?? 0))
    .toBe(0);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByText(/^2 pages, /)).toBeVisible({ timeout: 30_000 });
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
  // Loaded afresh, the tab keeps its vault open but nothing in memory: what
  // opens offline comes from the device.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('treeitem', { name: 'Bean soup' }).click();
  const offline = page.getByRole('status').filter({ hasText: 'Offline' });
  await expect(offline).toBeVisible();
  await expect(offline).toHaveAttribute('data-hint', /^Showing what this device kept, as of /);
  await expect(page.getByText('Beans and stock.')).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();

  await test.step('links between kept pages open', async () => {
    await page.getByRole('link', { name: 'Bread', exact: true }).last().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
    await expect(page.getByText('Flour and rye, baked slowly.')).toBeVisible();
  });

  await test.step('what needs the server says so', async () => {
    const edit = page.getByRole('button', { name: 'Edit' });
    await expect(edit).toHaveAttribute('aria-disabled', 'true');
    await expect(edit).toHaveAttribute('data-hint', 'Needs the connection');
    // Pressed anyway, it does nothing.
    await edit.click({ force: true });
    await expect(page.getByRole('heading', { level: 1, name: 'Bread' })).toBeVisible();
    await page.getByRole('button', { name: 'Page actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Move to…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
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

  // Told the browser is online again, the app asks the server, which answers.
  await context.setOffline(false);
  await expect(offline).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Edit' })).not.toHaveAttribute('aria-disabled');
});
