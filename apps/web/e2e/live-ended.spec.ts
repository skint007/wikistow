// Publishing in a live session, and a session that ends with typing
// unsaved (ADR 0015 decisions 5 and 12): Publish says who else is editing,
// and publishes what the page showed at the press; and when a tab closed
// before its typing was saved and then access to the page changed, the
// next editor's app catches up from the ended session and saves it.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  addPerson,
  folderMenu,
  openShared,
  publishedPageIn,
  newFolder,
  newSpace,
  shareDialog,
  shareFolder,
} from './sharing';
import { adminTab, expectSource, memberWithVault, saveStatus } from './vault';

async function typeAtEnd(page: Page, text: string) {
  const source = page.locator('#page-source');
  await source.focus();
  await source.press('ControlOrMeta+End');
  await page.keyboard.type(text, { delay: 15 });
}

/** The page's live sessions as the server serves them to `page`'s person. */
async function liveOf(page: Page) {
  const pageId = /\/p\/([^/?#]+)/.exec(page.url())?.[1];
  if (!pageId) throw new Error('not on a page');
  return page.evaluate(async (id) => {
    const answer = await fetch(`/api/pages/${id}/live`, { credentials: 'same-origin' });
    return (await answer.json()) as { open: unknown; ended: unknown };
  }, pageId);
}

test('publishing while others edit says so, and publishes the page as it was at the press', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const editor = await freshPage();
  await memberWithVault(owner, adminPage, 'Pia Publisher');
  const { email: editorEmail } = await memberWithVault(editor, adminPage, 'Eli Editor');

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
    await expect(owner.getByRole('img', { name: 'Eli Editor is editing' })).toBeVisible();
  });

  await test.step('Publish says who else is editing, and publishes what both see', async () => {
    await typeAtEnd(editor, ' Peas in June.');
    await expectSource(owner, 'Beans in May. Peas in June.');
    const publish = owner.getByRole('button', { name: 'Publish', exact: true });
    await expect(publish).toHaveAttribute('title', 'Eli Editor is editing too');
    await publish.click();
    await expect(owner.getByText('Beans in May. Peas in June.')).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByRole('alert')).toHaveCount(0);
    // The editor goes on in the session, and saves as before.
    await typeAtEnd(editor, ' Leeks in July.');
    await expect(saveStatus(editor)).toHaveText('All changes saved', { timeout: 30_000 });
  });
});

test('typing a session ended with unsaved is caught up by the next editor', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const editor = await freshPage();
  const reader = await freshPage();
  await memberWithVault(owner, adminPage, 'Uma Unsaved');
  const { email: editorEmail } = await memberWithVault(editor, adminPage, 'Ted Typist');
  const { email: readerEmail } = await memberWithVault(reader, adminPage, 'Rhea Reader');

  await test.step('the editor types, and closes the tab before any save lands', async () => {
    await newSpace(owner, 'Family');
    await newFolder(owner, 'Garden');
    await publishedPageIn(owner, 'Garden', 'Planting plan', 'Beans in May.');
    await shareFolder(owner, 'Garden', editorEmail, 'editor');
    await owner.keyboard.press('Escape');
    await openShared(editor, 'Garden', 'Planting plan');
    await editor.getByRole('button', { name: 'Edit' }).click();
    await expectSource(editor, 'Beans in May.');
    await expect(saveStatus(editor)).toHaveText('All changes saved', { timeout: 30_000 });
    // From here no draft save gets through, as when the tab closes mid-save.
    await editor.route('**/api/pages/*/drafts', (route) => route.abort());
    const sent = editor.waitForResponse((r) => /\/api\/live\/[^/]+\/messages/.test(r.url()));
    await typeAtEnd(editor, ' Peas in June.');
    await sent;
    await editor.waitForTimeout(1_500);
    await editor.close();
  });

  await test.step('access to the page changes, which ends the session it kept', async () => {
    await folderMenu(owner, 'Garden', 'Share…');
    await addPerson(shareDialog(owner, 'Garden'), readerEmail, 'reader', 'Rhea Reader');
    await owner.keyboard.press('Escape');
    await owner.getByRole('treeitem', { name: 'Planting plan' }).click();
    await expect(owner.getByRole('heading', { name: 'Planting plan', level: 1 })).toBeVisible();
    // Served to catch up from once the editor's join has gone.
    await expect.poll(async () => (await liveOf(owner)).ended, { timeout: 60_000 }).not.toBeNull();
  });

  await test.step('the owner’s app catches up from it, and says so', async () => {
    await owner.getByRole('button', { name: 'Edit' }).click();
    await expectSource(owner, 'Beans in May. Peas in June.', { timeout: 30_000 });
    await expect(
      owner.getByText('Saved what a live session that ended had left unsaved.'),
    ).toBeVisible();
    await expect(owner.getByText(/Someone else (saved|changed)/)).toHaveCount(0);
    await expect.poll(async () => (await liveOf(owner)).ended, { timeout: 30_000 }).toBeNull();
    // Its notice says "unsaved" too: the save status by its own words.
    await expect(owner.getByRole('status').filter({ hasText: /^All changes saved$/ })).toBeVisible({
      timeout: 30_000,
    });
  });
});
