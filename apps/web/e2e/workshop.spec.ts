import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { adminTab, memberWithVault } from './vault';

const CALCULATOR = fileURLToPath(new URL('../../../examples/plugins/calculator', import.meta.url));

// The plugin workshop in the browser (ADR 0004), from a plugin draft to an
// installed plugin: the draft saved on the server, built by esbuild-wasm in
// the page's worker under the app's CSP, previewed from the draft route,
// built again after a reload, then published and installed. The draft
// comes from a project folder, so no AI provider takes part; the server
// only has to say AI is set up, which the workshop page asks first.
test('a plugin draft is built, previewed, opened again and published', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(120_000);
  await page.route('**/api/ai', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        style: 'openai',
        host: 'ai.example.com',
        model: 'model',
        maxOutputTokens: 1000,
      },
    }),
  );
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const status = page.getByRole('status', { name: 'Preview status' });
  const fromDraft = /^\/plugins\/calculator\/draft-[0-9a-f]{64}\/script\.js$/;

  // Its manifest and src/, without package.json or tsconfig.json.
  await page.goto('/workshop');
  const preview = page.waitForResponse(
    (response) => fromDraft.test(new URL(response.url()).pathname) && response.ok(),
  );
  await page.getByLabel('Project folder').setInputFiles(CALCULATOR);
  await expect(status).toContainText('Previewing v1', { timeout: 60_000 });
  await preview;
  await expect(page.getByRole('region', { name: 'Draft files' }).getByRole('button')).toHaveText([
    'src/script.ts',
    'wikistow-plugin.json',
  ]);

  // The conversation goes with the reload; the draft stays, and builds again.
  await page.reload();
  await page.goto('/workshop');
  await page
    .getByRole('listitem', { name: 'Calculator' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(status).toContainText('Previewing v1', { timeout: 60_000 });

  await status.getByRole('button', { name: 'Publish…' }).click();
  await page
    .getByRole('dialog', { name: 'Publish Calculator 0.1.0?' })
    .getByRole('button', { name: 'Publish' })
    .click();
  await expect(status).toContainText(
    'Published Calculator 0.1.0 and installed it on all your devices.',
  );
  await page.getByRole('link', { name: 'See it in the library' }).click();
  await page.getByRole('link', { name: 'Installed' }).click();
  await expect(
    page
      .getByRole('list', { name: 'Installed plugins' })
      .getByRole('switch', { name: 'Calculator enabled' }),
  ).toBeChecked();
});
