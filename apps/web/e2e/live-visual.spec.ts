// Editing a page live in the visual editor (ADR 0015 step 7): one person in
// the visual editor and one in source mode type into one page at once. Both
// see both, nobody meets a conflict, the source editor's typist shows as a
// bar beside the block they're in, and when they add what the visual
// editor can't show, the other's page turns to source mode, saying who.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { caretAtEndOf, showIn, visual } from './editor';
import { openShared, publishedPageIn, newFolder, newSpace, shareFolder } from './sharing';
import { adminTab, expectSource, memberWithVault, saveStatus } from './vault';

/** Type `text` at the end of the source editor, as keys. */
async function typeAtEndOfSource(page: Page, text: string) {
  const source = page.locator('#page-source');
  await source.focus();
  await source.press('ControlOrMeta+End');
  await page.keyboard.type(text, { delay: 15 });
}

/** The visual editor's first paragraph. */
const beans = (page: Page) => visual(page).locator('p').first();

test('one person in the visual editor, one in source mode: both see both, no conflict', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const editor = await freshPage();
  await memberWithVault(owner, adminPage, 'Olive Owner');
  const { email: editorEmail } = await memberWithVault(editor, adminPage, 'Eddie Editor');

  await test.step('the owner shares a page, and both open its draft', async () => {
    await newSpace(owner, 'Family');
    await newFolder(owner, 'Garden');
    await publishedPageIn(owner, 'Garden', 'Planting plan', 'Beans in May.\n\nCompost in March.');
    await shareFolder(owner, 'Garden', editorEmail, 'editor');
    await owner.keyboard.press('Escape');
    await owner.getByRole('button', { name: 'Edit' }).click();
    await expectSource(owner, 'Beans in May.\n\nCompost in March.');

    await openShared(editor, 'Garden', 'Planting plan');
    await editor.getByRole('button', { name: 'Edit' }).click();
    await expectSource(editor, 'Beans in May.\n\nCompost in March.');
    await expect(owner.getByRole('img', { name: 'Eddie Editor is editing' })).toBeVisible();
    await expect(editor.getByRole('img', { name: 'Olive Owner is editing' })).toBeVisible();
  });

  await test.step('the editor turns to the visual editor while the owner edits', async () => {
    await showIn(editor, 'Visual');
    await expect(beans(editor)).toHaveText('Beans in May.');
  });

  await test.step('they type at once, and both see both', async () => {
    await Promise.all([
      typeAtEndOfSource(owner, ' Peas in June.'),
      (async () => {
        await caretAtEndOf(beans(editor));
        await editor.keyboard.type(' Water daily.', { delay: 15 });
      })(),
    ]);
    const both = 'Beans in May. Water daily.\n\nCompost in March. Peas in June.';
    await expectSource(owner, both);
    await expect(beans(editor)).toHaveText('Beans in May. Water daily.');
    await expect(visual(editor)).toContainText('Compost in March. Peas in June.');
    await expect(saveStatus(owner)).toHaveText('All changes saved', { timeout: 30_000 });
    await expect(saveStatus(editor)).toHaveText('All changes saved', { timeout: 30_000 });
  });

  await test.step('each sees where the other is', async () => {
    await typeAtEndOfSource(owner, ' Rake.');
    // The source typist as a bar beside their block, in the visual editor.
    const bar = visual(editor).locator('.live-block[data-live-block="Olive Owner"]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Compost in March. Peas in June. Rake.');
    // The visual typist's caret, by name, in source mode.
    await caretAtEndOf(beans(editor));
    await editor.keyboard.type('!', { delay: 15 });
    await expect(owner.locator('[data-live-caret]', { hasText: 'Eddie Editor' })).toBeVisible();
    await expectSource(
      owner,
      'Beans in May. Water daily.!\n\nCompost in March. Peas in June. Rake.',
    );
  });

  await test.step('nobody met a conflict', async () => {
    for (const page of [owner, editor]) {
      await expect(page.getByText(/Someone else (saved|changed)/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Merge…' })).toHaveCount(0);
    }
  });

  await test.step('what the visual editor can’t show turns it to source mode, saying who', async () => {
    // A link definition nothing uses, which the visual editor would drop.
    await typeAtEndOfSource(owner, '\n\n[unused]: https://example.test');
    await expect(
      editor.getByText('Olive Owner added something the visual editor can’t show.'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(editor.locator('#page-source')).toBeVisible();
    await expect(visual(editor)).toHaveCount(0);
    await expectSource(
      editor,
      'Beans in May. Water daily.!\n\nCompost in March. Peas in June. Rake.\n\n[unused]: https://example.test',
    );
  });
});
