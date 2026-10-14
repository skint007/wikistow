// Driving the desktop app in tests: launch it on a profile of its own, catch
// the address it would open in the system browser, and hand it the browser's
// `wikistow://` link the way the desktop does, through a second launch.
import { _electron, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
// CI runs as root in a container, where Chromium's sandbox can't start, and
// whose /dev/shm is too small for Chromium's shared memory.
const CONTAINER_SWITCHES =
  process.getuid?.() === 0 ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];

// The binary itself, so Playwright starts it without its own loader, which
// forces `--password-store=basic` and would hide the system keyring.
const ELECTRON: unknown = createRequire(import.meta.url)('electron');
if (typeof ELECTRON !== 'string') throw new Error('The electron package names no binary');
const executablePath = ELECTRON;

export type Desktop = { app: ElectronApplication; window: Page; profile: string };

export const newProfile = () => mkdtemp(join(tmpdir(), 'wikistow-desktop-'));

/** Start the app on `profile`: the workspace's, or the packed one at `appPath`. */
export async function launch(
  profile: string,
  args: string[] = [],
  appPath = APP_DIR,
): Promise<Desktop> {
  // The plain-text store unless a test asks for the keyring, which the app
  // would otherwise find on the developer's own desktop.
  const store = args.some((arg) => arg.startsWith('--password-store='))
    ? []
    : ['--password-store=basic'];
  const app = await _electron.launch({
    executablePath,
    args: [appPath, `--user-data-dir=${profile}`, ...CONTAINER_SWITCHES, ...store, ...args],
  });
  return { app, window: await app.firstWindow(), profile };
}

/** Stop the app opening the system browser; answer the next address it tries. */
export async function catchBrowser({ app }: Desktop): Promise<() => Promise<string>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Reflect.set(globalThis, '__opened', opened);
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  return async () => {
    for (let tries = 0; tries < 100; tries++) {
      const url = await app.evaluate(() => {
        const opened: unknown = Reflect.get(globalThis, '__opened');
        return Array.isArray(opened) ? (opened.shift() as string | undefined) : undefined;
      });
      if (url) return url;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The app opened no browser');
  };
}

/** Hand `link` to the running app as the desktop would: by launching it again. */
export async function openLink({ app, profile }: Desktop, link: string): Promise<void> {
  const second = spawn(
    app.process().spawnfile,
    [APP_DIR, `--user-data-dir=${profile}`, ...CONTAINER_SWITCHES, link],
    {
      stdio: 'ignore',
    },
  );
  await new Promise<void>((resolve, reject) => {
    second.once('exit', () => resolve());
    second.once('error', reject);
  });
}

/**
 * Sign the app in to `server` as the person signed in on `page`: the app
 * opens the browser, the person approves there, and the link comes back.
 */
export async function signInThroughBrowser(desktop: Desktop, page: Page, server: string) {
  const opened = await catchBrowser(desktop);
  await desktop.window.getByLabel('Server').fill(server);
  await desktop.window.getByRole('button', { name: 'Sign in with your browser' }).click();
  await page.goto(await opened());
  await page.getByRole('button', { name: 'Sign in to the desktop app' }).click();
  await openLink(desktop, (await page.getByTestId('desktop-link').getAttribute('href')) ?? '');
}

/** Every file the app keeps in its profile, as text, to look for what must not be there. */
export async function profileText(profile: string): Promise<string> {
  const entries = await readdir(profile, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const texts = await Promise.all(
    files.map((file) => readFile(join(file.parentPath, file.name), 'latin1').catch(() => '')),
  );
  return texts.join('\n');
}

export const accountMenu = (window: Page, item: 'Lock vault' | 'Sign out') =>
  window
    .getByRole('button', { name: 'Account' })
    .click()
    .then(() => window.getByRole('menuitem', { name: item }).click());
