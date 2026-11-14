// The extension in Chromium against a fake native host (fake-host.ts),
// which stands in for wikistow-clip-host and the app: what the popup says
// for each state the app can be in (ADR 0017, decision 7), what each mode
// captures from a live page (decision 5), the folder search (decision 6),
// and the context menu's quick send. The desktop app's own tests send the
// extension's clips to the real app (apps/desktop/e2e/clip.spec.ts).
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTS, type HostKey } from '../src/protocol.ts';
import type { Scenario } from './fake-host.ts';
import { TEST_ID } from './test-key.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION = join(ROOT, 'dist', 'chrome-test');
const FAKE_HOST = join(ROOT, 'e2e', 'fake-host.ts');
const SCREENSHOTS = process.env['SCREENSHOTS'];

// A 1×1 PNG, for the pages' images.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const WORDS =
  'Good bread needs only flour, water, salt and time, and a warm kitchen helps the dough rise. ';
const ARTICLE = `<!doctype html><html><head><title>Bread at home</title>
<meta property="og:site_name" content="The Bakery">
<style>.gone { display: none } .ghost { visibility: hidden }</style></head>
<body><nav><a href="/">Home</a> · <a href="/recipes">Recipes</a></nav>
<article>
<h1>Bread at home</h1>
<p class="byline">By Ann Baker</p>
${Array.from({ length: 6 }, () => `<p>${WORDS.repeat(4)}</p>`).join('\n')}
<p id="linked">Read <a href="/flour">the flour guide</a> first.</p>
<p><picture><source srcset="/shown.png"><img src="/fallback.png" alt="A loaf"></picture></p>
<p style="display: none">Hidden by its style</p>
<p class="gone">Hidden by the stylesheet</p>
<p id="ghosted"><span class="ghost">Invisible words</span> and visible words.</p>
<script>var secret = 'A script';</script>
</article></body></html>`;

// A long page with a box, half blue and half green, 300 by 150, far enough
// down that it's seen only once scrolled.
const SHOT = `<!doctype html><html><head><title>Boxes</title></head>
<body style="margin: 0; background: #fff">
<div style="height: 1200px"></div>
<div id="box" style="display: flex; width: 300px; height: 150px; margin-left: 100px">
<div style="flex: 1; background: #0000ff"></div><div style="flex: 1; background: #00ff00"></div>
</div>
<div style="height: 2000px"></div>
</body></html>`;

type Folder = { spaceId: string; folderId: string | null; path: string };
const PERSONAL: Folder = { spaceId: 'space1', folderId: null, path: 'Personal' };
const RECIPES: Folder = { spaceId: 'space1', folderId: 'folder1', path: 'Personal / Recipes' };
const SAVED = {
  type: 'saved' as const,
  spaceId: 'space1',
  pageId: 'page1',
  title: 'Bread at home',
  path: 'Personal / Recipes',
  images: { saved: 1, skipped: 0 },
  faithful: true,
};

let context: BrowserContext | null = null;
let site: Server | null = null;
test.afterEach(async () => {
  await context?.close();
  site?.closeAllConnections();
  site?.close();
  context = null;
  site = null;
});

/** The site to clip from, on this computer. */
async function serve() {
  site = createServer((request, response) => {
    if (request.url?.endsWith('.png')) {
      response.writeHead(200, { 'content-type': 'image/png' });
      return response.end(PNG);
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(request.url === '/shot' ? SHOT : ARTICLE);
  });
  await new Promise<void>((resolve) => site!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
}

/**
 * Chromium with the tests' build, and a fake host for each app named,
 * through the manifests a person's app would write in their profile.
 */
async function launch(
  apps: Partial<Record<HostKey, Scenario>>,
  { scale }: { scale?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'wikistow-clipper-'));
  const profile = join(dir, 'profile');
  await mkdir(join(profile, 'NativeMessagingHosts'), { recursive: true });
  for (const [key, scenario] of Object.entries(apps) as [HostKey, Scenario][]) {
    await writeFile(join(dir, `${key}.json`), JSON.stringify(scenario));
    const program = join(dir, `${key}.sh`);
    await writeFile(
      program,
      `#!/bin/sh\nFAKE_HOST_DIR='${dir}' FAKE_HOST_NAME=${key} exec '${process.execPath}' '${FAKE_HOST}' "$@"\n`,
    );
    await chmod(program, 0o755);
    await writeFile(
      join(profile, 'NativeMessagingHosts', `${HOSTS[key]}.json`),
      JSON.stringify({
        name: HOSTS[key],
        description: 'A fake WikiStow',
        path: program,
        type: 'stdio',
        allowed_origins: [`chrome-extension://${TEST_ID}/`],
      }),
    );
  }
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      // A high-DPI screen for real, rather than Playwright's emulation, which
      // the browser's own screenshot doesn't see.
      ...(scale ? [`--force-device-scale-factor=${scale}`, '--window-size=1000,800'] : []),
    ],
    ...(scale ? { viewport: null } : {}),
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return {
    context,
    worker,
    /** Change what the host's app says from now on. */
    set: async (key: HostKey, patch: Partial<Scenario>) => {
      const file = join(dir, `${key}.json`);
      const scenario = JSON.parse(await readFile(file, 'utf8')) as Scenario;
      await writeFile(file, JSON.stringify({ ...scenario, ...patch }));
    },
    /** Let a held clip answer go on. */
    release: (name: string) => writeFile(join(dir, name), ''),
    /** What the host got, of a type. */
    got: async (key: HostKey, type: string) =>
      (await readFile(join(dir, `${key}.log`), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((message) => message['type'] === type),
  };
}

/** Open the site's page, and the popup for it in a tab of its own, as the toolbar button would. */
async function popupFor(
  worker: Worker,
  origin: string,
  select?: (page: Page) => Promise<void>,
  path = '/bread',
) {
  const page = await context!.newPage();
  await page.goto(`${origin}${path}`);
  await select?.(page);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
    `${origin}${path}`,
  );
  const popup = await context!.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${TEST_ID}/popup.html?tab=${tabId}`);
  return { page, popup, tabId: tabId! };
}

/** The popup again, for the tab `tabId`, as the toolbar button opens it. */
async function reopen(tabId: number) {
  const popup = await context!.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await popup.goto(`chrome-extension://${TEST_ID}/popup.html?tab=${tabId}`);
  return popup;
}

const ready: Scenario = {
  app: 'ready',
  recent: [PERSONAL],
  folders: [PERSONAL, RECIPES],
  clip: [SAVED],
};

test('without the desktop app, clipping says it needs one', async () => {
  const { worker } = await launch({});
  const { popup } = await popupFor(worker, await serve());
  await expect(
    popup.getByText('Clipping needs the WikiStow desktop app on this computer.'),
  ).toBeVisible();
  await expect(popup.getByRole('link', { name: 'How to install it' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Save to WikiStow' })).toBeHidden();
});

test('an article goes to the folder found, and opens in WikiStow', async () => {
  const { worker, got } = await launch({ stable: ready });
  const origin = await serve();
  const { popup } = await popupFor(worker, origin);
  // With nothing selected, Article is chosen, and the recent folder.
  await expect(popup.getByRole('radio', { name: 'Article' })).toBeChecked();
  await expect(popup.getByRole('radio', { name: 'Selection' })).toBeDisabled();
  await expect(popup.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  await expect(popup.getByLabel('Title')).toHaveValue('Bread at home');
  await popup.getByLabel('Find a folder').fill('rec');
  await popup.getByRole('radio', { name: 'Personal / Recipes' }).check();
  await popup.getByLabel('Tags').fill('baking, bread, baking');
  if (SCREENSHOTS)
    await popup.locator('main').screenshot({ path: join(SCREENSHOTS, 'popup-ready.png') });
  // Chrome stops an idle service worker though the popup's port is open,
  // which closes it: the popup opens another.
  const devtools = await context!.newCDPSession(popup);
  await devtools.send('ServiceWorker.enable');
  await devtools.send('ServiceWorker.stopAllWorkers');
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(popup.getByText('Saved to Personal / Recipes')).toBeVisible();
  if (SCREENSHOTS)
    await popup.locator('main').screenshot({ path: join(SCREENSHOTS, 'popup-saved.png') });

  const [clip] = await got('stable', 'clip');
  expect(clip).toMatchObject({
    v: 1,
    mode: 'article',
    url: `${origin}/bread`,
    title: 'Bread at home',
    note: '',
    tags: ['baking', 'bread'],
    folder: { spaceId: 'space1', folderId: 'folder1' },
  });
  expect(clip!['byline']).toContain('Ann Baker');
  expect(clip!['siteName']).toBe('The Bakery');
  const html = String(clip!['html']);
  expect(html).toContain(WORDS.trim());
  expect(html).toContain(`href="${origin}/flour"`);
  expect(html).toContain(`src="${origin}/shown.png"`);
  expect(html).toContain('and visible words.');
  for (const hidden of [
    'Hidden by its style',
    'Hidden by the stylesheet',
    'Invisible words',
    'A script',
    'srcset',
  ]) {
    expect(html).not.toContain(hidden);
  }
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('✓');

  await popup.getByRole('button', { name: 'Open in WikiStow' }).click();
  await expect
    .poll(() => got('stable', 'show'))
    .toMatchObject([{ spaceId: 'space1', pageId: 'page1' }]);
  // Folder names stay in memory: on disk the extension keeps settings alone.
  expect(await worker.evaluate(() => chrome.storage.local.get(null))).toEqual({});
  expect(await worker.evaluate(() => chrome.storage.session.get('lastFolder'))).toEqual({
    lastFolder: RECIPES,
  });

  // What's typed for another page stays for the session, the saved clip notwithstanding.
  const other = await popupFor(worker, origin, undefined, '/other');
  await other.popup.getByLabel('Tags').fill('later');
  for (let again = 0; again < 2; again++) {
    await other.popup.reload();
    await expect(other.popup.getByLabel('Tags')).toHaveValue('later');
    await expect(other.popup.getByText('Saved to Personal / Recipes')).toBeVisible();
  }
});

test('a selection keeps what the page shows, and the whole page drops what it hides', async () => {
  const { worker, got } = await launch({ stable: ready });
  const origin = await serve();
  const { popup } = await popupFor(worker, origin, (page) =>
    page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.getElementById('linked')!, 0);
      range.setEnd(document.getElementById('ghosted')!, 2);
      getSelection()!.addRange(range);
    }),
  );
  await expect(popup.getByRole('radio', { name: 'Selection' })).toBeChecked();
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(popup.getByText('Saved to Personal / Recipes')).toBeVisible();
  await popup.getByRole('radio', { name: 'Whole page' }).check();
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect.poll(async () => (await got('stable', 'clip')).length).toBe(2);

  const [selection, page] = await got('stable', 'clip');
  expect(selection).toMatchObject({
    mode: 'selection',
    folder: { spaceId: 'space1', folderId: null },
  });
  const chosen = String(selection!['html']);
  expect(chosen).toContain(`<a href="${origin}/flour">the flour guide</a>`);
  expect(chosen).toContain(`src="${origin}/shown.png"`);
  expect(chosen).not.toContain('srcset');
  expect(chosen).toContain('and visible words.');
  expect(chosen).not.toContain(WORDS.trim());
  for (const hidden of ['Hidden by its style', 'Hidden by the stylesheet', 'Invisible words']) {
    expect(chosen).not.toContain(hidden);
  }
  expect(String(selection!['text'])).toContain('Read the flour guide first.');

  expect(page).toMatchObject({ mode: 'page' });
  const whole = String(page!['html']);
  expect(whole).toContain(`<a href="${origin}/recipes">Recipes</a>`);
  for (const hidden of [
    'Hidden by its style',
    'Hidden by the stylesheet',
    'Invisible words',
    'A script',
  ]) {
    expect(whole).not.toContain(hidden);
  }
});

test('a closed app opens from the popup, and a locked one gets the clip once unlocked', async () => {
  const { worker, set, release, got } = await launch({
    stable: {
      ...ready,
      app: 'closed',
      open: ['starting', 'locked'],
      clip: [{ hold: 'unlocked' }, SAVED],
    },
  });
  const origin = await serve();
  const { popup } = await popupFor(worker, origin);
  await expect(popup.getByText('WikiStow is closed.')).toBeVisible();
  await expect(popup.getByText('Open WikiStow to choose a folder.')).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Save to WikiStow' })).toBeDisabled();
  if (SCREENSHOTS)
    await popup.locator('main').screenshot({ path: join(SCREENSHOTS, 'popup-closed.png') });
  await popup.getByRole('button', { name: 'Open WikiStow' }).click();
  await expect(popup.getByText('Unlock WikiStow to choose a folder.')).toBeVisible();
  expect(await got('stable', 'open')).toHaveLength(1);

  // Unlocked, the folders come; a clip sent once it locks again waits for it.
  await set('stable', { app: 'ready' });
  await expect(popup.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  await set('stable', { app: 'locked' });
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(
    popup.getByText('Switch to WikiStow to unlock. The clip saves once it’s unlocked.'),
  ).toBeVisible();
  await expect(popup.getByText('Switch to WikiStow to unlock.', { exact: true })).toBeVisible();
  await release('unlocked');
  await expect(popup.getByText('Saved to Personal / Recipes')).toBeVisible();
});

test('the context menu sends to the last folder, opening a closed app first', async () => {
  const { worker, set, got } = await launch({ stable: ready });
  const origin = await serve();
  const { popup, tabId } = await popupFor(worker, origin);
  const menu = (id: string) =>
    worker.evaluate(
      async ([tabId, id]) =>
        globalThis.wikistowClipper!.menuClicked(
          { menuItemId: id, editable: false, pageUrl: '' },
          await chrome.tabs.get(tabId),
        ),
      [tabId, id] as const,
    );
  // Before any clip, there's no folder to send to.
  await menu('send-link');
  expect(await got('stable', 'clip')).toEqual([]);

  await popup.getByRole('radio', { name: 'Link' }).check();
  await popup.getByLabel('Note').fill('For the weekend');
  await popup.getByLabel('Find a folder').fill('rec');
  await popup.getByRole('radio', { name: 'Personal / Recipes' }).check();
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(popup.getByText('Saved to Personal / Recipes')).toBeVisible();
  await popup.close();

  await set('stable', { app: 'closed', open: ['starting', 'ready'] });
  await menu('send-link');
  const clips = await got('stable', 'clip');
  expect(clips).toHaveLength(2);
  expect(clips[0]).toMatchObject({ mode: 'link', note: 'For the weekend', html: '' });
  expect(clips[1]).toMatchObject({
    mode: 'link',
    note: '',
    title: 'Bread at home',
    url: `${origin}/bread`,
    folder: { spaceId: 'space1', folderId: 'folder1' },
  });
  expect(await got('stable', 'open')).toHaveLength(1);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('✓');
});

test('signed out, nothing is sent, and what was typed stays for the session', async () => {
  const { worker } = await launch({ stable: { ...ready, app: 'signed-out' } });
  const origin = await serve();
  const first = await popupFor(worker, origin);
  await expect(first.popup.getByText('Sign in to WikiStow first.')).toBeVisible();
  await expect(first.popup.getByRole('button', { name: 'Save to WikiStow' })).toBeDisabled();
  await first.popup.getByLabel('Title').fill('My bread');
  await first.popup.getByLabel('Tags').fill('later');
  await first.popup.close();
  const again = await context!.newPage();
  await again.goto(`chrome-extension://${TEST_ID}/popup.html?tab=${first.tabId}`);
  await expect(again.getByLabel('Title')).toHaveValue('My bread');
  await expect(again.getByLabel('Tags')).toHaveValue('later');
});

test('the beta is used when it alone is installed, and an app too new says to update', async () => {
  const { worker, got } = await launch({
    beta: { ...ready, protocols: { min: 2, max: 2 } },
  });
  const { popup } = await popupFor(worker, await serve());
  await expect(
    popup.getByText('This WikiStow is newer than the extension. Update the extension to clip.'),
  ).toBeVisible();
  expect(await got('beta', 'hello')).toMatchObject([{ browser: 'chromium', extension: '0.1.0' }]);
});

test('an app’s refusal shows in the popup and on the button', async () => {
  const { worker } = await launch({
    stable: {
      ...ready,
      clip: [
        {
          type: 'error' as const,
          code: 'no-folder',
          message: 'That folder is gone, or you can’t add pages to it. Choose another.',
        },
      ],
    },
  });
  const { popup } = await popupFor(worker, await serve());
  await expect(popup.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(
    popup.getByText('That folder is gone, or you can’t add pages to it. Choose another.'),
  ).toBeVisible();
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
});

/** A screenshot's size, and the colour at each of `points`, in its own pixels. */
async function pixels(page: Page, base64: string, points: [number, number][]) {
  return page.evaluate(
    async ([base64, points]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
      const drawn = canvas.getContext('2d')!;
      drawn.drawImage(image, 0, 0);
      const hex = (x: number, y: number) =>
        `#${[...drawn.getImageData(x, y, 1, 1).data.slice(0, 3)]
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('')}`;
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        colours: points.map(([x, y]) => hex(x, y)),
      };
    },
    [base64, points] as const,
  );
}

test('a screenshot of the visible area is the tab as shown, scrolled, in its device pixels', async () => {
  const { worker, got } = await launch({ stable: ready }, { scale: 2 });
  const origin = await serve();
  const { page, popup } = await popupFor(worker, origin, undefined, '/shot');
  await page.evaluate(() => scrollTo(0, 1000));
  await expect(popup.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  await popup.getByRole('radio', { name: 'Visible area' }).check();
  await expect(popup.getByLabel('Note')).toBeVisible();
  await popup.getByLabel('Note').fill('The boxes');
  if (SCREENSHOTS)
    await popup.locator('main').screenshot({ path: join(SCREENSHOTS, 'popup-screenshot.png') });
  // The toolbar's popup opens over the tab it clips, which stays the one shown.
  await page.bringToFront();
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(popup.getByText('Saved to Personal / Recipes')).toBeVisible();

  const [clip] = await got('stable', 'clip');
  expect(clip).toMatchObject({
    mode: 'screenshot',
    url: `${origin}/shot`,
    title: 'Boxes',
    note: 'The boxes',
    html: '',
    text: '',
    folder: { spaceId: 'space1', folderId: null },
  });
  const view = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    ratio: devicePixelRatio,
  }));
  expect(view.ratio).toBe(2);
  // The box is at 100, 200 in the tab once scrolled 1000 down.
  const shot = await pixels(page, String(clip!['screenshot']), [
    [175 * 2, 275 * 2],
    [325 * 2, 275 * 2],
    [50 * 2, 275 * 2],
  ]);
  expect(shot).toEqual({
    width: view.width * 2,
    height: view.height * 2,
    colours: ['#0000ff', '#00ff00', '#ffffff'],
  });
});

test('a screenshot of an area is the part dragged over, scrolled, in its device pixels', async () => {
  const { worker, got } = await launch({ stable: ready }, { scale: 2 });
  const origin = await serve();
  const { page, popup, tabId } = await popupFor(worker, origin, undefined, '/shot');
  await page.evaluate(() => scrollTo(0, 1000));
  // A dialog the page has open, modal, which makes the rest of it inert,
  // away from the box and with no backdrop, takes nothing from the overlay.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent =
      'dialog::backdrop { background: transparent } #modal { margin: 0; inset: 20px 20px auto auto }';
    const modal = document.createElement('dialog');
    modal.id = 'modal';
    modal.innerHTML = '<button>A button</button>';
    document.head.append(style);
    document.body.append(modal);
    modal.showModal();
  });
  await expect(popup.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  await popup.getByRole('radio', { name: 'Choose an area' }).check();
  await page.bringToFront();
  // The popup goes, for the person to drag over the page.
  const closed = popup.waitForEvent('close');
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await closed;
  const again = await reopen(tabId);
  await expect(
    again.getByText('Drag over the page to choose the area. Esc cancels.'),
  ).toBeVisible();
  await page.bringToFront();
  expect(await got('stable', 'clip')).toEqual([]);
  // The person may take a while: Chrome stops the idle service worker, and
  // the overlay's message wakes it again, with the area chosen kept.
  const devtools = await context!.newCDPSession(again);
  await devtools.send('ServiceWorker.enable');
  await devtools.send('ServiceWorker.stopAllWorkers');

  // Exactly over the box, at 100, 200 in the tab.
  await page.mouse.move(100, 200);
  await page.mouse.down();
  await page.mouse.move(250, 300, { steps: 5 });
  await page.mouse.move(400, 350, { steps: 5 });
  if (SCREENSHOTS) await page.screenshot({ path: join(SCREENSHOTS, 'area-choosing.png') });
  await page.mouse.up();
  await expect(again.getByText('Saved to Personal / Recipes')).toBeVisible();
  // The overlay was gone before the screenshot, and is gone from the page.
  expect(await page.evaluate(() => document.documentElement.children.length)).toBe(2);
  expect(await page.evaluate(() => scrollY)).toBe(1000);

  const [clip] = await got('stable', 'clip');
  expect(clip).toMatchObject({ mode: 'screenshot', url: `${origin}/shot`, html: '' });
  const shot = await pixels(page, String(clip!['screenshot']), [
    [0, 0],
    [299, 150],
    [300, 150],
    [599, 299],
  ]);
  expect(shot).toEqual({
    width: 600,
    height: 300,
    colours: ['#0000ff', '#0000ff', '#00ff00', '#00ff00'],
  });
});

test('Escape stops choosing an area, sending nothing', async () => {
  const { worker, got } = await launch({ stable: ready });
  const origin = await serve();
  const { page, popup, tabId } = await popupFor(worker, origin, undefined, '/shot');
  await expect(popup.getByRole('radio', { name: 'Personal', exact: true })).toBeChecked();
  await popup.getByRole('radio', { name: 'Choose an area' }).check();
  await page.bringToFront();
  const closed = popup.waitForEvent('close');
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await closed;
  const again = await reopen(tabId);
  await expect(
    again.getByText('Drag over the page to choose the area. Esc cancels.'),
  ).toBeVisible();
  await page.bringToFront();
  // A click alone isn't an area: it keeps choosing.
  await page.mouse.click(300, 300);
  expect(await page.evaluate(() => document.documentElement.children.length)).toBe(3);
  await page.keyboard.press('Escape');
  await expect(again.getByText('Drag over the page to choose the area. Esc cancels.')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.children.length)).toBe(2);
  expect(await got('stable', 'clip')).toEqual([]);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');

  // An overlay that went with its page leaves the popup nothing to wait for.
  const third = await reopen(tabId);
  await third.getByRole('radio', { name: 'Choose an area' }).check();
  await page.bringToFront();
  const gone = third.waitForEvent('close');
  await third.getByRole('button', { name: 'Save to WikiStow' }).click();
  await gone;
  await expect.poll(() => page.evaluate(() => document.documentElement.children.length)).toBe(3);
  await page.reload();
  const fourth = await reopen(tabId);
  await expect(fourth.getByRole('button', { name: 'Save to WikiStow' })).toBeVisible();
  await expect
    .poll(() => worker.evaluate(() => chrome.storage.session.get(['clip', 'choosing'])))
    .toEqual({});
  await expect(
    fourth.getByText('Drag over the page to choose the area. Esc cancels.'),
  ).toBeHidden();
});
