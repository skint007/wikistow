import { expect, test } from './fixtures';
import { folderMenu, newFolder, newSpace } from './sharing';
import {
  adminTab,
  expectSource,
  fillSource,
  memberWithVault,
  PNG,
  sourceOf,
  waitForSave,
} from './vault';
import { download, text } from './zip';

const FRONTMATTER = '---\ntags: [network]\nlink: "[[Plan]]"\n---\n';

/**
 * An owner exports a space from its menu. The zip holds a .md file per page
 * in folders that mirror the tree, its frontmatter as written and its links
 * naming the files, and the page's attachment in attachments/.
 */
test('exporting a space as Markdown', async ({ page, freshPage, admin }) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));

  let uploaded = '';
  await test.step('the owner writes a page with links, frontmatter and an attachment', async () => {
    await newSpace(page, 'Home notes');
    await page.getByRole('button', { name: 'New page' }).first().click();
    await page.getByRole('dialog').getByLabel('Title').fill('Plan');
    await page.getByRole('button', { name: 'Create page' }).click();
    await page.locator('#page-source').fill('The plan.');
    await waitForSave(page);
    await newFolder(page, 'Network: home');
    await folderMenu(page, 'Network: home', 'New page here');
    await page.getByRole('dialog').getByLabel('Title').fill('Router');
    await page.getByRole('button', { name: 'Create page' }).click();
    await expect(page.locator('#page-title')).toHaveValue('Router');
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.getByRole('list').filter({ hasText: 'photo.png' })).toBeVisible();
    // The upload wrote its own image link, `attachment:` and the file's ID.
    await expectSource(page, /attachment:/);
    uploaded = (await sourceOf(page)).trim();
    await fillSource(
      page,
      `${FRONTMATTER}See [[plan]] and [[Nowhere]].\n\n![[photo.png]]\n\n${uploaded}\n`,
    );
    await waitForSave(page);
  });

  await test.step('it exports the space from the space menu', async () => {
    await page.getByRole('button', { name: 'Space menu' }).click();
    await page.getByRole('menuitem', { name: 'Export…' }).click();
    await expect(page.getByRole('dialog', { name: 'Export “Home notes”' })).toBeVisible();
    const { name, zip } = await download(page);

    expect(name).toBe('Home notes.zip');
    expect(Object.keys(zip).sort()).toEqual([
      'Network_ home/',
      'Network_ home/Router.md',
      'Plan.md',
      'attachments/',
      'attachments/photo.png',
    ]);
    expect(text(zip, 'Plan.md')).toBe('The plan.');
    expect(text(zip, 'Network_ home/Router.md')).toBe(
      `${FRONTMATTER}See [[Plan]] and [[Nowhere]].\n\n![[../attachments/photo.png]]\n\n${uploaded.replace(/attachment:[\w-]+/, '../attachments/photo.png')}\n`,
    );
    expect(Buffer.from(zip['attachments/photo.png'] ?? [])).toEqual(PNG);
  });
});
