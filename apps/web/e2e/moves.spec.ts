import type { Locator, Page } from '@playwright/test';
import { expect, pick, test } from './fixtures';
import {
  folderMenu,
  newFolder,
  newSpace,
  openFolder,
  publishedPageIn,
  shareFolder,
} from './sharing';
import { adminTab, memberWithVault } from './vault';

const TEXT = {
  beans: 'Soak the beans overnight.',
  watering: 'Water the beds every other evening.',
};

/** Open the folders someone shared with `page`, and the tree of the one named `folder`. */
async function sharedTree(page: Page, folder: string) {
  await page.getByRole('link', { name: 'Shared', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(folder) }).click();
  await openFolder(page, folder);
}

/**
 * An owner shares two folders with one reader each, and moves a folder from
 * one share to the other: its new reader reads it, and its old one loses it.
 */
test('moving a folder between shares changes who can read it', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const rita = await freshPage();
  const kim = await freshPage();
  await memberWithVault(owner, adminPage);
  const { email: ritaEmail } = await memberWithVault(rita, adminPage);
  const { email: kimEmail } = await memberWithVault(kim, adminPage);

  await test.step('the owner shares Garden with Rita and Kitchen with Kim', async () => {
    await newSpace(owner, 'Family');
    await newFolder(owner, 'Garden');
    await newFolder(owner, 'Kitchen');
    await folderMenu(owner, 'Garden', 'New folder here');
    await owner.getByRole('dialog').getByLabel('Name').fill('Beans');
    await owner.getByRole('button', { name: 'Create folder' }).click();
    await publishedPageIn(owner, 'Beans', 'Bean plan', TEXT.beans);
    await publishedPageIn(owner, 'Garden', 'Watering', TEXT.watering);
    await shareFolder(owner, 'Garden', ritaEmail, 'reader');
    await owner.keyboard.press('Escape');
    await shareFolder(owner, 'Kitchen', kimEmail, 'reader');
    await owner.keyboard.press('Escape');
  });

  await test.step('the owner moves Beans from Garden to Kitchen', async () => {
    await folderMenu(owner, 'Beans', 'Move to…');
    const dialog = owner.getByRole('dialog', { name: 'Move “Beans”' });
    await pick(dialog.getByLabel('Folder'), 'Kitchen');
    // One step: Kim gains it, which the dialog says under the place (#376).
    await expect(dialog).toContainText('Members of “Kitchen” will be able to read it.');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });

  await test.step('Kim reads the moved page, and Rita no longer sees it', async () => {
    await sharedTree(kim, 'Kitchen');
    await openFolder(kim, 'Beans');
    await kim.getByRole('treeitem', { name: 'Bean plan' }).click();
    await expect(kim.getByText(TEXT.beans)).toBeVisible();

    await sharedTree(rita, 'Garden');
    await expect(rita.getByRole('treeitem', { name: 'Watering' })).toBeVisible();
    await expect(rita.getByRole('treeitem', { name: /Beans/ })).toHaveCount(0);
  });
});

/** Drag `from` onto `to` with the mouse, holding Ctrl while `copy`. */
async function drop(page: Page, from: Locator, to: Locator, copy = false) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('Nothing to drag');
  if (copy) await page.keyboard.down('Control');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  if (copy) await page.keyboard.up('Control');
}

/**
 * A drag moves at once and Ctrl+drag copies, with no dialog, and so does a
 * drop on another space in the rail, and the notice's Undo takes each back,
 * the move into another space by moving it back (#376).
 */
test('a drag moves and Ctrl+drag copies at once, each with Undo', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const adminPage = await adminTab(freshPage, admin.email);
  await memberWithVault(owner, adminPage);
  await newSpace(owner, 'Work');
  await newSpace(owner, 'Family');
  await newFolder(owner, 'Garden');
  await newFolder(owner, 'Kitchen');
  await publishedPageIn(owner, 'Garden', 'Beans', TEXT.beans);
  await openFolder(owner, 'Kitchen');
  const beans = owner.getByRole('treeitem', { name: 'Beans' });
  const kitchen = owner.getByRole('treeitem', { name: /Kitchen/ });
  const notice = owner.getByRole('status').filter({ hasText: '“Beans” to Kitchen.' });

  // The tree is flat: Beans shows under the folder it is in.
  const under = async () => {
    const rows = await owner.getByRole('treeitem').allInnerTexts();
    const at = rows.findIndex((row) => row.trim() === 'Beans');
    return rows[at - 1]?.includes('Kitchen') ? 'Kitchen' : 'Garden';
  };

  await drop(owner, beans, kitchen);
  await expect(notice).toContainText('Moved “Beans” to Kitchen.');
  await expect(owner.getByRole('dialog')).toHaveCount(0);
  await expect.poll(under).toBe('Kitchen');
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(under).toBe('Garden');

  await drop(owner, beans, kitchen, true);
  await expect(notice).toContainText('Copied “Beans” to Kitchen.', { timeout: 30_000 });
  await expect(beans).toHaveCount(2);
  await notice.getByRole('button', { name: 'Undo' }).click();
  await expect(notice).toHaveCount(0, { timeout: 30_000 });
  await expect(beans).toHaveCount(1);

  const work = owner.getByRole('status').filter({ hasText: 'Moved “Beans” to Work.' });
  await drop(owner, beans, owner.getByRole('link', { name: 'Work', exact: true }));
  await expect(work).toContainText('Its earlier versions don’t go with it.', { timeout: 30_000 });
  await expect(beans).toHaveCount(0);
  await work.getByRole('button', { name: 'Undo' }).click();
  await expect(work).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(under).toBe('Garden');
});
