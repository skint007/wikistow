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
  page: 'Bake at 180 °C for 45 minutes.',
  question: 'Fan oven or not?',
  answer: 'Fan: 170 °C.',
  note: 'Shall we add the vegetarian one?',
};

/** The page's comments panel, opened from its toolbar. */
async function openComments(page: Page) {
  await page.getByRole('button', { name: /^Comments/ }).click();
  const panel = page.getByRole('complementary', { name: 'Comments' });
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Write in a comment box inside `within` by what it says it is for, send it
 * with the keyboard, and wait for the comment to show there.
 */
async function send(within: Locator, box: string, text: string) {
  const field = within.getByRole('textbox', { name: box });
  await field.fill(text);
  await field.press('ControlOrMeta+Enter');
  await expect(within.locator('.comment-text', { hasText: text })).toBeVisible();
}

/**
 * Two people in their own browsers (ADR 0014, step 3). A reader asks a
 * question on a page shared with them, the owner answers it from the draft
 * view and leaves a note for editors, and the reader sees the answer but
 * never the note. Then the folder moves out of its share, and the owner
 * still reads every comment.
 */
test('a reader asks, an editor answers from the draft, and comments follow a move', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const reader = await freshPage();
  await memberWithVault(owner, adminPage, 'Cora Cook');
  const { email: readerEmail } = await memberWithVault(reader, adminPage, 'Rex Reader');

  await test.step('the owner shares a folder holding a published page', async () => {
    await newSpace(owner, 'Kitchen');
    await newFolder(owner, 'Recipes');
    await folderMenu(owner, 'Recipes', 'New folder here');
    await owner.getByRole('dialog').getByLabel('Name').fill('Mains');
    await owner.getByRole('button', { name: 'Create folder' }).click();
    await publishedPageIn(owner, 'Mains', 'Lasagne', TEXT.page);
    await shareFolder(owner, 'Recipes', readerEmail, 'reader');
    await owner.keyboard.press('Escape');
  });

  await test.step('the reader asks a question for everyone who reads the page', async () => {
    await reader.getByRole('link', { name: 'Shared', exact: true }).click();
    await reader.getByRole('link', { name: /Recipes/ }).click();
    await openFolder(reader, 'Recipes');
    await openFolder(reader, 'Mains');
    await reader.getByRole('treeitem', { name: 'Lasagne' }).click();
    await expect(reader.getByText(TEXT.page)).toBeVisible();
    const panel = await openComments(reader);
    // A reader has no draft view, so no box for editors.
    await expect(panel.getByRole('textbox', { name: 'Comment for editors' })).toHaveCount(0);
    await send(panel, 'Comment for everyone who reads this page', TEXT.question);
    const thread = panel.getByRole('article', { name: 'Thread' });
    await expect(thread).toContainText(TEXT.question);
    await expect(thread).toContainText('You');
    // Open, the panel marks what arrives seen; closed, the answer waits as new.
    await panel.getByRole('button', { name: 'Close comments' }).click();
    await expect(panel).toBeHidden();
  });

  await test.step('the owner answers from the draft view, and adds a note for editors', async () => {
    await openFolder(owner, 'Mains');
    await owner.getByRole('treeitem', { name: 'Lasagne' }).click();
    await owner.getByRole('button', { name: 'Edit' }).click();
    const panel = await openComments(owner);
    const asked = panel.getByRole('article', { name: 'Thread' }).filter({ hasText: TEXT.question });
    // Its audience isn't the draft view's, so it says so.
    await expect(asked.getByText('Readers', { exact: true })).toBeVisible();
    await expect(asked).toContainText('Rex Reader');
    await asked.getByRole('button', { name: 'Reply…' }).click();
    await send(asked, 'Reply for everyone who reads this page', TEXT.answer);
    await expect(asked).toContainText(TEXT.answer);
    await send(panel, 'Comment for editors', TEXT.note);
    await expect(panel.getByRole('article', { name: 'Thread' })).toHaveCount(2);
  });

  await test.step('the reader finds the answer in New comments, and never sees the note', async () => {
    // An unsent comment and the open panel are kept in memory only.
    await reader.reload();
    await reader.getByRole('link', { name: 'Comments, new' }).click();
    await expect(reader.getByRole('heading', { name: 'New comments' })).toBeVisible();
    const row = reader.getByRole('link', { name: /Lasagne/ });
    await expect(row).toContainText(TEXT.answer);
    await expect(reader.locator('body')).not.toContainText(TEXT.note);
    // It opens the page with its thread, which marks the page's comments seen.
    await row.click();
    const panel = reader.getByRole('complementary', { name: 'Comments' });
    await expect(panel).toContainText(TEXT.answer);
    await expect(panel.getByRole('article', { name: 'Thread' })).toHaveCount(1);
    await expect(reader.locator('body')).not.toContainText(TEXT.note);
    await expect(reader.getByRole('link', { name: 'Comments', exact: true })).toBeVisible();
  });

  await test.step('the folder moves out of its share, and the owner reads every comment', async () => {
    await folderMenu(owner, 'Mains', 'Move to…');
    const dialog = owner.getByRole('dialog', { name: 'Move “Mains”' });
    await pick(dialog.getByLabel('Folder'), 'Top of Kitchen');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await owner.reload();
    const draft = await openComments(owner);
    await expect(draft).toContainText(TEXT.question);
    await expect(draft).toContainText(TEXT.answer);
    await expect(draft).toContainText(TEXT.note);
    await expect(draft).not.toContainText('can’t be opened');

    await owner.getByRole('button', { name: /Published v1/ }).click();
    const published = owner.getByRole('complementary', { name: 'Comments' });
    await expect(published).toContainText(TEXT.question);
    await expect(published.getByText('Editors', { exact: true })).toBeVisible();
    await expect(published).toContainText(TEXT.note);
  });
});
