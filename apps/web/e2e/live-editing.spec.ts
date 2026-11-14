// Editing a page live (ADR 0015 step 6): two people's browsers with one
// page's draft open, typing into it at once in source mode. Both see both,
// the page keeps one draft history, nobody meets a conflict, and each sees
// the other in the toolbar and their caret in the text. This project's
// server answers over HTTP/2, which browsers need to join (decision 10).
import type { Page } from '@playwright/test';
import { expect, serverSnapshot, test } from './fixtures';
import { openShared, publishedPageIn, newFolder, newSpace, shareFolder } from './sharing';
import { adminTab, expectSource, memberWithVault, saveStatus, sourceOf } from './vault';

/** Type `text` at the end of the source editor, as keys. */
async function typeAtEnd(page: Page, text: string) {
  const source = page.locator('#page-source');
  await source.focus();
  await source.press('ControlOrMeta+End');
  await page.keyboard.type(text, { delay: 15 });
}

/** Type `text` at the very start of the source editor, as keys. */
async function typeAtStart(page: Page, text: string) {
  const source = page.locator('#page-source');
  await source.focus();
  await source.press('ControlOrMeta+Home');
  await page.keyboard.type(text, { delay: 15 });
}

type Row = Record<string, unknown>;

test('two people type into one page live: both see both, one history, no conflict', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const editor = await freshPage();
  await memberWithVault(owner, adminPage, 'Olive Owner');
  const { email: editorEmail } = await memberWithVault(editor, adminPage, 'Eddie Editor');

  await test.step('the owner shares a folder with the editor, and both open the draft', async () => {
    await newSpace(owner, 'Family');
    await newFolder(owner, 'Garden');
    await publishedPageIn(owner, 'Garden', 'Planting plan', 'Beans in May.');
    await shareFolder(owner, 'Garden', editorEmail, 'editor');
    await owner.keyboard.press('Escape');
    await owner.getByRole('button', { name: 'Edit' }).click();
    await expectSource(owner, 'Beans in May.');

    await openShared(editor, 'Garden', 'Planting plan');
    await editor.getByRole('button', { name: 'Edit' }).click();
    await expectSource(editor, 'Beans in May.');
  });

  await test.step('each sees the other in the toolbar', async () => {
    await expect(owner.getByRole('img', { name: 'Eddie Editor is editing' })).toBeVisible();
    await expect(editor.getByRole('img', { name: 'Olive Owner is editing' })).toBeVisible();
  });

  const before = (await serverSnapshot()).rows['revisions'] as Row[];
  const draftsBefore = new Set(before.filter((r) => r['audience'] === 'draft').map((r) => r['id']));

  await test.step('they type at once, and both see both', async () => {
    await Promise.all([typeAtEnd(owner, ' Peas in June.'), typeAtStart(editor, 'Garden notes. ')]);
    const both = 'Garden notes. Beans in May. Peas in June.';
    await expectSource(owner, both);
    await expectSource(editor, both);
    await expect(saveStatus(owner)).toHaveText('All changes saved', { timeout: 30_000 });
    await expect(saveStatus(editor)).toHaveText('All changes saved', { timeout: 30_000 });
  });

  await test.step('the other’s caret shows where they are', async () => {
    await typeAtEnd(editor, ' Water daily.');
    await expect(owner.locator('[data-live-caret]', { hasText: 'Eddie Editor' })).toBeVisible();
    await expectSource(owner, 'Garden notes. Beans in May. Peas in June. Water daily.');
    await expect(saveStatus(owner)).toHaveText('All changes saved', { timeout: 30_000 });
  });

  await test.step('nobody met a conflict, and the page has one draft history', async () => {
    for (const page of [owner, editor]) {
      await expect(page.getByText(/Someone else (saved|changed)/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Merge…' })).toHaveCount(0);
    }
    const rows = (await serverSnapshot()).rows['revisions'] as Row[];
    const drafts = rows.filter((r) => r['audience'] === 'draft' && !draftsBefore.has(r['id']));
    expect(drafts.length).toBeGreaterThan(0);
    // One line: each new draft is based on the one before it, none twice.
    const bases = drafts.map((r) => r['based_on']);
    expect(new Set(bases).size).toBe(bases.length);
    const ids = new Set(drafts.map((r) => r['id']));
    const roots = drafts.filter((r) => !ids.has(r['based_on']));
    expect(roots).toHaveLength(1);
    expect(await sourceOf(editor)).toBe(await sourceOf(owner));
  });
});
