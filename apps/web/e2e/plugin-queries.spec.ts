import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, pick, test } from './fixtures';
import { newFolder, publishedPageIn } from './sharing';
import { adminTab, memberWithVault, sameAccountElsewhere, setProperty, waitForSave } from './vault';

const BUILD = fileURLToPath(new URL('../../../packages/plugin-sdk/src/build.ts', import.meta.url));
const VAULT_TABLES = fileURLToPath(
  new URL('../../../examples/plugins/vault-tables', import.meta.url),
);

const recipe = (servings: number) => `---\nservings: ${servings}\n---\nA recipe.\n`;

/** A menu that is a recipe too, listing the recipes as Dataview would. */
const menu = (servings: number) =>
  `---\nservings: ${servings}\n---\n` +
  '```dataview\nTABLE servings AS "Serves"\nSORT servings DESC\n```\n';

/**
 * A plugin querying pages by their properties (#401), through the
 * `vault-tables` example: it claims ```dataview fences, lists the pages of
 * the folder it was given with `host.pages.query`, and lists them again
 * when told the index changed, as after a page saved on another device.
 */
test('a plugin draws a dataview block from the pages it can read', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  execFileSync(process.execPath, [BUILD, 'build', VAULT_TABLES], { stdio: 'inherit' });
  const { email } = await memberWithVault(page, await adminTab(freshPage, admin.email));
  const space = page.url();
  await newFolder(page, 'Recipes');
  await newFolder(page, 'Diary');
  await publishedPageIn(page, 'Recipes', 'Bread', recipe(4));
  const bread = page.url();
  await publishedPageIn(page, 'Recipes', 'Soup', recipe(6));
  // Outside what the plugin is given.
  await publishedPageIn(page, 'Diary', 'Secret', recipe(9));

  await test.step('installed, it says which code blocks it draws', async () => {
    await page.goto('/settings/plugins?tab=library');
    await page.getByLabel('Plugin folder').setInputFiles(`${VAULT_TABLES}/dist`);
    const approval = page.getByRole('dialog');
    await expect(approval).toContainText(
      'It draws dataview code blocks as its own, on every page you open, whoever wrote them.',
    );
    // Only me: the library is the server's, and other tests list it.
    await pick(approval.getByRole('button', { name: /^Who sees it/ }), 'Only me');
    await approval.getByRole('button', { name: 'Upload' }).click();
    await expect(page.getByText('Uploaded and installed Vault tables 0.1.0.')).toBeVisible({
      timeout: 15_000,
    });
    await page
      .getByRole('navigation', { name: 'Plugins' })
      .getByRole('link', { name: 'Installed' })
      .click();
    await expect(page.getByRole('region', { name: 'Code blocks plugins draw' })).toContainText(
      'dataview blocks: Vault tables draws them.',
    );
    const installed = page
      .getByRole('list', { name: 'Installed plugins' })
      .getByRole('listitem', { name: 'Vault tables' });
    await installed.getByRole('button', { name: /^Where/ }).click();
    await page
      .getByRole('menuitemradio', { name: /Recipes/ })
      .first()
      .click();
    await installed.getByRole('button', { name: 'Add' }).click();
    await expect(installed.getByRole('list', { name: 'Page access' })).toContainText('read');
  });

  const plugin = page.locator('[data-plugin-block="query"] table');
  await test.step('a dataview block lists the pages it can read', async () => {
    await page.goto(space);
    await publishedPageIn(page, 'Recipes', 'Menu', menu(1));
    await expect(plugin.getByRole('columnheader')).toHaveText(['Page', 'Serves']);
    // The whole space, as far as it can read: not the diary.
    await expect(plugin.locator('tbody tr')).toHaveText(['Soup6', 'Bread4', 'Menu1']);
  });

  await test.step('it follows a listed page’s change without a reload', async () => {
    const other = await sameAccountElsewhere(freshPage, email, bread);
    await other.getByRole('button', { name: 'Edit' }).click();
    await setProperty(other, 'Servings', '8');
    await waitForSave(other);
    await expect(plugin.locator('tbody tr')).toHaveText(['Bread8', 'Soup6', 'Menu1'], {
      timeout: 15_000,
    });
  });
});
