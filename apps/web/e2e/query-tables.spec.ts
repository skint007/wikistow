import { showIn, visual } from './editor';
import { expect, test } from './fixtures';
import { newFolder, publishedPageIn } from './sharing';
import { adminTab, memberWithVault, sameAccountElsewhere, setProperty, waitForSave } from './vault';

const recipe = (servings: number) => `---\nservings: ${servings}\n---\nA recipe.\n`;

/** A menu that is a recipe too, listing the recipes by how many they serve. */
const menu = (servings: number) =>
  `---\nservings: ${servings}\n---\n` +
  '```wikistow-query\nfrom: Recipes\nshow: servings\nsort: servings desc\n```\n';

/**
 * A query table follows the person's search index, so a listed page's
 * change shows without a reload (#408): one saved here, in the draft
 * the table is on, and one saved on another device.
 */
test('a query table follows a listed page’s change without a reload', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  const { email } = await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newFolder(page, 'Recipes');
  await publishedPageIn(page, 'Recipes', 'Bread', recipe(4));
  const bread = page.url();
  await publishedPageIn(page, 'Recipes', 'Menu', menu(1));
  await expect(page.locator('figure.query-table tbody tr')).toHaveText(['Bread4', 'Menu1']);

  const rows = visual(page).locator('figure.query-table tbody tr');
  await test.step('a draft saved here', async () => {
    await page.getByRole('button', { name: 'Edit' }).click();
    await showIn(page, 'Split');
    await setProperty(page, 'Servings', '9');
    await waitForSave(page);
    await expect(rows).toHaveText(['Menu9', 'Bread4'], { timeout: 15_000 });
  });

  await test.step('a draft saved on another device', async () => {
    const other = await sameAccountElsewhere(freshPage, email, bread);
    await other.getByRole('button', { name: 'Edit' }).click();
    await setProperty(other, 'Servings', '12');
    await waitForSave(other);
    await expect(rows).toHaveText(['Bread12', 'Menu9'], { timeout: 15_000 });
  });
});
