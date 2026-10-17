import type { Page } from '@playwright/test';
import { expect, pick } from './fixtures';
import { fillSource, waitForSave } from './vault';

/** Make a space from the rail; ends on it. */
export async function newSpace(page: Page, name: string) {
  await page.getByRole('button', { name: 'New space' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create space' }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

/** Make a top-level folder from the sidebar. */
export async function newFolder(page: Page, name: string) {
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create folder' }).click();
  await expect(page.getByRole('treeitem', { name: new RegExp(name) })).toBeVisible();
}

/** Make a page in `folder` with `published` as its first publication; ends on the publication. */
export async function publishedPageIn(
  page: Page,
  folder: string,
  title: string,
  published: string,
) {
  await folderMenu(page, folder, 'New page here');
  await page.getByRole('dialog').getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create page' }).click();
  await expect(page.locator('#page-title')).toHaveValue(title);
  await page.locator('#page-source').fill(published);
  await waitForSave(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
}

/** Change the draft of the page in view, from its publication; stays on the draft. */
export async function editDraft(page: Page, text: string) {
  await page.getByRole('button', { name: 'Edit' }).click();
  await fillSource(page, text);
  await waitForSave(page);
}

/** Open `folder` in the sidebar, unless the sidebar kept it open from before. */
export async function openFolder(page: Page, folder: string) {
  const row = page.getByRole('treeitem', { name: new RegExp(folder) });
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Pick an item from a folder's menu in the sidebar. */
export async function folderMenu(page: Page, folder: string, item: string) {
  await page.getByRole('treeitem', { name: new RegExp(folder) }).hover();
  await page.getByRole('button', { name: `Actions for ${folder}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

// Each access as the access pickers name it.
const ACCESS = { reader: 'Reader', editor: 'Editor', publisher: 'Editor + publish' };

/** The Share dialog of `name`. */
export const shareDialog = (page: Page, name: string) =>
  page.getByRole('dialog', { name: `Share “${name}”` });

/**
 * Share `folder` the first time, from its menu, with the person at `email`;
 * `check` looks at the preview before it is confirmed. Ends on the access list.
 */
export async function shareFolder(
  page: Page,
  folder: string,
  email: string,
  access: 'reader' | 'editor' | 'publisher',
  check?: (dialog: ReturnType<typeof shareDialog>) => Promise<void>,
) {
  await folderMenu(page, folder, 'Share…');
  const dialog = shareDialog(page, folder);
  await dialog.getByLabel('Email').fill(email);
  await pick(dialog.getByLabel('Access'), ACCESS[access]);
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('region', { name: 'What will be shared' })).toContainText(folder);
  await check?.(dialog);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'People with access' })).toBeVisible({
    timeout: 30_000,
  });
  return dialog;
}

/** Add someone from an open Share dialog's access list. */
export async function addPerson(
  dialog: ReturnType<typeof shareDialog>,
  email: string,
  access: 'reader' | 'editor' | 'publisher',
  name: string,
) {
  const adding = dialog.getByRole('region', { name: 'Add someone' });
  await adding.getByLabel('Email').fill(email);
  await pick(adding.getByLabel('Access'), ACCESS[access]);
  await adding.getByRole('button', { name: 'Add' }).click();
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText(`${name} has access now.`);
}

/** Open a page in a folder someone shared, through Shared with me. */
export async function openShared(page: Page, folder: string, title: string) {
  await page.getByRole('link', { name: 'Shared', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(folder) }).click();
  await openFolder(page, folder);
  await page.getByRole('treeitem', { name: title }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}
