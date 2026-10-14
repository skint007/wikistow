import { expect, test } from '../../web/e2e/fixtures';
import { adminTab, memberWithVault, PASSPHRASE } from '../../web/e2e/vault';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  accountMenu,
  launch,
  newProfile,
  profileText,
  signInThroughBrowser,
  type Desktop,
} from './desktop';

// The keyring test needs GNOME Keyring on a session bus; CI sets one up
// (`.github/workflows/ci.yml`, e2e-desktop) and says so with KEYRING=1.
const KEYRING = process.env['KEYRING'] === '1';

let running: Desktop[] = [];
test.afterEach(async () => {
  await Promise.all(running.map((desktop) => desktop.app.close().catch(() => {})));
  running = [];
});

async function open(profile: string, store: 'basic' | 'gnome-libsecret') {
  const desktop = await launch(profile, [`--password-store=${store}`]);
  running.push(desktop);
  return desktop;
}

async function close(desktop: Desktop) {
  await desktop.app.close();
  running = running.filter((other) => other !== desktop);
}

const secretsFile = (profile: string) =>
  access(join(profile, 'secrets.json')).then(
    () => true,
    () => false,
  );

async function unlock(desktop: Desktop, remember: boolean) {
  await desktop.window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  if (remember) await desktop.window.getByLabel('Remember on this computer').click();
  await desktop.window.getByRole('button', { name: 'Unlock' }).click();
  await expect(desktop.window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
}

test('keeps nothing between launches without a trusted keyring', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const profile = await newProfile();
  // Left by a run that had a keyring: without one it must not be read or kept.
  await writeFile(join(profile, 'secrets.json'), '{"cookie":"c2VhbGVk"}');
  const first = await open(profile, 'basic');
  await expect(first.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(await secretsFile(profile)).toBe(false);
  await signInThroughBrowser(first, page, baseURL ?? '');

  await expect(first.window.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await expect(first.window.getByText('Remember on this computer')).toHaveCount(0);
  await unlock(first, false);
  await close(first);

  expect(await secretsFile(profile)).toBe(false);
  expect(await profileText(profile)).not.toContain('session_token');
  // Kept nowhere, the session ended on the server as the app quit.
  await page.goto('/settings');
  await expect(page.getByText('No desktop app is signed in.')).toBeVisible();
  const again = await open(profile, 'basic');
  await expect(again.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('remembers the session, and the unlock until the vault is locked', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.skip(!KEYRING, 'needs GNOME Keyring on a session bus (KEYRING=1)');
  test.setTimeout(240_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const profile = await newProfile();
  const first = await open(profile, 'gnome-libsecret');
  await signInThroughBrowser(first, page, baseURL ?? '');
  await expect(first.window.getByText('Remember on this computer')).toBeVisible();
  await unlock(first, true);
  await close(first);

  expect(await profileText(profile)).not.toContain('session_token');
  // Signed in and unlocked at launch.
  const second = await open(profile, 'gnome-libsecret');
  await expect(second.window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  // Locking forgets the unlock, not the session.
  await accountMenu(second.window, 'Lock vault');
  await expect(second.window.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await close(second);

  const third = await open(profile, 'gnome-libsecret');
  await expect(third.window.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await unlock(third, false);
  // Signing out ends the session on the server and forgets everything here.
  await accountMenu(third.window, 'Sign out');
  await expect(third.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(await secretsFile(profile)).toBe(false);
  await page.goto('/settings');
  await expect(page.getByText('No desktop app is signed in.')).toBeVisible();
  await close(third);

  const fourth = await open(profile, 'gnome-libsecret');
  await expect(fourth.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
