import { expect, test } from './fixtures';
import { adminTab, fillSource, memberWithVault, newPage, PASSPHRASE, waitForSave } from './vault';

/**
 * Pages with properties are found by `tag:` and `key:value` filters typed in
 * search, alone and with words, and an address with `#search=` opens search
 * with its query on its page, then lets it go.
 */
test('search finds pages by tag and property, typed or from a link', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Bean soup');
  await fillSource(page, '---\ntags: [soup, winter]\nstatus: in progress\n---\nBeans and stock.');
  await waitForSave(page);
  await newPage(page, 'Bread');
  await fillSource(page, '---\ntags: bread\n---\nFlour and stock.');
  await waitForSave(page);

  const search = page.getByRole('dialog', { name: 'Search' });
  const box = search.getByRole('combobox', { name: 'Search pages' });
  const titles = search.getByRole('option').locator('.font-extrabold');

  await test.step('filters typed in search, alone and with words', async () => {
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(search.getByRole('status')).toContainText('Filter by tag:soup', {
      timeout: 30_000,
    });
    await box.fill('tag:soup');
    await expect(titles).toHaveText(['Bean soup']);
    await box.fill('stock status:"in progress"');
    await expect(titles).toHaveText(['Bean soup']);
    await box.fill('stock tag:bread');
    await expect(titles).toHaveText(['Bread']);
    await box.fill('stock');
    await expect(titles).toHaveText(['Bean soup', 'Bread']);
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
  });

  await test.step('a link opens search with its query, on its page', async () => {
    const url = new URL(page.url());
    url.hash = `search=${encodeURIComponent('tag:winter')}`;
    // Loaded afresh, as in a new tab: the tab stays unlocked.
    await page.goto('about:blank');
    await page.goto(url.href);
    await expect(box).toHaveValue('tag:winter');
    await expect(titles).toHaveText(['Bean soup'], { timeout: 30_000 });
    // The query leaves the address, which stays on the page it was.
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    expect(new URL(page.url()).pathname).toBe(url.pathname);
    await expect(page.locator('#page-title')).toHaveValue('Bread');
    await page.keyboard.press('Enter');
    await expect(search).toBeHidden();
    await expect(page.locator('#page-title')).toHaveValue('Bean soup');
  });

  await test.step('a link opened while locked opens search after unlocking', async () => {
    const url = new URL(page.url());
    url.hash = `search=${encodeURIComponent('status:"in progress"')}`;
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Lock vault' }).click();
    await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
    await page.goto('about:blank');
    await page.goto(url.href);
    await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
    // The page to return to is in the address, the query isn't.
    expect(decodeURIComponent(page.url())).not.toContain('in progress');
    await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(box).toHaveValue('status:"in progress"');
    await expect(titles).toHaveText(['Bean soup'], { timeout: 30_000 });
  });
});

/**
 * Ctrl+Shift+P and F1 open search as the command palette, with `>` typed,
 * from the source editor, which keeps neither key. It lists the commands of
 * the view shown, runs one with Enter, and Escape gives the focus back.
 */
test('the command palette runs what the page offers', async ({ page, freshPage, admin }) => {
  test.setTimeout(120_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Bean soup');
  await fillSource(page, 'Beans and stock.');
  await waitForSave(page);

  const search = page.getByRole('dialog', { name: 'Search' });
  const box = search.getByRole('combobox', { name: 'Run a command' });
  const titles = search.getByRole('option');
  const source = page.locator('#page-source');

  await test.step('on a draft: its own commands, and Escape returns to the editor', async () => {
    await source.focus();
    await page.keyboard.press('Control+Shift+P');
    await expect(box).toHaveValue('>');
    await expect(titles.filter({ hasText: 'Change banner' })).toHaveCount(1);
    await expect(titles.filter({ hasText: 'Lock vault' })).toHaveCount(1);
    // Never published, it has nothing to be done with yet.
    await expect(titles.filter({ hasText: /^(Edit page|Done editing)$/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();
    await expect(source).toBeFocused();
  });

  await test.step('F1, then Enter runs the best match', async () => {
    await page.keyboard.press('F1');
    await expect(box).toHaveValue('>');
    await page.keyboard.type('publish');
    await expect(titles.first()).toHaveText('Publish');
    await page.keyboard.press('Enter');
    await expect(search).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  });

  await test.step('on the publication, Edit page; on the draft, Done editing', async () => {
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('edit');
    await expect(titles.first()).toHaveText('Edit page');
    await page.keyboard.press('Enter');
    await expect(page.locator('#page-source')).toBeVisible();
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('done');
    await expect(titles.first()).toHaveText('Done editing');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  });
});
