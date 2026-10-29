import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newFolder, openShared, publishedPageIn, shareFolder } from './sharing';
import { adminTab, expectSource, fillSource, memberWithVault, waitForSave } from './vault';

const LIST = '- [ ] milk\n- [ ] bread\n- [ ] eggs\n- [x] jam\n';

const box = (page: Page, name: string) => page.getByRole('checkbox', { name, exact: true });

/** Open the page `title` from the sidebar, on its publication. */
async function openPage(page: Page, title: string) {
  await page.getByRole('treeitem', { name: title }).click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

/**
 * Ticking a page's tasks while reading it (#212): the ticks wait for a
 * pause, then go up as one version. Only an editor who can publish ticks,
 * and only while the draft has no changes of its own.
 */
test('ticking tasks while reading publishes them together, only for those who may', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const reader = await freshPage();
  await memberWithVault(owner, adminPage, 'Tilly Ticker');
  const { email: readerEmail } = await memberWithVault(reader, adminPage, 'Reggie Reader');
  await newFolder(owner, 'Lists');
  await publishedPageIn(owner, 'Lists', 'Shopping', LIST);

  await test.step('several ticks in a row make one new version', async () => {
    await box(owner, 'milk').check();
    await box(owner, 'bread').check();
    await box(owner, 'eggs').check();
    await box(owner, 'jam').uncheck();
    await expect(
      owner.getByRole('status').filter({ hasText: 'Publishing your changes' }),
    ).toBeVisible();
    await expect(owner.getByText('Published v2')).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByText('Your changes are published.')).toBeVisible();
    // The boxes stay as ticked through the new version, and no other follows.
    for (const name of ['milk', 'bread', 'eggs']) await expect(box(owner, name)).toBeChecked();
    await expect(box(owner, 'jam')).not.toBeChecked();
    await owner.waitForTimeout(5000);
    await expect(owner.getByText('Published v2')).toBeVisible();
    await owner.getByRole('button', { name: 'History' }).click();
    const sheet = owner.getByRole('dialog', { name: 'History' });
    await expect(sheet.getByText('Version 2')).toBeVisible();
    await expect(sheet.getByText('Version 3')).toHaveCount(0);
    await owner.keyboard.press('Escape');
  });

  await test.step('the published Markdown holds them', async () => {
    await owner.reload();
    await expect(owner.getByText('Published v2')).toBeVisible();
    await expect(box(owner, 'milk')).toBeChecked();
    await expect(box(owner, 'jam')).not.toBeChecked();
    await owner.getByRole('button', { name: 'Edit' }).click();
    await expectSource(owner, '- [x] milk\n- [x] bread\n- [x] eggs\n- [ ] jam\n');
    await owner.getByRole('button', { name: 'Done' }).click();
    await expect(owner.getByText('Published v2')).toBeVisible();
  });

  await test.step('leaving the page publishes a tick at once', async () => {
    await publishedPageIn(owner, 'Lists', 'Chores', '- [ ] dishes\n');
    await box(owner, 'dishes').check();
    await openPage(owner, 'Shopping');
    await openPage(owner, 'Chores');
    await expect(owner.getByText('Published v2')).toBeVisible({ timeout: 15_000 });
    await expect(box(owner, 'dishes')).toBeChecked();
  });

  await test.step('a reader’s boxes are read-only', async () => {
    await shareFolder(owner, 'Lists', readerEmail, 'reader');
    await owner.keyboard.press('Escape');
    await openShared(reader, 'Lists', 'Shopping');
    await expect(box(reader, 'milk')).toBeChecked();
    await expect(box(reader, 'bread')).toBeDisabled();
    await expect(box(reader, 'jam')).toBeDisabled();
    await expect(box(reader, 'jam')).not.toHaveAttribute('data-hint');
  });

  await test.step('with unpublished changes in the draft, the boxes wait for it', async () => {
    await openPage(owner, 'Shopping');
    await owner.getByRole('button', { name: 'Edit' }).click();
    await fillSource(owner, `${LIST}\nMy own edit, not published yet.\n`);
    await waitForSave(owner);
    await owner.getByRole('button', { name: 'Done' }).click();
    await expect(owner.getByRole('button', { name: /Draft has changes/ })).toBeVisible();
    await expect(box(owner, 'milk')).toBeDisabled();
    await expect(box(owner, 'milk')).toHaveAttribute(
      'data-hint',
      'Open the draft to tick this: it has unpublished changes',
    );
    await owner.mouse.move(10, 10);
    await box(owner, 'milk').hover();
    await expect(owner.locator('[data-slot="tooltip-content"]')).toHaveText(
      'Open the draft to tick this: it has unpublished changes',
    );
    await expect(owner.getByText('Published v2')).toBeVisible();
  });
});
