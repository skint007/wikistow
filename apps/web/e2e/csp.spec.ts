import { expect, test, violationsIn } from './fixtures';
import {
  adminTab,
  expectSource,
  fillSource,
  memberWithVault,
  newPage,
  PNG,
  waitForSave,
} from './vault';

test('both editors raise none, with everything each of them draws', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Everything');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'bed.png', mimeType: 'image/png', buffer: PNG });
  await expectSource(page, /^!\[bed\.png\]/);
  const picture = (await page.locator('#page-source').innerText()).trim();
  const body = [
    '| Left | Middle | Right |',
    '| :--- | :----: | ----: |',
    '| a    |   b    |     c |',
    '',
    '- [ ] a task',
    '- [x] a done one',
    '',
    '<b>inert</b> and `code`',
    '',
    'A [[Everything]] link and ![remote](https://example.test/x.png)',
    '',
    picture,
  ].join('\n');
  await fillSource(page, body);
  await page.keyboard.type('\n[[Ev');
  await expect(page.getByRole('option', { name: 'Create page “Ev”' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await waitForSave(page);

  const visual = page.locator('#page-visual');
  await page.getByRole('group', { name: 'Editor' }).getByRole('button', { name: 'Visual' }).click();
  await expect(visual.getByRole('img', { name: 'bed.png' })).toBeVisible();
  await expect(visual.locator('th', { hasText: 'Right' })).toHaveClass('text-right');
  await visual.getByRole('checkbox').first().check();
  await visual.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\n[[Ev');
  await expect(page.getByRole('option', { name: 'Create page “Ev”' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Rich text, styled and with a handler, comes in through the schema, in
  // forms a pattern would miss: a slash before `style`, a `>` in quotes.
  await visual.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<p style="color:red" onclick="x()"><i>pasted</i></p><p/style="color:red">slashed</p><p title=">" style="color:red">quoted</p>',
    );
    data.setData('text/plain', 'pasted');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(visual.locator('em', { hasText: 'pasted' })).toBeVisible();
  await expect(visual.locator('p', { hasText: 'quoted' })).toBeVisible();
  expect(await visual.locator('[style]').count()).toBe(0);
  await waitForSave(page);
  await page.getByRole('group', { name: 'Editor' }).getByRole('button', { name: 'Source' }).click();
  await expectSource(page, /\*pasted\*/);
  expect(await violationsIn(page)).toEqual([]);
  expect(await page.evaluate(() => document.querySelectorAll('style').length)).toBe(0);
});

test.describe('the Content Security Policy', () => {
  test.use({
    expectedViolations: ['script-src-elem', 'script-src-attr'],
  });

  test('blocks injected inline scripts and event handlers', async ({ page }) => {
    await page.goto('/sign-in');
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.inlineRan = true';
      document.body.append(script);
      const img = document.createElement('img');
      img.setAttribute('onerror', 'window.handlerRan = true');
      img.src = '/does-not-exist.png';
      document.body.append(img);
    });
    await expect.poll(async () => (await violationsIn(page)).length).toBeGreaterThanOrEqual(2);
    expect(
      await page.evaluate(() => [
        Reflect.get(window, 'inlineRan'),
        Reflect.get(window, 'handlerRan'),
      ]),
    ).toEqual([undefined, undefined]);
  });
});
