import { expect, test } from './fixtures';
import { newSpace } from './sharing';
import { adminTab, memberWithVault, newPage } from './vault';

/**
 * On a phone, the drawer holds the rail and the open space's sidebar.
 * Picking a space there opens its sidebar in the drawer, which stays open
 * so a page in it can be picked, with no filter typed in the space before;
 * picking that page closes it (#694).
 */
test('on a phone, picking a space keeps the drawer open for its pages', async ({
  page,
  freshPage,
  admin,
}) => {
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newSpace(page, 'Garden');
  await newPage(page, 'Seed list');
  await newSpace(page, 'Kitchen');
  await newPage(page, 'Bean soup');

  await page.setViewportSize({ width: 390, height: 700 });
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(drawer.getByRole('heading', { name: 'Kitchen', level: 2 })).toBeVisible();
  // A filter typed in one space's sidebar doesn't carry over to the next.
  await drawer.getByRole('textbox', { name: 'Filter pages' }).fill('Bean');

  await drawer.getByRole('link', { name: 'Garden', exact: true }).click();
  await expect(drawer.getByRole('heading', { name: 'Garden', level: 2 })).toBeVisible();
  await expect(page).toHaveURL(/\/s\/[^/]+\/?$/);
  // Still open once the space has opened behind it.
  await expect(drawer.getByRole('treeitem', { name: 'Seed list' })).toBeVisible();

  await drawer.getByRole('treeitem', { name: 'Seed list' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('#page-title')).toHaveValue('Seed list');

  // Going back to where the tap went is a move of its own, which closes it.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/s\/[^/]+\/?$/);
  await expect(drawer).toBeHidden();
  await page.goForward();
  await expect(page.locator('#page-title')).toHaveValue('Seed list');

  // Its own space's tile, from a page in it, keeps it open too; Trash closes it.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await drawer.getByRole('link', { name: 'Garden', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+\/?$/);
  await expect(drawer.getByRole('treeitem', { name: 'Seed list' })).toBeVisible();
  await drawer.getByRole('link', { name: 'Trash' }).click();
  await expect(drawer).toBeHidden();
});
