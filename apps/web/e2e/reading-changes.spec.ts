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
    // The version the ticks replaced, from history: as it was, with nothing to tick.
    await sheet.getByRole('button', { name: 'View' }).click();
    await expect(owner.getByRole('button', { name: /Latest version/ })).toBeVisible();
    await expect(box(owner, 'milk')).not.toBeChecked();
    await expect(box(owner, 'milk')).toBeDisabled();
    await expect(box(owner, 'milk')).toHaveAttribute('data-hint', /older version/);
    await owner.getByRole('button', { name: /Latest version/ }).click();
    await expect(box(owner, 'milk')).toBeChecked();
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

  await test.step('leaving the page publishes a tick at once, not after the pause', async () => {
    await publishedPageIn(owner, 'Lists', 'Chores', '- [ ] dishes\n');
    const saved = owner.waitForRequest(
      (request) =>
        request.method() === 'POST' && /\/api\/pages\/[^/]+\/drafts$/.test(request.url()),
    );
    await box(owner, 'dishes').check();
    const ticked = Date.now();
    await openPage(owner, 'Shopping');
    await saved;
    // The pause is three seconds: a save this soon is the one leaving made.
    expect(Date.now() - ticked).toBeLessThan(2500);
    await openPage(owner, 'Chores');
    await expect(owner.getByText('Published v2')).toBeVisible({ timeout: 15_000 });
    await expect(box(owner, 'dishes')).toBeChecked();
    // Back on the page, it says how the flush made on leaving it went.
    await expect(owner.getByText('Your changes are published.')).toBeVisible();
  });

  await test.step('opening the draft right after a tick waits for it, then opens on top of it', async () => {
    await box(owner, 'dishes').uncheck();
    await owner.getByRole('button', { name: 'Edit' }).click();
    await expectSource(owner, '- [ ] dishes\n');
    await expect(owner.getByText('Your changes are published.')).toBeVisible();
    await owner.locator('#page-source').press('End');
    await owner.keyboard.type(' and pans');
    await waitForSave(owner);
    await expect(owner.getByText(/Someone else saved/)).toHaveCount(0);
    await owner.getByRole('button', { name: 'Done' }).click();
    await expect(owner.getByText('Published v3')).toBeVisible();
  });

  await test.step('a tick published keeps the reader where they were, on the same box', async () => {
    const paragraphs = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n');
    const long = `## Start\n\n${paragraphs}\n\n- [ ] another\n- [ ] last one\n`;
    await publishedPageIn(owner, 'Lists', 'Long list', long);
    // From a link to its first heading, which ticks mustn't scroll back to.
    await owner.goto(`${owner.url()}#heading-start`);
    await expect(owner.getByText('Published v1')).toBeVisible();
    const card = owner.locator('article[data-region="page"]');
    await box(owner, 'last one').scrollIntoViewIfNeeded();
    const scrolled = await card.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(500);
    await box(owner, 'last one').focus();
    await owner.keyboard.press('Space');
    await expect(box(owner, 'last one')).toBeChecked();
    await expect(owner.getByText('Published v2')).toBeVisible({ timeout: 30_000 });
    await expect(box(owner, 'last one')).toBeFocused();
    await expect(box(owner, 'last one')).toBeChecked();
    const now = await card.evaluate((element) => element.scrollTop);
    expect(Math.abs(now - scrolled)).toBeLessThan(40);
  });

  await test.step('opening the draft just after coming back waits for the flush leaving made', async () => {
    await box(owner, 'another').check();
    await openPage(owner, 'Shopping');
    await openPage(owner, 'Long list');
    await owner.getByRole('button', { name: 'Edit' }).click();
    await expectSource(owner, /- \[x\] another\n- \[x\] last one\n$/);
    await owner.locator('#page-source').press('ControlOrMeta+End');
    await owner.keyboard.type('\nMore.');
    await waitForSave(owner);
    await expect(owner.getByText(/Someone else saved/)).toHaveCount(0);
    await owner.getByRole('button', { name: 'Done' }).click();
    await expect(owner.getByText('Published v3')).toBeVisible();
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
