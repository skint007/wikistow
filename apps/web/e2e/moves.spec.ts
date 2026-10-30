import type { Page } from '@playwright/test';
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
    await dialog.getByRole('button', { name: 'Next' }).click();
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
