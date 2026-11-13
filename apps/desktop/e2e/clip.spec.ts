// The web clipper's path through the desktop app (ADR 0017, step 2): a
// test extension in Chromium starts wikistow-clip-host through the
// manifest the app wrote, and the helper reaches the running app on its
// socket. The app only answers here; saving a clip comes later.
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../web/e2e/fixtures';
import { adminTab, memberWithVault, PASSPHRASE } from '../../web/e2e/vault';
import { launch, signInThroughBrowser, type Desktop } from './desktop';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// scripts/clip-host.sh builds it; CI's build job does, for this job too.
const HELPER = join(APP_DIR, 'out', 'clip-host', 'linux-amd64', 'wikistow-clip-host');
const EXTENSION = join(APP_DIR, 'e2e', 'clip-extension');
// The ID its manifest's key gives it.
const ORIGIN = 'chrome-extension://mnoeboefdgcplmejicllacedgejajmdo/';
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
test.afterEach(async () => {
  await desktop?.app.close().catch(() => {});
  await browser?.close().catch(() => {});
  desktop = null;
  browser = null;
});

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

  // A home and config folder of the test's own, which the app writes the
  // manifests into and the helper finds the app's clip-host.json through.
  // The browser's profile is its folder there, as a person's Chromium is.
  const root = await mkdtemp(join(tmpdir(), 'wikistow-clip-'));
  const home = join(root, 'home');
  const config = join(root, 'config');
  await mkdir(join(config, 'chromium'), { recursive: true });
  await mkdir(join(home, '.mozilla'), { recursive: true });
  const env = { ...definedEnv(), HOME: home, XDG_CONFIG_HOME: config };
  const profile = join(config, 'WikiStow');
  desktop = await launch(
    profile,
    ['--clip-manifests', `--clip-extension=${ORIGIN}`],
    undefined,
    env,
  );
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
  expect(JSON.parse(await readFile(firefoxManifest, 'utf8'))).toMatchObject({
    path: HELPER,
    allowed_extensions: ['web-clipper@wikistow.skint007.github.io'],
  });
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
  // A clip is acknowledged and refused, until the app saves them.
  expect((await converse(worker, [{ v: 1, id: 'c', type: 'clip' }])).received).toMatchObject([
    { id: 'c', type: 'error', code: 'failed' },
  ]);

  await signInThroughBrowser(desktop, page, baseURL ?? '');
  await desktop.window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await desktop.window.getByRole('button', { name: 'Unlock' }).click();
  await expect(desktop.window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  // Signed in. Main doesn't hear the vault's state from the pages yet.
  expect((await converse(worker, [hello])).received).toMatchObject([{ app: 'locked' }]);

  // Turning it off closes the socket and deletes the manifests.
  await desktop.window.getByRole('link', { name: 'Settings' }).first().click();
  const row = desktop.window.getByRole('heading', { name: 'Browser clipping' });
  await expect(row).toHaveAccessibleDescription(
    'The WikiStow extension in Chromium and Firefox can save pages here as drafts.',
  );
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
  expect((await converse(worker, [hello])).received).toMatchObject([{ app: 'locked' }]);

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
