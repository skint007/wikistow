import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../web/e2e/fixtures';
import {
  adminTab,
  fillSource,
  memberWithVault,
  newPage,
  PASSPHRASE,
  waitForSave,
} from '../../web/e2e/vault';
import { accountMenu, launch, newProfile, signInThroughBrowser, type Desktop } from './desktop';

// Keeping the session between launches needs GNOME Keyring on a session
// bus; CI sets one up and says so with KEYRING=1 (`remember.spec.ts`).
const KEYRING = process.env['KEYRING'] === '1';

let running: Desktop[] = [];
test.afterEach(async () => {
  await Promise.all(running.map((desktop) => desktop.app.close().catch(() => {})));
  running = [];
});

async function open(profile: string) {
  const desktop = await launch(profile, ['--password-store=gnome-libsecret']);
  running.push(desktop);
  return desktop;
}

/**
 * With a trusted keyring the app keeps its session and every page, so a
 * launch with no answer from the server starts offline (ADR 0009, decision
 * 5): the remembered unlock opens the vault, the kept pages read, the
 * passphrase unlocks against the wrapper kept, and Sign out offers to sign
 * out on this computer. Once the server answers, it goes on online.
 */
test('starts offline, unlocks and reads what it kept', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.skip(!KEYRING, 'needs GNOME Keyring on a session bus (KEYRING=1)');
  test.setTimeout(240_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Bean soup');
  await fillSource(page, 'Beans and stock, simmered.');
  await waitForSave(page);

  const profile = await newProfile();
  const first = await open(profile);
  await signInThroughBrowser(first, page, baseURL ?? '');
  await first.window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await first.window.getByLabel('Remember on this computer').click();
  await first.window.getByRole('button', { name: 'Unlock' }).click();
  await expect(first.window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  // The desktop keeps every page: Settings counts it once the keeper ran.
  await first.window.getByRole('link', { name: 'Settings' }).click();
  await expect(first.window.getByText(/^1 page, /)).toBeVisible({ timeout: 30_000 });
  // Search by meaning is on by default with a keyring (ADR 0016, decision
  // 5): the page is embedded in the background, and the vectors kept,
  // sealed, in the app's data folder beside the search index.
  await expect(first.window.getByRole('switch', { name: 'Search by meaning' })).toBeChecked();
  await expect
    .poll(
      () =>
        stat(join(profile, 'meaning-index')).then(
          ({ size }) => size,
          () => 0,
        ),
      {
        timeout: 60_000,
      },
    )
    .toBeGreaterThan(384);
  await first.app.close();
  running = [];

  // Signed in and unlocked at launch.
  const { app, window } = await open(profile);
  await expect(window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  // From now on main's requests get no answer, as with no network. Loaded
  // again, the app starts as it would offline.
  await app.evaluate(() => {
    const send = globalThis.fetch;
    Reflect.set(globalThis, '__offline', true);
    globalThis.fetch = (input, init) =>
      Reflect.get(globalThis, '__offline') === true
        ? Promise.reject(new TypeError('fetch failed'))
        : send(input, init);
  });
  await window.reload();
  const offline = window.getByRole('status').filter({ hasText: 'Offline' });
  await expect(offline).toBeVisible();
  await expect(window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  // Work for owners waits for the server, rather than finding every space unchecked.
  await expect(window.getByRole('complementary', { name: 'Waiting for you' })).toHaveCount(0);
  await window.getByRole('treeitem', { name: 'Bean soup' }).click();
  await expect(window.getByText('Beans and stock, simmered.')).toBeVisible();

  await accountMenu(window, 'Lock vault');
  await expect(window.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await window.getByRole('button', { name: 'Unlock' }).click();
  await expect(window.getByText('Beans and stock, simmered.')).toBeVisible();

  // The server may never come back, so there is still a way out.
  await accountMenu(window, 'Sign out');
  await expect(window.getByRole('button', { name: 'Sign out on this computer' })).toBeVisible();

  // The server answers again: the app finds out at its next check.
  await app.evaluate(() => Reflect.set(globalThis, '__offline', false));
  await expect(offline).toBeHidden({ timeout: 45_000 });
  await expect(window.getByRole('button', { name: 'Publish' })).not.toHaveAttribute(
    'aria-disabled',
  );
  await expect(window.getByText('Beans and stock, simmered.')).toBeVisible();
});
