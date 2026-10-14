import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  adminTab,
  expectSource,
  fillSource,
  memberWithVault,
  newPage,
  PNG,
  saveStatus,
  waitForSave,
} from './vault';
import { caretAtEndOf, reloadPage, showIn, toggle, visual } from './editor';

/** Every request a page makes to a host other than the app's own. */
function thirdParty(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'blob:' || url.protocol === 'data:') return;
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') seen.push(url.href);
  });
  return seen;
}

// What Markdown writes differently from how it's read: a setext heading,
// `*` bullets, a padded table, no final line break.
const BODY = [
  'Beds',
  '====',
  '',
  '* Tomatoes',
  '* Beans',
  '',
  '| Bed | Rows |',
  '|:----|-----:|',
  '| A   |    3 |',
  '',
  '- [ ] Water the beans',
  '',
  'See [[Watering]].',
  '',
  '![Neighbour’s photo](https://example.test/garden.png)',
].join('\n');

test('switching editors changes no byte, and visual edits save as Markdown', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  const outside = thirdParty(page);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Garden');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'bed.png', mimeType: 'image/png', buffer: PNG });
  await expectSource(page, /^!\[bed\.png\]\(attachment:[\w-]+\)$/);
  const picture = (await page.locator('#page-source').innerText()).trim();
  const body = `${BODY}\n\n${picture}`;
  await fillSource(page, body);
  await waitForSave(page);

  await test.step('opened in the visual editor and back to source, every byte as it was, with nothing to save', async () => {
    await showIn(page, 'Visual');
    await expect(visual(page).getByRole('img', { name: 'bed.png' })).toBeVisible();
    await showIn(page, 'Source');
    await expectSource(page, body);
    await expect(saveStatus(page)).toHaveText('All changes saved');
  });

  await test.step('an edit in the visual editor saves as Markdown', async () => {
    await showIn(page, 'Visual');
    await visual(page).getByRole('checkbox', { name: 'Done' }).check();
    await caretAtEndOf(visual(page).getByText('Beans', { exact: true }));
    await page.keyboard.type(' and peas');
    await waitForSave(page);
    await reloadPage(page);
    await expect(visual(page)).toContainText('Beans and peas');
    await showIn(page, 'Source');
    await expectSource(
      page,
      [
        '# Beds',
        '',
        '- Tomatoes',
        '- Beans and peas',
        '',
        '| Bed | Rows |',
        '| :-- | ---: |',
        '| A   |    3 |',
        '',
        '- [x] Water the beans',
        '',
        'See [[Watering]].',
        '',
        '![Neighbour’s photo](https://example.test/garden.png)',
        '',
        picture,
      ].join('\n'),
    );
  });

  expect(outside).toEqual([]);
});

test('split mode edits the source and the visual editor side by side, as one draft', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Seeds');
  await fillSource(page, '# Seeds\n\nSow in spring.');
  await waitForSave(page);
  await showIn(page, 'Split');
  const source = page.locator('#page-source');

  await test.step('typing in the source reaches the visual side, the focus staying', async () => {
    await source.focus();
    await source.press('ControlOrMeta+End');
    await page.keyboard.type('\n\n- Beans');
    await expect(visual(page).getByRole('listitem')).toHaveText('Beans');
    await expect(source).toBeFocused();
    await page.keyboard.type(' and peas');
    await expect(visual(page).getByRole('listitem')).toHaveText('Beans and peas');
    await expectSource(page, '# Seeds\n\nSow in spring.\n\n- Beans and peas');
  });

  await test.step('typing in the visual side reaches the source, the focus staying', async () => {
    await caretAtEndOf(visual(page).getByText('Sow in spring.'));
    await page.keyboard.type(' Water daily.');
    await expectSource(page, '# Seeds\n\nSow in spring. Water daily.\n\n- Beans and peas');
    await expect(visual(page)).toBeFocused();
    await page.keyboard.type(' Twice.');
    await expect(visual(page)).toContainText('Water daily. Twice.');
    await waitForSave(page);
  });

  const page1 = '# Seeds\n\nSow in spring. Water daily. Twice.\n\n- Beans and peas';
  await test.step('switching modes and reloading keep both sides’ edits', async () => {
    await expectSource(page, page1);
    await showIn(page, 'Visual');
    await expect(visual(page)).toContainText('Twice.');
    await showIn(page, 'Split');
    await showIn(page, 'Source');
    await expectSource(page, page1);
    await showIn(page, 'Split');
    await reloadPage(page);
    await expect(toggle(page, 'Split')).toHaveAttribute('aria-pressed', 'true');
    await expect(visual(page)).toContainText('Water daily. Twice.');
    await expectSource(page, page1);
    await expect(saveStatus(page)).toHaveText('All changes saved');
  });
});
