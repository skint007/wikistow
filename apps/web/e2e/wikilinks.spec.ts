import { expect, test } from './fixtures';
import {
  folderMenu,
  newFolder,
  newSpace,
  openShared,
  publishedPageIn,
  shareFolder,
} from './sharing';
import { adminTab, fillSource, memberWithVault, PNG, waitForSave } from './vault';

const NOTES = `## This spring

See [[seeds#Sowing dates|when to sow]].

![[bed.png]]
`;

// Long enough that its second heading starts below the fold.
const SEEDS = `${'Sow thinly, and water well.\n\n'.repeat(30)}## Sowing dates\n\nMarch, under glass.`;

/**
 * An owner publishes notes with a wikilink to a heading and an attachment
 * embed, in a folder a reader can read. The reader sees the embed and
 * follows the link to the page and its heading.
 */
test('a reader follows a wikilink to its heading, and sees an embed', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const rita = await freshPage();
  await memberWithVault(owner, adminPage);
  const { email: ritaEmail } = await memberWithVault(rita, adminPage);

  await test.step('the owner writes pages in a shared folder', async () => {
    await newSpace(owner, 'Garden');
    await newFolder(owner, 'Plans');
    await shareFolder(owner, 'Plans', ritaEmail, 'reader');
    await owner.keyboard.press('Escape');
    await publishedPageIn(owner, 'Plans', 'Seeds', SEEDS);

    await folderMenu(owner, 'Plans', 'New page here');
    await owner.getByRole('dialog').getByLabel('Title').fill('Garden notes');
    await owner.getByRole('button', { name: 'Create page' }).click();
    await expect(owner.locator('#page-title')).toHaveValue('Garden notes');
    await owner
      .locator('input[type=file]')
      .setInputFiles({ name: 'bed.png', mimeType: 'image/png', buffer: PNG });
    await expect(owner.getByRole('list').filter({ hasText: 'bed.png' })).toBeVisible();
    // The embed names the file; the upload's own Markdown link goes.
    await fillSource(owner, NOTES);
    await waitForSave(owner);
    await owner.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(owner.getByText('Published v1')).toBeVisible();
  });

  await test.step('the reader sees the embed, and follows the link to its heading', async () => {
    await openShared(rita, 'Plans', 'Garden notes');
    await expect(rita.getByRole('img', { name: 'bed.png' })).toBeVisible();

    await rita.getByRole('link', { name: 'when to sow' }).click();
    await expect(rita.getByRole('heading', { name: 'Seeds', level: 1 })).toBeVisible();
    await expect(rita).toHaveURL(/#heading-sowing-dates$/);
    await expect(rita.locator('#heading-sowing-dates')).toBeInViewport();
  });
});
