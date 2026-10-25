import { expect, test } from './fixtures';
import { adminTab, fillSource, memberWithVault, newPage, waitForSave } from './vault';

/**
 * Pages with properties are found by `tag:` and `key:value` filters typed in
 * search, alone and with words, and a link with `?q=` opens search with its
 * query, then lets it go from the address.
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

  await test.step('a link opens search with its query', async () => {
    const url = new URL(page.url());
    url.searchParams.set('q', 'tag:winter');
    await page.goto(url.href);
    await expect(box).toHaveValue('tag:winter');
    await expect(titles).toHaveText(['Bean soup'], { timeout: 30_000 });
    await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false);
    await page.keyboard.press('Enter');
    await expect(search).toBeHidden();
    await expect(page.locator('#page-title')).toHaveValue('Bean soup');
  });
});
