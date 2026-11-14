// The web clipper's path through the desktop app (ADR 0017, steps 2, 4
// and 5): an extension in Chromium starts wikistow-clip-host through the
// manifest the app wrote, the helper reaches the running app on its
// socket, and a clip sent through it becomes a draft, its image fetched
// from the clipped site and attached, at once or once the vault unlocks.
// The first test speaks the protocol from a stand-in extension; the
// second clips with the real one (apps/clipper), through its popup.
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../web/e2e/fixtures';
import { adminTab, memberWithVault, PASSPHRASE, PNG, sourceOf } from '../../web/e2e/vault';
import { TEST_ID } from '../../clipper/e2e/test-key';
import { accountMenu, launch, signInThroughBrowser, type Desktop } from './desktop';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// scripts/clip-host.sh builds it; CI's build job does, for this job too.
const HELPER = join(APP_DIR, 'out', 'clip-host', 'linux-amd64', 'wikistow-clip-host');
const EXTENSION = join(APP_DIR, 'e2e', 'clip-extension');
// The real extension's tests' build (`pnpm -C apps/clipper build`), with the same key.
const CLIPPER = join(APP_DIR, '..', 'clipper', 'dist', 'chrome-test');
// The ID both manifests' key gives them.
const ORIGIN = `chrome-extension://${TEST_ID}/`;
const HOST = 'io.github.skint007.wikistow';
const { version } = JSON.parse(await readFile(join(APP_DIR, 'package.json'), 'utf8')) as {
  version: string;
};

/** This process's environment, without the names it has no value for. */
const definedEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

type Conversation = { received: Record<string, unknown>[]; error?: string | null };

let desktop: Desktop | null = null;
let browser: BrowserContext | null = null;
let site: Server | null = null;
test.afterEach(async () => {
  await desktop?.app.close().catch(() => {});
  await browser?.close().catch(() => {});
  site?.closeAllConnections();
  site?.close();
  desktop = null;
  browser = null;
  site = null;
});

const WORDS = 'Some words about the cat, who sat on the warm mat all afternoon. ';
/** A page Readability takes as an article, with an image. */
const STORY = `<!doctype html><html><head><title>A clipped story</title></head><body>
<nav><a href="/">Home</a></nav><article><h1>The story</h1>
${Array.from({ length: 4 }, () => `<p>${WORDS.repeat(3)}</p>`).join('')}
<p><img src="/cat.png" alt="A cat"></p></article></body></html>`;

/** A site to clip from, on this computer, serving a page and its image, and every request it got. */
async function clippedSite() {
  const requests: IncomingMessage[] = [];
  site = createServer((request, response) => {
    requests.push(request);
    if (request.url === '/cat.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      return response.end(PNG);
    }
    if (request.url === '/story') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(STORY);
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => site!.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(site.address() as AddressInfo).port}`, requests };
}

/** Send messages from the extension's service worker, and take `count` answers. */
const converse = (worker: Worker, messages: object[], count = 1) =>
  worker.evaluate(
    ([host, messages, count]) =>
      (
        globalThis as unknown as {
          converse: (host: string, messages: object[], count: number) => Promise<Conversation>;
        }
      ).converse(host, messages, count),
    [HOST, messages, count] as const,
  );

/**
 * The app, clipping: in a home and config folder of the test's own, which
 * the app writes the manifests into and the helper finds the app's
 * clip-host.json through. The browser's profile is its folder there, as a
 * person's Chromium is.
 */
async function clippingApp() {
  const root = await mkdtemp(join(tmpdir(), 'wikistow-clip-'));
  const home = join(root, 'home');
  const config = join(root, 'config');
  await mkdir(join(config, 'chromium'), { recursive: true });
  await mkdir(join(home, '.mozilla'), { recursive: true });
  const env = { ...definedEnv(), HOME: home, XDG_CONFIG_HOME: config };
  const profile = join(config, 'WikiStow');
  const app = await launch(
    profile,
    ['--clip-manifests', `--clip-extension=${ORIGIN}`],
    undefined,
    env,
  );
  return { app, home, config, env, profile };
}

/** Sign the app in through the browser, and unlock its vault. */
async function signInAndUnlock(app: Desktop, page: Page, baseURL: string) {
  await signInThroughBrowser(app, page, baseURL);
  await app.window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await app.window.getByRole('button', { name: 'Unlock' }).click();
  await expect(app.window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
}

test('an extension reaches the app through the helper', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.skip(process.platform !== 'linux', 'The helper is built for Linux here');
  test.setTimeout(180_000);
  expect(existsSync(HELPER), 'Build the helper first: scripts/clip-host.sh').toBe(true);
  await memberWithVault(page, await adminTab(freshPage, admin.email));

  const { app, home, config, env, profile } = await clippingApp();
  desktop = app;
  await expect(desktop.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const chromiumManifest = join(config, 'chromium', 'NativeMessagingHosts', `${HOST}.json`);
  const firefoxManifest = join(home, '.mozilla', 'native-messaging-hosts', `${HOST}.json`);
  const hostFile = join(profile, 'clip-host.json');
  await expect.poll(() => existsSync(chromiumManifest)).toBe(true);
  expect(JSON.parse(await readFile(chromiumManifest, 'utf8'))).toEqual({
    name: HOST,
    description: 'WikiStow web clipper',
    path: HELPER,
    type: 'stdio',
    allowed_origins: [ORIGIN],
  });
  // No Firefox extension is published, or added for this launch.
  expect(existsSync(firefoxManifest)).toBe(false);
  expect((await stat(hostFile)).mode & 0o777).toBe(0o600);

  browser = await chromium.launchPersistentContext(join(config, 'chromium'), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    env,
  });
  const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'));

  const hello = { v: 1, id: 'a', type: 'hello', extension: '0.0.1', browser: 'chromium' };
  expect(await converse(worker, [hello])).toEqual({
    received: [
      {
        v: 1,
        id: 'a',
        type: 'status',
        app: 'signed-out',
        offline: false,
        appVersion: version,
        protocols: { min: 1, max: 1 },
      },
    ],
  });
  // `open` to a running app shows its window and says its state.
  expect((await converse(worker, [{ v: 1, id: 'b', type: 'open' }])).received).toMatchObject([
    { id: 'b', type: 'status', app: 'signed-out' },
  ]);
  // Signed out, a clip is refused, and so is a folder search.
  const somewhere = { spaceId: 'space1', folderId: null };
  const early = { v: 1, id: 'c', type: 'clip', mode: 'link', url: 'https://a.test/', title: 'A' };
  expect((await converse(worker, [{ ...early, folder: somewhere }])).received).toMatchObject([
    { id: 'c', type: 'error', code: 'signed-out' },
  ]);
  expect(
    (await converse(worker, [{ v: 1, id: 'f', type: 'folders', query: 'Per' }])).received,
  ).toMatchObject([{ id: 'f', type: 'error', code: 'signed-out' }]);

  await signInAndUnlock(desktop, page, baseURL ?? '');
  // Signed in and unlocked, as the page tells main.
  await expect
    .poll(async () => (await converse(worker, [hello])).received)
    .toMatchObject([{ app: 'ready', offline: false }]);

  // Folders are searched: the top of the space they made, by its name.
  const search = await converse(worker, [{ v: 1, id: 'f', type: 'folders', query: 'perso' }]);
  const [found] = search.received as { matches: { spaceId: string; folderId: null }[] }[];
  expect(search.received).toEqual([
    {
      v: 1,
      id: 'f',
      type: 'folders',
      recent: [],
      matches: [{ spaceId: expect.any(String), folderId: null, path: 'Personal' }],
    },
  ]);
  const personal = { spaceId: found!.matches[0]!.spaceId, folderId: null };

  // A clip: an article with an image on the site it came from.
  const { origin, requests } = await clippedSite();
  const article = {
    v: 1,
    id: 'c',
    type: 'clip',
    mode: 'article',
    url: `${origin}/story`,
    title: 'A clipped story',
    html: `<h1>The story</h1><p>Some words.</p><p><img src="${origin}/cat.png" alt="A cat"></p>`,
    text: 'The story Some words.',
    tags: ['clipped'],
    byline: 'Ann Writer',
    folder: personal,
  };
  const clipped = await converse(worker, [article], 2);
  expect(clipped.received).toEqual([
    { v: 1, id: 'c', type: 'accepted', waits: null },
    {
      v: 1,
      id: 'c',
      type: 'saved',
      spaceId: personal.spaceId,
      pageId: expect.any(String),
      title: 'A clipped story',
      path: 'Personal',
      images: { saved: 1, skipped: 0 },
      faithful: true,
    },
  ]);
  const { pageId } = clipped.received[1] as { pageId: string };
  // The app fetched the image itself, with no cookie, naming only the page's origin.
  expect(requests.map((request) => request.url)).toEqual(['/cat.png']);
  expect(requests[0]?.headers.cookie).toBeUndefined();
  expect(requests[0]?.headers.referer).toBe(`${origin}/`);
  await expect(desktop.window.getByText('Saved “A clipped story” to Personal')).toBeVisible();

  // `show` opens the draft, which holds the clip, its properties and its image.
  expect(
    (await converse(worker, [{ v: 1, id: 's', type: 'show', spaceId: personal.spaceId, pageId }]))
      .received,
  ).toEqual([{ v: 1, id: 's', type: 'shown' }]);
  await expect(desktop.window.locator('#page-title')).toHaveValue('A clipped story');
  await expect
    .poll(() => sourceOf(desktop!.window))
    .toMatch(/^# The story\n\nSome words\.\n\n!\[A cat\]\(attachment:[\w-]{22}\)\n$/);
  const properties = desktop.window.getByRole('region', { name: 'Properties' });
  const opener = properties.getByRole('button', { name: /^Properties/ });
  if ((await opener.getAttribute('aria-expanded')) === 'false') await opener.click();
  // Each row's button is named for its property and value; a tag is a pill.
  for (const row of [`Source: ${origin}/story`, 'Clipped:', 'Author: Ann Writer']) {
    await expect(properties.getByRole('button', { name: row })).toBeVisible();
  }
  await expect(properties.getByRole('button', { name: 'Remove clipped from Tags' })).toBeVisible();
  // Only a draft clipped this session opens that way.
  expect(
    (
      await converse(worker, [
        { v: 1, id: 's', type: 'show', spaceId: personal.spaceId, pageId: 'other1' },
      ])
    ).received,
  ).toMatchObject([{ id: 's', type: 'error', code: 'not-allowed' }]);

  // Locked, a clip waits, and saves once unlocked.
  await accountMenu(desktop.window, 'Lock vault');
  await expect(desktop.window.getByLabel('Vault passphrase')).toBeVisible();
  await expect
    .poll(async () => (await converse(worker, [hello])).received)
    .toMatchObject([{ app: 'locked' }]);
  expect(
    (await converse(worker, [{ v: 1, id: 'f', type: 'folders', query: 'perso' }])).received,
  ).toMatchObject([{ id: 'f', type: 'error', code: 'locked' }]);
  const link = {
    v: 1,
    id: 'w',
    type: 'clip',
    mode: 'link',
    url: 'https://example.com/later',
    title: 'Read later',
    note: 'For the weekend',
    folder: personal,
  };
  const waiting = converse(worker, [link], 2);
  await expect(
    desktop.window.getByText('1 clip waits to be saved from your browser.'),
  ).toBeVisible();
  await desktop.window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await desktop.window.getByRole('button', { name: 'Unlock' }).click();
  expect((await waiting).received).toMatchObject([
    { id: 'w', type: 'accepted', waits: 'unlock' },
    {
      id: 'w',
      type: 'saved',
      title: 'Read later',
      path: 'Personal',
      images: { saved: 0, skipped: 0 },
    },
  ]);
  await expect(desktop.window.getByText('Saved “Read later” to Personal')).toBeVisible();

  // Turning it off closes the socket and deletes the manifests.
  await desktop.window.getByRole('link', { name: 'Settings' }).first().click();
  const row = desktop.window.getByRole('heading', { name: 'Browser clipping' });
  await expect(row).toHaveAccessibleDescription(
    'The WikiStow extension in Chromium can save pages here as drafts.',
  );
  // This session's clips, newest first, each a link to its draft.
  await expect(
    desktop.window.getByRole('list', { name: 'Clipped since WikiStow opened' }).getByRole('link'),
  ).toHaveText(['Read later', 'A clipped story']);
  const toggle = desktop.window.getByRole('switch', { name: 'Browser clipping' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(row).toHaveAccessibleDescription(
    'Browser extensions can’t reach WikiStow on this computer.',
  );
  expect(existsSync(chromiumManifest) || existsSync(firefoxManifest) || existsSync(hostFile)).toBe(
    false,
  );
  expect(await converse(worker, [hello])).toEqual({
    received: [],
    error: 'Specified native messaging host not found.',
  });
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect((await converse(worker, [hello])).received).toMatchObject([{ app: 'ready' }]);

  // Closed, the app leaves no clip-host.json, and the helper answers for it.
  await desktop.app.close();
  desktop = null;
  expect(existsSync(hostFile)).toBe(false);
  expect((await converse(worker, [hello])).received).toEqual([
    { v: 1, id: 'a', type: 'status', app: 'closed' },
  ]);
  // A development build's helper has no launcher to start the app with.
  expect((await converse(worker, [{ v: 1, id: 'd', type: 'open' }])).received).toMatchObject([
    { id: 'd', type: 'error', code: 'failed' },
  ]);
});

test('the extension clips a page into the app from its popup', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.skip(process.platform !== 'linux', 'The helper is built for Linux here');
  test.setTimeout(180_000);
  expect(existsSync(HELPER), 'Build the helper first: scripts/clip-host.sh').toBe(true);
  expect(existsSync(CLIPPER), 'Build the extension first: pnpm -C apps/clipper build').toBe(true);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const { app, config, env } = await clippingApp();
  desktop = app;
  await signInAndUnlock(desktop, page, baseURL ?? '');

  const { origin } = await clippedSite();
  browser = await chromium.launchPersistentContext(join(config, 'chromium'), {
    channel: 'chromium',
    args: [`--disable-extensions-except=${CLIPPER}`, `--load-extension=${CLIPPER}`],
    env,
  });
  const worker = browser.serviceWorkers()[0] ?? (await browser.waitForEvent('serviceworker'));
  const story = await browser.newPage();
  await story.goto(`${origin}/story`);
  const tabId = await worker.evaluate(async (url) => {
    type Tabs = { query(query: object): Promise<{ id?: number; url?: string }[]> };
    const { tabs } = (globalThis as unknown as { chrome: { tabs: Tabs } }).chrome;
    return (await tabs.query({})).find((tab) => tab.url === url)?.id;
  }, `${origin}/story`);
  // The popup, in a tab of its own, for the story's tab, as its toolbar button opens it.
  const popup = await browser.newPage();
  await popup.goto(`${ORIGIN}popup.html?tab=${tabId}`);
  await expect(popup.getByRole('radio', { name: 'Article' })).toBeChecked();
  await popup.getByLabel('Find a folder').fill('perso');
  await popup.getByRole('radio', { name: 'Personal' }).check();
  await popup.getByLabel('Tags').fill('clipped');
  await popup.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(popup.getByText('Saved to Personal')).toBeVisible();
  await expect(desktop.window.getByText('Saved “A clipped story” to Personal')).toBeVisible();

  await popup.getByRole('button', { name: 'Open in WikiStow' }).click();
  await expect(desktop.window.locator('#page-title')).toHaveValue('A clipped story');
  await expect
    .poll(() => sourceOf(desktop!.window))
    .toMatch(/^## The story\n\n(Some words[^\n]+\n\n){4}!\[A cat\]\(attachment:[\w-]{22}\)\n$/);

  // A screenshot of the story as shown, from a popup over its tab, saved
  // as the draft's image, sealed, above the link.
  await story.bringToFront();
  const again = await browser.newPage();
  await again.goto(`${ORIGIN}popup.html?tab=${tabId}`);
  await again.getByRole('radio', { name: 'Visible area' }).check();
  await again.getByLabel('Title').fill('The story, as shown');
  await again.getByLabel('Note').fill('As it looked');
  await expect(again.getByRole('radio', { name: 'Personal' })).toBeChecked();
  await story.bringToFront();
  await again.getByRole('button', { name: 'Save to WikiStow' }).click();
  await expect(desktop.window.getByText('Saved “The story, as shown” to Personal')).toBeVisible();
  await again.getByRole('button', { name: 'Open in WikiStow' }).click();
  await expect(desktop.window.locator('#page-title')).toHaveValue('The story, as shown');
  await expect
    .poll(() => sourceOf(desktop!.window))
    .toMatch(
      new RegExp(
        `^As it looked\\n\\n!\\[Screenshot\\]\\(attachment:[\\w-]{22}\\)\\n\\n\\[The story, as shown\\]\\(${origin.replaceAll('.', '\\.')}/story\\)\\n$`,
      ),
    );
  // The app opens the sealed screenshot as the PNG the browser took.
  await expect(desktop.window.getByText('Screenshot.png')).toBeVisible();
  await desktop.window.getByRole('button', { name: 'Visual' }).click();
  const shown = desktop.window.getByRole('img', { name: 'Screenshot' }).first();
  await expect
    .poll(() => shown.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(100);
});
