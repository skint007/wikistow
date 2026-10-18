import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../web/e2e/fixtures';
import { adminTab, memberWithVault, PASSPHRASE } from '../../web/e2e/vault';
import { launch, newProfile, signInThroughBrowser, type Desktop } from './desktop';

let desktop: Desktop | null = null;
test.afterEach(async () => {
  await desktop?.app.close();
  desktop = null;
});

// The browser half of a sign-in runs in `page`, where the person is signed in.
test('signs in through the browser and opens the vault in the app', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  desktop = await launch(await newProfile());
  const { window } = desktop;

  await expect(window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await signInThroughBrowser(desktop, page, baseURL ?? '');

  await expect(window.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await window.getByRole('button', { name: 'Unlock' }).click();
  await expect(window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();

  // The pages are the app's own, under its policy, and reload on any route.
  const csp = await window.evaluate(async () =>
    (await fetch('/settings')).headers.get('content-security-policy'),
  );
  expect(csp).toContain("connect-src 'self'");
  await window.evaluate(() => {
    location.assign('/settings');
  });
  await expect(window.getByRole('heading', { name: 'Desktop apps' })).toBeVisible();
  await window.reload();
  await expect(window.getByRole('heading', { name: 'Desktop apps' })).toHaveAccessibleDescription(
    '1 signed in, including this app',
  );
});

test('opens with a damaged settings file', async () => {
  const profile = await newProfile();
  await writeFile(join(profile, 'config.json'), '');
  desktop = await launch(profile);
  await expect(desktop.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
