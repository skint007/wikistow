import { expect, test } from './fixtures';
import { adminTab, memberWithVault, newPage, waitForSave } from './vault';

/**
 * Whoever wrote a page, reading it runs nothing and contacts nobody: raw
 * HTML renders without script, handlers or styles, unsafe links lose their
 * target, and only attachments load as images.
 */
const SOURCE = [
  '# Heading with <b>bold</b> in it',
  '',
  '<script>window.__pageRan = true</script>',
  '',
  'Inline <img src="/api/health?inline-html" onerror="window.__pageRan = true"> loads nothing.',
  '',
  '<details open>',
  '<summary onclick="window.__pageRan = true">More</summary>',
  '',
  'Press <kbd>Ctrl</kbd> + <kbd>K</kbd> in [[Hostile page]].',
  '',
  '</details>',
  '',
  '<div style="color: red" onmouseover="window.__pageRan = true">',
  '<a id="setup"></a><a href="javascript:window.__pageRan=true">html link</a>',
  '<picture><source srcset="/api/health?source"><img src="https://example.com/tracker.png" alt="html picture"></picture>',
  '</div>',
  '',
  '| Cell | Value |',
  '| --- | --- |',
  '| <i>raw</i> | plain |',
  '',
  '```html',
  '<b>shown as code</b>',
  '```',
  '',
  '[script link](javascript:window.__pageRan=true)',
  '[data link](data:text/html,<script>parent.__pageRan=true</script>)',
  '[outside link](https://example.com/page)',
  '',
  '![remote picture](https://example.com/tracker.png)',
  '![relative picture](tracker.png)',
  '![rooted picture](/api/health?image)',
].join('\n');

test('a page’s Markdown runs nothing and loads nothing from elsewhere', async ({
  page,
  freshPage,
  admin,
}) => {
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Hostile page');
  await page.locator('#page-source').fill(SOURCE);
  await waitForSave(page);

  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
  const body = page.locator('.page-body');

  // Raw HTML renders without script, handlers or styles; a script shows as text, as on GitHub.
  const details = body.locator('details');
  await expect(body).toContainText('<script>window.__pageRan = true</script>');
  await expect(body.locator('script, picture, source, img:not([src^="blob:"])')).toHaveCount(0);
  await expect(body.locator('[style], [onclick], [onmouseover], [onerror]')).toHaveCount(0);

  // Unsafe links keep their words and lose their target; safe ones open apart.
  await expect(body.getByText('script link')).not.toHaveAttribute('href');
  await expect(body.getByText('data link')).not.toHaveAttribute('href');
  await expect(body.getByText('html link')).not.toHaveAttribute('href');
  await expect(body.locator('a[href]')).toHaveCount(2);
  const outside = body.getByRole('link', { name: 'outside link' });
  await expect(outside).toHaveAttribute('href', 'https://example.com/page');
  await expect(outside).toHaveAttribute('rel', 'noopener noreferrer');

  // Nothing runs on a click or a hover, and images that aren't attachments are never fetched.
  await details.locator('summary').click();
  await body.locator('div').filter({ hasText: 'html link' }).last().hover();
  expect(await page.evaluate(() => Reflect.get(window, '__pageRan'))).toBeUndefined();
  const origin = new URL(page.url()).origin;
  // Only the API, and the app's own worker that reads the page.
  const reader = new RegExp(`^${origin}/assets/markdown\\.worker-[\\w-]+\\.js$`);
  expect(requested.filter((url) => !url.startsWith(`${origin}/api/`) && !reader.test(url))).toEqual(
    [],
  );
  expect(requested.filter((url) => /tracker|health/.test(url))).toEqual([]);
});
