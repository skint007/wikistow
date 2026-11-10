import type { Locator, Page } from '@playwright/test';
import { showIn, visual } from './editor';
import { expect, pick, test } from './fixtures';
import {
  folderMenu,
  newFolder,
  newSpace,
  openFolder,
  publishedPageIn,
  shareFolder,
} from './sharing';
import { adminTab, fillSource, memberWithVault, waitForSave } from './vault';

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

/**
 * Select from where `start` begins to where `end` ends, as a person
 * dragging over the text would, and have the visual editor read it at once.
 */
async function select(within: Locator, start: string, end: string) {
  await within.evaluate(
    (root, [start, end]) => {
      const texts: Text[] = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text);
      const from = texts.find((t) => t.data.includes(start!));
      const to = texts.find((t) => t.data.includes(end!));
      if (!from || !to) throw new Error(`No “${start}” to “${end}” here`);
      root.closest<HTMLElement>('#page-visual')?.focus();
      const range = document.createRange();
      range.setStart(from, from.data.indexOf(start!));
      range.setEnd(to, to.data.indexOf(end!) + end!.length);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    },
    [start, end],
  );
}

/** How many passages are underlined on the page as read. */
const underlined = (page: Page) =>
  page.evaluate(() => CSS.highlights.get('comment-passage')?.size ?? 0);

const PASSAGE = {
  page: '## Method\n\n1. Brown the mince with the onion.\n2. Bake at [[Oven]] 180 °C for 45 minutes.\n3. Rest for 10 minutes.\n',
  edited: '## Method\n\n1. Fry the mince.\n2. Bake for an hour.\n3. Rest for 10 minutes.\n',
  // A wikilink in it reads as written, whatever title it shows (ADR 0014, decision 5).
  baking: '“Bake at [[Oven]] 180 °C for 45 minutes”',
  browning: '“Brown the mince with the onion”',
};

/**
 * Comments on passages (ADR 0014, step 4): one chosen in the page as read,
 * underlined there, and one chosen in the visual editor, which Show
 * selects again. Then the passages are edited away: their threads stay,
 * saying so, with the version the passage was chosen in.
 */
test('a comment on a passage, then the passage edited away', async ({ page, freshPage, admin }) => {
  test.setTimeout(240_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newFolder(page, 'Recipes');
  await publishedPageIn(page, 'Recipes', 'Lasagne', PASSAGE.page);
  const body = page.locator('[data-quote-root]');
  const panel = page.getByRole('complementary', { name: 'Comments' });
  const thread = (text: string) =>
    panel.getByRole('article', { name: 'Thread' }).filter({ hasText: text });

  await test.step('a passage chosen as read is quoted and underlined', async () => {
    await select(body, 'Bake at', '45 minutes');
    await page.getByRole('button', { name: 'Comment on the selection' }).click();
    await expect(panel.locator('form blockquote')).toHaveText(PASSAGE.baking);
    await send(panel, 'Comment for everyone who reads this page', 'Fan oven or not?');
    await expect(panel.locator('form blockquote')).toHaveCount(0);
    await expect(thread('Fan oven').locator('blockquote')).toHaveText(PASSAGE.baking);
    await expect.poll(() => underlined(page)).toBe(1);
    // Clicked, the passage opens its thread.
    await panel.getByRole('button', { name: 'Close comments' }).click();
    const at = await body.evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const offset = node.textContent!.indexOf('180');
        if (offset === -1) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 3);
        const { x, y, width, height } = range.getBoundingClientRect();
        return { x: x + width / 2, y: y + height / 2 };
      }
      throw new Error('No passage');
    });
    await page.mouse.click(at.x, at.y);
    await expect(thread('Fan oven')).toBeVisible();
  });

  await test.step('a passage chosen in the visual editor, which Show selects again', async () => {
    await page.getByRole('button', { name: 'Edit' }).click();
    await showIn(page, 'Visual');
    await select(visual(page), 'Brown', 'onion');
    await page.getByRole('button', { name: 'Comment on the selection' }).click();
    await expect(panel.locator('form blockquote')).toHaveText(PASSAGE.browning);
    await send(panel, 'Comment for editors', 'Beef or lamb?');
    await visual(page).getByText('Rest for').click();
    await thread('Beef or lamb').getByRole('button', { name: 'Show' }).click();
    await expect
      .poll(() => page.evaluate(() => String(getSelection())))
      .toBe('Brown the mince with the onion');
  });

  await test.step('edited away, each thread says so, with the version it was on', async () => {
    await showIn(page, 'Source');
    await fillSource(page, PASSAGE.edited);
    await waitForSave(page);
    await showIn(page, 'Visual');
    await expect(thread('Beef or lamb')).toContainText('This passage isn’t in the page now.');
    await expect(thread('Beef or lamb').getByRole('button', { name: 'Show' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Published v2')).toBeVisible();
    await expect(body).toContainText('Bake for an hour');
    const baking = thread('Fan oven');
    await expect(baking).toContainText('This passage isn’t in the page now.');
    await expect(baking.locator('blockquote')).toHaveText(PASSAGE.baking);
    await expect.poll(() => underlined(page)).toBe(0);
    await baking.getByRole('link', { name: 'Made on version 1' }).click();
    await expect(body).toContainText('Bake at Oven 180 °C');
    // Both passages are there, the editors' too, which only editors see.
    await expect.poll(() => underlined(page)).toBe(2);
  });
});
