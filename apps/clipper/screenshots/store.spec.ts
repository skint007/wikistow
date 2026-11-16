// The pictures for the Chrome Web Store and Mozilla Add-ons listings
// (docs/web-clipper-store-listing.md), made from the tests' build against
// the fake host (e2e/fake-host.ts), as the e2e tests run it. Each
// screenshot is 1280 by 800, the size both stores take: the site's page as
// a browser shows it, under a plain toolbar, with the popup open below the
// extension's button. Beside them, Chrome's store icon (128 by 128), small
// promo tile (440 by 280) and marquee (1400 by 560). Run by
// playwright.config.ts here.
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTS } from '../src/protocol.ts';
import type { Scenario } from '../e2e/fake-host.ts';
import { TEST_ID } from '../e2e/test-key.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = join(ROOT, 'dist', 'chrome-test');
const FAKE_HOST = join(ROOT, 'e2e', 'fake-host.ts');
const OUT = join(ROOT, '..', '..', 'docs', 'screenshots', 'clipper');
const WIDTH = 1280;
const HEIGHT = 800;
const TOOLBAR = 44;
const ADDRESS = 'bakery.example/bread-at-home';

const PARAGRAPHS = [
  'Good bread needs only flour, water, salt and time. A warm kitchen helps the dough rise, but a cool one gives it more flavour, if you can wait for it.',
  'Mix the flour and water first, and leave them for half an hour before the salt and the yeast go in. The flour takes up the water, and the dough comes together with less kneading.',
  'Knead it until it is smooth and springs back when pressed, about ten minutes by hand. Then cover the bowl and leave it somewhere draught-free until it has doubled.',
  'Shape the loaf gently, so as to keep the air in, and give it a second, shorter rise in a floured basket. Bake it hot, with steam for the first twenty minutes, until it sounds hollow underneath.',
];
const ARTICLE = `<!doctype html><html lang="en"><head><title>Bread at home</title>
<meta property="og:site_name" content="The Bakery">
<style>
body { margin: 0; font: 19px/1.6 Georgia, 'Times New Roman', serif; color: #2b2622; background: #fbf8f3 }
header { display: flex; gap: 28px; align-items: center; padding: 18px 64px; background: #fff; border-bottom: 1px solid #ebe3d6; font: 600 16px system-ui, sans-serif }
header strong { font-size: 20px; color: #8a4b1f; margin-right: auto }
header a { color: #5c5249; text-decoration: none }
article { max-width: 680px; margin: 40px 64px }
h1 { font-size: 44px; line-height: 1.15; margin: 0 0 8px }
.byline { color: #7a6f65; font: 15px system-ui, sans-serif; margin-bottom: 28px }
</style></head>
<body><header><strong>The Bakery</strong><a href="/">Recipes</a><a href="/">Techniques</a><a href="/">About</a></header>
<article><h1>Bread at home</h1><p class="byline">By Ann Baker · 6 min read</p>
${PARAGRAPHS.map((text, at) => `<p id="p${at}">${text}</p>`).join('\n')}
</article></body></html>`;

const PERSONAL = { spaceId: 'space1', folderId: null, path: 'Personal' };
const RECIPES = { spaceId: 'space1', folderId: 'folder1', path: 'Personal / Recipes' };
const SAVED = {
  type: 'saved' as const,
  spaceId: 'space1',
  pageId: 'page1',
  title: 'Bread at home',
  path: 'Personal / Recipes',
  images: { saved: 0, skipped: 0 },
  faithful: true,
};
const READY: Scenario = {
  app: 'ready',
  recent: [PERSONAL, RECIPES],
  folders: [PERSONAL, RECIPES],
  clip: [SAVED],
};

test.skip(!process.env['STORE_SCREENSHOTS'], 'set STORE_SCREENSHOTS=1 to make them');

let context: BrowserContext | null = null;
let site: Server | null = null;
test.afterEach(async () => {
  await context?.close();
  site?.closeAllConnections();
  site?.close();
  context = null;
  site = null;
});

/** Chromium with the tests' build, and a fake WikiStow behind the stable app's host. */
async function launch(scenario: Scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'wikistow-clipper-shots-'));
  const profile = join(dir, 'profile');
  await mkdir(join(profile, 'NativeMessagingHosts'), { recursive: true });
  await writeFile(join(dir, 'stable.json'), JSON.stringify(scenario));
  const program = join(dir, 'stable.sh');
  await writeFile(
    program,
    `#!/bin/sh\nFAKE_HOST_DIR='${dir}' FAKE_HOST_NAME=stable exec '${process.execPath}' '${FAKE_HOST}' "$@"\n`,
  );
  await chmod(program, 0o755);
  await writeFile(
    join(profile, 'NativeMessagingHosts', `${HOSTS.stable}.json`),
    JSON.stringify({
      name: HOSTS.stable,
      description: 'A fake WikiStow',
      path: program,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${TEST_ID}/`],
    }),
  );
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    colorScheme: 'light',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  site = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(ARTICLE);
  });
  await new Promise<void>((resolve) => site!.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/bread`;
  const page = await context.newPage();
  await page.setViewportSize({ width: WIDTH, height: HEIGHT - TOOLBAR });
  await page.goto(url);
  const tabId = await worker.evaluate(
    async (address) => (await chrome.tabs.query({})).find((tab) => tab.url === address)?.id,
    url,
  );
  return { page, tabId: tabId! };
}

/** The popup for the tab, as the toolbar's button opens it. */
async function popupFor(tabId: number) {
  const popup = await context!.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${TEST_ID}/popup.html?tab=${tabId}`);
  return popup;
}

const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

/** The page under a toolbar, with the popup below the extension's button if given. */
async function compose(name: string, page: Buffer, popup?: Buffer) {
  const icon = await readFile(join(ROOT, 'icons', 'icon-32.png'));
  const canvas = await context!.newPage();
  await canvas.setViewportSize({ width: WIDTH, height: HEIGHT });
  await canvas.setContent(`<!doctype html><html><body style="margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative; font: 14px system-ui, sans-serif">
<div style="height: ${TOOLBAR}px; box-sizing: border-box; display: flex; align-items: center; gap: 12px; padding: 0 12px; background: #f1ede8; border-bottom: 1px solid #ddd5c8">
  <div style="flex: 1; height: 30px; border-radius: 15px; background: #fff; display: flex; align-items: center; padding: 0 16px; color: #4a443e">${ADDRESS}</div>
  <img src="${dataUrl(icon)}" width="20" height="20" style="padding: 4px; border-radius: 6px; background: ${popup ? '#e3ddd4' : 'transparent'}">
</div>
<img src="${dataUrl(page)}" style="display: block">
${popup ? `<img src="${dataUrl(popup)}" style="position: absolute; top: ${TOOLBAR + 4}px; right: 8px; border: 1px solid #d6cec2; border-radius: 8px; box-shadow: 0 10px 32px rgba(45, 42, 38, 0.22)">` : ''}
</body></html>`);
  await canvas.screenshot({ path: join(OUT, `${name}.png`) });
  await canvas.close();
}

const shot = (page: Page) => page.screenshot({ animations: 'disabled' });

/** The popup as shown, with nothing focused. */
async function popupShot(popup: Page) {
  await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return popup.locator('main').screenshot({ animations: 'disabled' });
}

test('an article, to a folder found by name', async () => {
  const { page, tabId } = await launch(READY);
  const popup = await popupFor(tabId);
  await expect(popup.getByRole('radio', { name: 'Article' })).toBeChecked();
  await popup.getByLabel('Find a folder').fill('rec');
  await popup.getByRole('radio', { name: 'Personal / Recipes' }).check();
  await popup.getByLabel('Tags').fill('baking, bread');
  await compose('1-article', await shot(page), await popupShot(popup));
});

test('the selection', async () => {
  const { page, tabId } = await launch(READY);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('p1')!);
    getSelection()!.addRange(range);
  });
  const popup = await popupFor(tabId);
  await expect(popup.getByRole('radio', { name: 'Selection' })).toBeChecked();
  await popup.getByRole('radio', { name: 'Personal / Recipes' }).check();
  await popup.getByLabel('Tags').fill('bread, method');
  await compose('2-selection', await shot(page), await popupShot(popup));
});

test('saved, as a draft in WikiStow', async () => {
  const { page, tabId } = await launch(READY);
  const popup = await popupFor(tabId);
  await popup.getByRole('radio', { name: 'Personal / Recipes' }).check();
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(popup.getByText('Saved to Personal / Recipes')).toBeVisible();
  await compose('3-saved', await shot(page), await popupShot(popup));
});

test('a screenshot of an area, dragged over the page', async () => {
  const { page, tabId } = await launch(READY);
  const popup = await popupFor(tabId);
  await popup.getByRole('radio', { name: 'Personal / Recipes' }).check();
  await popup.getByRole('radio', { name: 'Choose an area' }).check();
  await page.bringToFront();
  const closed = popup.waitForEvent('close');
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await closed;
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(3);
  const box = (await page.locator('h1').boundingBox())!;
  await page.mouse.move(box.x - 16, box.y - 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 500, box.y + 200, { steps: 5 });
  await page.mouse.move(box.x + 700, box.y + 330, { steps: 5 });
  await compose('4-area', await shot(page));
  await page.keyboard.press('Escape');
});

/**
 * Chrome's images beside the screenshots: the store's icon, 128 by 128
 * with the artwork 96 by 96 inside, and the promo tile and marquee, with
 * the icon, the name and what it does, in the app's colours.
 */
for (const [name, width, height, text] of [
  ['store-icon', 128, 128, 0],
  ['promo-small', 440, 280, 1],
  ['promo-marquee', 1400, 560, 2.2],
] as const) {
  test(`the ${name} image`, async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width, height } });
    const icon = await readFile(join(ROOT, 'icons', 'icon-128.png'));
    const size = text ? Math.min(128, 96 * text) : 96;
    await page.setContent(`<!doctype html><html><body style="margin: 0; width: ${width}px; height: ${height}px; display: flex; align-items: center; justify-content: center; gap: ${28 * text}px; background: ${text ? '#fff0ea' : 'transparent'}; color: #2d2a26; font-family: system-ui, sans-serif">
<img src="${dataUrl(icon)}" width="${size}" height="${size}">
${text ? `<div><div style="font-size: ${30 * text}px; font-weight: 700; line-height: 1.1">WikiStow<br>Web Clipper</div><div style="margin-top: ${10 * text}px; font-size: ${15 * text}px; color: #71695f">Save pages to your own wiki, as drafts</div></div>` : ''}
</body></html>`);
    await page.screenshot({ path: join(OUT, `${name}.png`), omitBackground: !text });
    await browser.close();
  });
}
