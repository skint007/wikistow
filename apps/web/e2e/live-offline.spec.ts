// Going offline in a live session (ADR 0015 decisions 6 and 10): a short
// break resumes from the same join, and what was typed meanwhile goes out;
// past the join's 30 s, the app leaves, keeps the typing on the device, and
// puts it back when it comes back, by block, with nobody meeting a conflict.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openShared, publishedPageIn, newFolder, newSpace, shareFolder } from './sharing';
import { adminTab, expectSource, memberWithVault, saveStatus } from './vault';

async function typeAt(page: Page, where: 'start' | 'end', text: string) {
  const source = page.locator('#page-source');
  await source.focus();
  await source.press(where === 'start' ? 'ControlOrMeta+Home' : 'ControlOrMeta+End');
  await page.keyboard.type(text, { delay: 15 });
}

test('typing offline in a live session goes in when the app is back, short break or long', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const editor = await freshPage();
  await memberWithVault(owner, adminPage, 'Olive Owner');
  const { email: editorEmail } = await memberWithVault(editor, adminPage, 'Eddie Editor');

  await test.step('both open the shared page’s draft', async () => {
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
    await expect(owner.getByRole('img', { name: 'Eddie Editor is editing' })).toBeVisible();
  });

  await test.step('a short break: the same join resumes, sending what was typed', async () => {
    await editor.context().setOffline(true);
    await typeAt(editor, 'end', ' Peas in June.');
    await editor.waitForTimeout(4_000);
    await editor.context().setOffline(false);
    await expectSource(owner, 'Beans in May. Peas in June.');
    await expect(saveStatus(editor)).toHaveText('All changes saved', { timeout: 30_000 });
    await expect(saveStatus(owner)).toHaveText('All changes saved', { timeout: 30_000 });
  });

  await test.step('a long break: kept on the device, and put back by block', async () => {
    await editor.context().setOffline(true);
    await typeAt(editor, 'end', '\n\nWater daily.');
    // Meanwhile the owner writes a paragraph of their own.
    await typeAt(owner, 'start', 'Garden notes.\n\n');
    await expect(saveStatus(owner)).toHaveText('All changes saved', { timeout: 30_000 });
    // Past the join's 30 s, the editor's app leaves the session.
    await expect(owner.getByRole('img', { name: 'Eddie Editor is editing' })).toBeHidden({
      timeout: 60_000,
    });
    await editor.waitForTimeout(5_000);
    await editor.context().setOffline(false);
    const all = 'Garden notes.\n\nBeans in May. Peas in June.\n\nWater daily.';
    await expectSource(owner, all, { timeout: 60_000 });
    await expectSource(editor, all, { timeout: 60_000 });
    await expect(saveStatus(editor)).toHaveText('All changes saved', { timeout: 60_000 });
    for (const page of [owner, editor]) {
      await expect(page.getByText(/Someone else (saved|changed)/)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Merge…' })).toHaveCount(0);
    }
  });
});
