import { expect, pick, test } from './fixtures';
import {
  addPerson,
  editDraft,
  newFolder,
  newSpace,
  openShared,
  publishedPageIn,
  shareDialog,
  shareFolder,
} from './sharing';
import { adminTab, expectSource, memberWithVault, waitForSave } from './vault';

const TEXT = {
  published: 'Plant the beans after the last frost.',
  draft: 'Plant the beans after the last frost. Maybe tomatoes too?',
  edited: 'Beans in May, tomatoes in June.',
  diary: 'Nobody else reads this diary.',
};

/**
 * Three people in their own browsers. The owner shares one folder of a
 * space with an editor and a reader, and keeps another to themself.
 */
test('a shared folder: readers see publications, editors drafts, and removal takes access away', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const editor = await freshPage();
  const reader = await freshPage();
  await memberWithVault(owner, adminPage, 'Olive Owner');
  const { email: editorEmail } = await memberWithVault(editor, adminPage, 'Eddie Editor');
  const { email: readerEmail } = await memberWithVault(reader, adminPage, 'Rita Reader');

  await test.step('the owner keeps one folder private and shares another', async () => {
    await newSpace(owner, 'Family');
    await newFolder(owner, 'Private');
    await owner.getByRole('treeitem', { name: /Private/ }).hover();
    await owner.getByRole('button', { name: 'Actions for Private' }).click();
    await owner.getByRole('menuitem', { name: 'New page here' }).click();
    await owner.getByRole('dialog').getByLabel('Title').fill('Diary');
    await owner.getByRole('button', { name: 'Create page' }).click();
    await owner.locator('#page-source').fill(TEXT.diary);
    await waitForSave(owner);
    await newFolder(owner, 'Garden');
    await publishedPageIn(owner, 'Garden', 'Planting plan', TEXT.published);
    await editDraft(owner, TEXT.draft);
    await owner.getByRole('button', { name: 'Done' }).click();

    const dialog = await shareFolder(owner, 'Garden', editorEmail, 'editor', async (preview) => {
      const shared = preview.getByRole('region', { name: 'What will be shared' });
      await expect(shared).toContainText('Planting plan');
      // Nothing outside the folder, and nothing above it.
      await expect(shared).not.toContainText('Private');
      await expect(shared).not.toContainText('Diary');
    });
    await addPerson(dialog, readerEmail, 'reader', 'Rita Reader');
    await expect(dialog.getByLabel('Access for Eddie Editor')).toHaveText('Editor');
    await expect(dialog.getByLabel('Access for Rita Reader')).toHaveText('Reader');
    await owner.keyboard.press('Escape');
  });

  await test.step('Shared with me lists only the shared folder, by its own name', async () => {
    await reader.getByRole('link', { name: 'Shared', exact: true }).click();
    const item = reader.getByRole('link', { name: /Garden/ });
    await expect(item).toBeVisible();
    await expect(reader.locator('body')).not.toContainText('Family');
    await item.click();
    // The tree starts at the shared folder: no space name, no other folder.
    await expect(reader.getByRole('heading', { name: 'Shared with you', level: 2 })).toBeVisible();
    await expect(reader.getByRole('treeitem', { name: /Private/ })).toHaveCount(0);
  });

  await test.step('the reader sees the publication only, with no draft controls', async () => {
    await reader.getByRole('treeitem', { name: /Garden/ }).click();
    await reader.getByRole('treeitem', { name: 'Planting plan' }).click();
    await expect(reader.getByText(TEXT.published)).toBeVisible();
    await expect(reader.getByText(TEXT.draft)).toHaveCount(0);
    await expect(reader.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: /Draft/ })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  });

  await test.step('the editor edits the draft, but can’t publish', async () => {
    await openShared(editor, 'Garden', 'Planting plan');
    await editor.getByRole('button', { name: /Draft has changes/ }).click();
    await expectSource(editor, TEXT.draft);
    await editor.locator('#page-source').fill(TEXT.edited);
    await waitForSave(editor);
    await expect(editor.getByRole('button', { name: 'Publish', exact: true })).toHaveCount(0);
  });

  await test.step('with publish rights, the editor publishes and the reader sees it', async () => {
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = shareDialog(owner, 'Garden');
    await pick(dialog.getByLabel('Access for Eddie Editor'), 'Editor + publish');
    await expect(dialog.getByRole('status')).toHaveText('Eddie Editor can now publish.');
    await owner.keyboard.press('Escape');

    await editor.getByRole('button', { name: 'Done' }).click();
    await openShared(editor, 'Garden', 'Planting plan');
    await editor.getByRole('button', { name: 'Edit' }).click();
    await editor.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(editor.getByText('Published v2')).toBeVisible();

    await openShared(reader, 'Garden', 'Planting plan');
    await expect(reader.getByText(TEXT.edited)).toBeVisible();
  });

  await test.step('removing the reader rotates the keys and takes their access away', async () => {
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = shareDialog(owner, 'Garden');
    await dialog.getByRole('button', { name: 'More for Rita Reader' }).click();
    await owner.getByRole('menuitem', { name: 'Remove from this folder' }).click();
    await expect(dialog.getByRole('heading', { name: /Remove Rita Reader/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(dialog.getByRole('status')).toHaveText('Done. The folder has new keys.');
    await expect(dialog.getByLabel('Access for Rita Reader')).toHaveCount(0);
    await owner.keyboard.press('Escape');

    await reader.getByRole('link', { name: 'Shared', exact: true }).click();
    await expect(reader.getByText('Nothing has been shared with you yet.')).toBeVisible();
    await reader.goBack();
    await expect(reader.getByText(TEXT.edited)).toHaveCount(0);
  });
});
