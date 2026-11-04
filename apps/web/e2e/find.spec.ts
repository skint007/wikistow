import { showIn, visual } from './editor';
import { expect, test } from './fixtures';
import { newFolder, publishedPageIn } from './sharing';
import { adminTab, expectSource, memberWithVault, waitForSave } from './vault';

const BODY = '# Tomato beds\n\nPlant **tom**atoes in May.\n\nWater the tomato plants daily.\n';

/**
 * Find on page (#276): Ctrl+F, or Find on page in the page's menu, opens
 * a bar over the page as read, and over the draft's editors, where it
 * replaces too.
 */
test('Find on page searches the page as read, and replaces in either editor', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newFolder(page, 'Garden');
  await publishedPageIn(page, 'Garden', 'Beds', BODY);
  const bar = page.getByRole('search', { name: 'Find on page' });
  const field = bar.getByRole('textbox', { name: 'Find on page' });
  const replacement = bar.getByRole('textbox', { name: 'Replace with' });
  const said = bar.locator('[aria-live]');

  await test.step('Ctrl+F opens it over the page as read, which it searches as shown', async () => {
    await page.keyboard.press('ControlOrMeta+f');
    await expect(field).toBeFocused();
    await field.fill('tomato');
    // The heading, the word split by bold, and the last line's.
    await expect(said).toHaveText('1 of 3');
    await field.press('Enter');
    await expect(said).toHaveText('2 of 3');
    await field.press('Shift+Enter');
    await expect(said).toHaveText('1 of 3');
    await expect(replacement).toHaveCount(0);
    await field.press('Escape');
    await expect(bar).toHaveCount(0);
    // The match it was on stays selected.
    expect(await page.evaluate(() => String(getSelection()))).toBe('Tomato');
  });

  await test.step('Find on page in the page’s menu opens it again, its text kept', async () => {
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Find on page' }).click();
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('tomato');
    await expect(said).toHaveText('1 of 3');
    await bar.getByRole('button', { name: 'Close find' }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Page actions' })).toBeFocused();
  });

  await test.step('in the source editor, Replace all is one edit, saved', async () => {
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.locator('#page-source').click();
    await page.keyboard.press('ControlOrMeta+f');
    await expect(field).toBeFocused();
    await field.fill('Tomato');
    // In the source, bold splits the word; which is current depends on where the click put the cursor.
    await expect(said).toHaveText(/^[12] of 2$/);
    await replacement.fill('pepper');
    await bar.getByRole('button', { name: 'Replace all' }).click();
    await expect(said).toHaveText('Replaced 2');
    await expectSource(
      page,
      '# pepper beds\n\nPlant **tom**atoes in May.\n\nWater the pepper plants daily.\n',
    );
    await waitForSave(page);
  });

  await test.step('in the visual editor, Replace goes a match at a time', async () => {
    await showIn(page, 'Visual');
    await field.fill('pepper');
    await expect(said).toHaveText('1 of 2');
    await replacement.fill('bean');
    await replacement.press('Enter');
    await expect(said).toHaveText('1 of 1');
    await expect(visual(page).getByRole('heading', { name: 'bean beds' })).toBeVisible();
    // Escape leaves the focus in the editor, on the match it was on.
    await field.press('Escape');
    await expect(visual(page)).toBeFocused();
    await waitForSave(page);
    await showIn(page, 'Source');
    await expectSource(
      page,
      '# bean beds\n\nPlant **tom**atoes in May.\n\nWater the pepper plants daily.\n',
    );
  });

  await test.step('on a phone, the page’s menu opens it under the top bar, where it stays', async () => {
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: 'Tomato beds', level: 1 })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 360 });
    await page.getByRole('button', { name: 'Page actions' }).click();
    await page.getByRole('menuitem', { name: 'Find on page' }).click();
    await expect(field).toBeFocused();
    await field.fill('plants');
    await expect(said).toHaveText('1 of 1');
    const top = (await bar.boundingBox())?.y;
    expect(top).toBeGreaterThan(50);
    expect(top).toBeLessThan(80);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.wheel(0, 400);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect((await bar.boundingBox())?.y).toBe(top);
  });
});
