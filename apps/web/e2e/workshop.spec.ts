import { fileURLToPath } from 'node:url';
import { expect, secretsOnServer, test } from './fixtures';
import { adminTab, fillSource, memberWithVault, newPage, waitForSave } from './vault';

const CALCULATOR = fileURLToPath(new URL('../../../examples/plugins/calculator', import.meta.url));
// A 1×1 PNG, as a font or image the person adds (#313).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// The plugin workshop in the browser (ADR 0004), from a plugin draft to an
// installed plugin: the draft saved on the server, built by esbuild-wasm in
// the page's worker under the app's CSP, previewed from the draft route,
// built again after a reload, then published and installed, with an
// image the person added carried at its top and under source/. The draft
// comes from a project folder, so no AI provider takes part; the server
// only has to say AI is set up, which the workshop page asks first, and
// one reply is faked. Its conversation, versions and sample page come back
// after the reload (#314), until Clear conversation, while a real page
// copied into the preview never reaches the server.
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
  await newPage(page, 'Family recipes');
  await fillSource(page, 'Grandma adds cardamom.');
  await waitForSave(page);
  const real = new URL(page.url()).pathname;
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
  const files = page.getByRole('region', { name: 'Draft files' });
  await expect(files.getByRole('group', { name: 'Files' }).getByRole('button')).toHaveText([
    'src/script.ts',
    'wikistow-plugin.json',
  ]);

  // An image the person adds is kept as bytes, and builds into the next version.
  await files
    .getByLabel('Font or image')
    .setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: PNG });
  await expect(status).toContainText('Previewing v2', { timeout: 60_000 });

  // A reply that reads the preview, with a real page copied in, and writes a sample page.
  let steps = 0;
  await page.route('**/api/ai/stream', (route) => {
    steps += 1;
    const events =
      steps === 1
        ? [
            { type: 'tool-call', call: { id: 'call-1', name: 'read_preview', input: {} } },
            {
              type: 'tool-call',
              call: {
                id: 'call-2',
                name: 'write_sample_page',
                input: { title: 'Prices', markdown: 'Two at 3.' },
              },
            },
            { type: 'finish', reason: 'tool-calls' },
          ]
        : [
            { type: 'text', text: 'I added a sample page.' },
            { type: 'finish', reason: 'stop' },
          ];
    return route.fulfill({
      contentType: 'application/x-ndjson',
      body: events.map((event) => `${JSON.stringify(event)}\n`).join(''),
    });
  });
  const conversation = page.getByRole('complementary', { name: 'Assistant' });
  // Back to the real page in the app, so the workshop stays open.
  await page.evaluate((path) => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, real);
  await conversation
    .getByRole('button', { name: 'Copy “Family recipes” into the preview' })
    .click();
  await expect(
    conversation.getByRole('button', { name: 'Copied “Family recipes” into the preview' }),
  ).toBeVisible();
  await conversation.getByLabel('Message').fill('Add a sample page');
  await conversation.getByRole('button', { name: 'Send' }).click();
  await expect(conversation.getByText('I added a sample page.')).toBeVisible();
  await conversation.getByRole('link', { name: 'Open the preview' }).click();
  const samples = page.getByRole('region', { name: 'Sample pages' });
  await expect(samples.getByRole('button', { name: 'Prices' })).toBeVisible();
  // Kept with the draft as the reply ends.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { drafts } = (await (await fetch('/api/plugin-drafts')).json()) as {
          drafts: { id: string }[];
        };
        return fetch(`/api/plugin-drafts/${drafts[0]?.id}/workshop`).then((r) => r.text());
      }),
    )
    .toContain('I added a sample page.');
  // Neither the copy's text nor its title went with it.
  expect(await secretsOnServer(['Family recipes', 'cardamom'])).toEqual([]);

  // After a reload the draft builds again, as the version it was, with its conversation and sample.
  await page.reload();
  await page.goto('/workshop');
  await page
    .getByRole('listitem', { name: 'Calculator' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(status).toContainText('Previewing v2', { timeout: 60_000 });
  await expect(page.getByRole('listitem', { name: 'Version 1' })).toContainText('Build not kept');
  await expect(conversation.getByText('Add a sample page')).toBeVisible();
  await expect(conversation.getByText('I added a sample page.')).toBeVisible();
  await expect(
    conversation.getByText('Copied one of your pages into the preview. The copy isn’t kept.'),
  ).toBeVisible();
  await expect(samples.getByRole('button', { name: 'Prices' })).toBeVisible();
  await expect(samples.getByRole('button', { name: 'Family recipes' })).toHaveCount(0);

  // Clear conversation starts over on the draft's files, the image among them.
  await conversation.getByRole('button', { name: 'Clear conversation' }).click();
  await page
    .getByRole('dialog', { name: 'Clear the conversation?' })
    .getByRole('button', { name: 'Clear conversation' })
    .click();
  await expect(status).toContainText('Previewing v1', { timeout: 60_000 });
  await expect(conversation.getByText('I added a sample page.')).toHaveCount(0);
  await expect(samples.getByRole('button', { name: 'Prices' })).toHaveCount(0);

  await status.getByRole('button', { name: 'Publish…' }).click();
  await page
    .getByRole('dialog', { name: 'Publish Calculator 0.1.0?' })
    .getByRole('button', { name: 'Publish' })
    .click();
  await expect(status).toContainText(
    'Published Calculator 0.1.0 and installed it on all your devices.',
  );
  // Read back after the reload, the image went into the published version.
  const published = await page.evaluate(async () => {
    const listing = (await (await fetch('/api/plugins?manifest=3')).json()) as {
      plugins: { id: string; versions: { files: string[] }[] }[];
    };
    return listing.plugins.find((plugin) => plugin.id === 'calculator')?.versions[0]?.files;
  });
  expect(published).toEqual(expect.arrayContaining(['icon.png', 'source/public/icon.png']));

  await page.getByRole('link', { name: 'See it in the library' }).click();
  await page.getByRole('link', { name: 'Installed' }).click();
  await expect(
    page
      .getByRole('list', { name: 'Installed plugins' })
      .getByRole('switch', { name: 'Calculator enabled' }),
  ).toBeChecked();
});
