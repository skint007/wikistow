import type { Locator, Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { folderMenu, newFolder, newSpace, openFolder } from './sharing';
import { adminTab, memberWithVault } from './vault';

// A folder's own order (#400): reordering by drag, with a line between rows
// where it lands, and by Move up and Move down, then Sort by name.

const TITLES = ['Almonds', 'Apple pie', 'Bread', 'Cheese'];

/** Each tree row's name: the first line of its text, before what is only for screen readers. */
const rowNames = async (page: Page) =>
  (await page.getByRole('treeitem').allInnerTexts()).map(
    (text) => text.split('\n')[0]?.trim() ?? '',
  );

/** With E2E_SHOTS set, a screenshot for the pull request, in docs/screenshots/400. */
async function shot(page: Page, name: string) {
  if (!process.env['E2E_SHOTS']) return;
  const path = fileURLToPath(new URL(`../../../docs/screenshots/400/${name}.png`, import.meta.url));
  await page.screenshot({ path });
}

async function newPageIn(page: Page, folder: string, title: string) {
  await folderMenu(page, folder, 'New page here');
  await page.getByRole('dialog').getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create page' }).click();
  await expect(page.locator('#page-title')).toHaveValue(title);
}

/**
 * Drag `from` with the mouse onto the top or bottom edge of `to`, or its
 * middle; `meanwhile` runs before the drop, with the line showing.
 */
async function dragOnto(
  page: Page,
  from: Locator,
  to: Locator,
  where: 'top' | 'bottom' | 'middle',
  meanwhile?: () => Promise<void>,
) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('Nothing to drag');
  const y =
    where === 'top' ? b.y + 3 : where === 'bottom' ? b.y + b.height - 3 : b.y + b.height / 2;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, y, { steps: 12 });
  await meanwhile?.();
  await page.mouse.up();
}

test('pages and folders keep an order of their own, by drag and by Move up and Move down', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const adminPage = await adminTab(freshPage, admin.email);
  await memberWithVault(page, adminPage);
  await newSpace(page, 'Kitchen');
  await newFolder(page, 'Recipes');
  for (const title of ['Apple pie', 'Bread', 'Cheese']) await newPageIn(page, 'Recipes', title);
  await openFolder(page, 'Recipes');
  const row = (title: string) => page.getByRole('treeitem', { name: title });
  // The pages under Recipes, as the tree lists them.
  const titles = async () => (await rowNames(page)).filter((text) => TITLES.includes(text));
  const moved = page.getByRole('status').filter({ hasText: 'Moved “Cheese”.' });

  await test.step('a folder nobody ordered lists by name', async () => {
    await expect.poll(titles).toEqual(['Apple pie', 'Bread', 'Cheese']);
  });

  await test.step('a drop on the line above a page puts it there, with Undo', async () => {
    await dragOnto(page, row('Cheese'), row('Apple pie'), 'top', async () => {
      // A line between the rows, not a folder lit up.
      await expect(page.locator('[data-drop-line="top"]')).toHaveCount(1);
      await shot(page, 'drop-line');
    });
    await expect(moved).toBeVisible();
    await expect.poll(titles).toEqual(['Cheese', 'Apple pie', 'Bread']);
    await moved.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(titles).toEqual(['Apple pie', 'Bread', 'Cheese']);

    await dragOnto(page, row('Cheese'), row('Apple pie'), 'top');
    await expect.poll(titles).toEqual(['Cheese', 'Apple pie', 'Bread']);
  });

  await test.step('Move down from the keyboard, and Move up from the row’s ⋯ menu', async () => {
    await row('Cheese').focus();
    await page.keyboard.press('Shift+F10');
    // First already: there's nowhere up to go.
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toHaveCount(0);
    await shot(page, 'row-menu');
    await page.getByRole('menuitem', { name: 'Move down' }).click();
    await expect.poll(titles).toEqual(['Apple pie', 'Cheese', 'Bread']);

    await row('Cheese').hover();
    await page.getByRole('button', { name: 'Actions for Cheese' }).click();
    await page.getByRole('menuitem', { name: 'Move up' }).click();
    await expect.poll(titles).toEqual(['Cheese', 'Apple pie', 'Bread']);
  });

  await test.step('the order is the folder’s: it stays, and something new goes last', async () => {
    await page.reload();
    await openFolder(page, 'Recipes');
    await expect.poll(titles).toEqual(['Cheese', 'Apple pie', 'Bread']);
    await newPageIn(page, 'Recipes', 'Almonds');
    await expect.poll(titles).toEqual(['Cheese', 'Apple pie', 'Bread', 'Almonds']);
  });

  await test.step('Sort by name lists it by name again', async () => {
    await folderMenu(page, 'Recipes', 'Sort by name');
    await expect(page.getByRole('status').filter({ hasText: 'by name.' })).toBeVisible();
    await expect.poll(titles).toEqual(['Almonds', 'Apple pie', 'Bread', 'Cheese']);
    await shot(page, 'sorted-by-name');
  });
});

test('a drop on a line in another folder moves it there, where it was dropped', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const adminPage = await adminTab(freshPage, admin.email);
  await memberWithVault(page, adminPage);
  await newSpace(page, 'Pantry');
  await newFolder(page, 'Shelf');
  await newFolder(page, 'Cupboard');
  for (const title of ['Apple pie', 'Cheese']) await newPageIn(page, 'Shelf', title);
  await newPageIn(page, 'Cupboard', 'Bread');
  await openFolder(page, 'Shelf');
  await openFolder(page, 'Cupboard');
  const row = (title: string) => page.getByRole('treeitem', { name: title });
  const shelf = async () => {
    const rows = await rowNames(page);
    // A folder's row starts with its emoji.
    const texts = await page.getByRole('treeitem').allInnerTexts();
    const at = texts.findIndex((text) => text.includes('Shelf'));
    const end = rows.findIndex((text, i) => i > at && !TITLES.includes(text));
    return rows.slice(at + 1, end < 0 ? undefined : end);
  };

  await expect.poll(shelf).toEqual(['Apple pie', 'Cheese']);
  // Bread, in Cupboard, onto the line between Apple pie and Cheese in Shelf.
  await dragOnto(page, row('Bread'), row('Cheese'), 'top');
  await expect(
    page.getByRole('status').filter({ hasText: 'Moved “Bread” to Shelf.' }),
  ).toBeVisible();
  await expect.poll(shelf).toEqual(['Apple pie', 'Bread', 'Cheese']);

  // Below the rows, Cupboard goes last at the top, after Shelf, which is open.
  const folderAt = async (name: string) =>
    (await page.getByRole('treeitem').allInnerTexts()).findIndex((text) => text.includes(name));
  expect(await folderAt('Cupboard')).toBeLessThan(await folderAt('Shelf'));
  await dragOnto(
    page,
    page.getByRole('treeitem', { name: /Cupboard/ }),
    page.getByRole('tree').locator('li[aria-hidden]').last(),
    'middle',
  );
  await expect
    .poll(async () => (await folderAt('Cupboard')) > (await folderAt('Shelf')))
    .toBe(true);
});
