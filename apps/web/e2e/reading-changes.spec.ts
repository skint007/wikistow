import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { showIn, visual } from './editor';
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

  await test.step('the draft of a page left, opened straight from a link, has its ticks', async () => {
    await publishedPageIn(owner, 'Lists', 'Errands', '- [ ] post\n');
    const errands = new URL(owner.url());
    const published = owner.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes(`${errands.pathname.split('/p/')[1]}/publications`),
    );
    await box(owner, 'post').check();
    await openPage(owner, 'Shopping');
    await published;
    // Settled, with nothing showing the page any more.
    await owner.waitForTimeout(1000);
    // In the app, as a link to the draft goes there, not a fresh load.
    await owner.evaluate((path) => {
      history.pushState(history.state, '', path);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }, `${errands.pathname}?view=draft`);
    await expectSource(owner, '- [x] post\n');
    await owner.waitForTimeout(2000);
    await expect(owner.getByText(/Someone else saved/)).toHaveCount(0);
    await expectSource(owner, '- [x] post\n');
    await owner.getByRole('button', { name: 'Done' }).click();
    await expect(owner.getByText('Published v2')).toBeVisible();
    await openPage(owner, 'Chores');
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

const CALCULATOR = fileURLToPath(new URL('../../../examples/plugins/calculator', import.meta.url));

// A plugin ID belongs to the account that first uploads it, and the run
// shares one server: the workshop's own test publishes `calculator`.
const PLUGIN_ID = 'recipe-scaler';

const RECIPE = [
  '---',
  'servings: 4',
  '---',
  'Serves `=servings`.',
  '',
  `\`\`\`plugin:${PLUGIN_ID}/recipe`,
  'serves: 4',
  'amount: 500',
  '```',
  '',
].join('\n');

/**
 * Install the calculator example, as `PLUGIN_ID`, from a copy of its
 * folder through the plugin workshop, as `workshop.spec.ts` does, which
 * needs only the server to say AI is set up.
 */
async function installCalculator(page: Page) {
  const folder = await mkdtemp(join(tmpdir(), 'recipe-scaler-'));
  await cp(join(CALCULATOR, 'src'), join(folder, 'src'), { recursive: true });
  const manifest = JSON.parse(await readFile(join(CALCULATOR, 'wikistow-plugin.json'), 'utf8'));
  await writeFile(
    join(folder, 'wikistow-plugin.json'),
    JSON.stringify({ ...manifest, id: PLUGIN_ID }),
  );
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
  const status = page.getByRole('status', { name: 'Preview status' });
  await page.goto('/workshop');
  await page.getByLabel('Project folder').setInputFiles(folder);
  await expect(status).toContainText('Previewing v1', { timeout: 60_000 });
  await status.getByRole('button', { name: 'Publish…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(status).toContainText('installed it on all your devices.');
  await page.goto('/');
}

/**
 * A plugin block's field tied to a property (#212): in the reader it sets
 * the frontmatter through the same queue as ticks, making one version, and
 * in the visual editor it changes the draft's frontmatter, with `=servings`
 * following it both times.
 */
test('a block field tied to a property changes the frontmatter in the reader and the editor', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await installCalculator(page);
  await newFolder(page, 'Recipes');
  await publishedPageIn(page, 'Recipes', 'Bread', RECIPE);
  const block = page.locator('[data-plugin-block="recipe"]');
  const servings = block.getByLabel('Servings');

  await test.step('in the reader, one new version', async () => {
    await expect(servings).toHaveValue('4');
    await expect(page.getByText('Serves 4.')).toBeVisible();
    await expect(block.locator('output[data-output="scaled"]')).toHaveText('500');
    await servings.fill('6');
    // Not set until it's committed.
    await expect(page.getByText('Serves 4.')).toBeVisible();
    await servings.press('Enter');
    await expect(page.getByText('Serves 6.')).toBeVisible();
    await expect(block.locator('output[data-output="scaled"]')).toHaveText('750');
    await expect(page.getByText('Published v2')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(4000);
    await expect(page.getByText('Published v2')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Serves 6.')).toBeVisible();
    await expect(servings).toHaveValue('6');
  });

  await test.step('in the visual editor, the draft’s frontmatter', async () => {
    await page.getByRole('button', { name: 'Edit' }).click();
    await showIn(page, 'Visual');
    const field = visual(page).locator('.plugin-block').getByLabel('Servings');
    await expect(field).toHaveValue('6');
    await field.fill('8');
    await field.press('Enter');
    await waitForSave(page);
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByText('Published v3')).toBeVisible();
    await expect(page.getByText('Serves 8.')).toBeVisible();
    await expect(servings).toHaveValue('8');
  });
});
