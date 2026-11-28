// Replacing your keys (protocol section 4.6, #327), with the server setting
// on as the e2e server has it: new keys, a new passphrase and recovery key,
// the other device signed out, and asked there whether it was you.
import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixtures';
import { adminTab, choosePassphrase, memberWithVault, PASSPHRASE } from './vault';

const NEW_PASSPHRASE = 'a brand new vault passphrase for tests';
const REPLACED = 'Your keys are replaced.';

// Pictures for a pull request, only when asked for (`E2E_SHOTS=<directory>`).
const shot = async (page: Page, name: string) => {
  const dir = process.env['E2E_SHOTS'];
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

test('Replace my keys makes a new vault, and the other device asks whether it was you', async ({
  page,
  admin,
  freshPage,
}) => {
  test.slow();
  const adminPage = await adminTab(freshPage, admin.email);
  const { email } = await memberWithVault(page, adminPage);

  // The same person on a second device, unlocked there.
  const other = await freshPage();
  await signIn(other, email);
  await other.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await other.getByRole('button', { name: 'Unlock' }).click();
  await expect(other.getByRole('heading', { name: 'Pick a page' })).toBeVisible();

  // Another tab of the same browser, unlocked too.
  const sameBrowser = await page.context().newPage();
  await sameBrowser.goto('/');
  await sameBrowser.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await sameBrowser.getByRole('button', { name: 'Unlock' }).click();
  await expect(sameBrowser.getByRole('heading', { name: 'Pick a page' })).toBeVisible();

  await test.step('Settings replaces the keys, with a recovery key to save', async () => {
    await page.goto('/settings#security');
    await page.getByRole('button', { name: 'Start replace my keys' }).click();
    const dialog = page.getByRole('dialog', { name: 'Replace my keys' });
    await expect(dialog.getByText('You have no agents to keep.')).toBeVisible();
    // Only its close button closes it (#771).
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    // The old passphrase would open the new vault to whoever knows it.
    await choosePassphrase(page, PASSPHRASE);
    await page.getByRole('button', { name: 'Make new keys' }).click();
    await expect(
      page.getByText('Choose a passphrase you haven’t used for your vault.'),
    ).toBeVisible({
      timeout: 30_000,
    });
    await choosePassphrase(page, NEW_PASSPHRASE);
    await shot(page, 'replace-my-keys');
    await page.getByRole('button', { name: 'Make new keys' }).click();
    const shown = page.getByTestId('rotation-recovery-key');
    await expect(shown).toBeVisible({ timeout: 30_000 });
    await shot(page, 'new-recovery-key');
    const groups = (await shown.textContent())?.trim().split(/\s+/) ?? [];
    for (const field of await page.getByLabel(/^Group \d+$/).all()) {
      const index = Number((await field.getAttribute('id'))?.replace('rotation-group-', ''));
      await field.fill(groups[index] ?? '');
    }
    await page.getByRole('button', { name: 'Replace my keys', exact: true }).click();
    // Exactly: "once your keys are replaced" is in the panel before it lands.
    await expect(page.getByText(REPLACED, { exact: true })).toBeVisible({ timeout: 30_000 });
    // Nothing shared here, so nothing is left to move to the new keys.
    await expect(
      page.getByText('Your keys were replaced, and your shared folders use the new ones.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await shot(page, 'keys-replaced');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    // The other tab held the old keys: it locked.
    await expect(sameBrowser.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
    await sameBrowser.close();
  });

  await test.step('this device unlocks with the new passphrase only', async () => {
    await page.getByRole('button', { name: 'Account' }).click();
    await page.getByRole('menuitem', { name: 'Lock vault' }).click();
    // Settings stays open while locked; a page asks for the passphrase.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
    await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(
      page.getByText('That didn’t unlock the vault. Check it and try again.'),
    ).toBeVisible();
    await page.getByLabel('Vault passphrase').fill(NEW_PASSPHRASE);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  });

  await test.step('the other device is signed out, and asks whether it was you', async () => {
    await other.reload();
    await other.waitForURL((url) => url.pathname.startsWith('/sign-in'));
    await signIn(other, email);
    await expect(other.getByRole('heading', { name: 'Did you replace your keys?' })).toBeVisible();
    await shot(other, 'did-you-replace');
    // "I didn't" opens nothing here, and asks again next time.
    await other.getByRole('button', { name: 'I didn’t' }).click();
    await expect(
      other.getByRole('heading', { name: 'Someone else holds your keys' }),
    ).toBeVisible();
    await shot(other, 'not-them');
    await other.reload();
    await expect(other.getByRole('heading', { name: 'Did you replace your keys?' })).toBeVisible();
    await other.getByRole('button', { name: 'I did this' }).click();
    await other.getByLabel('Vault passphrase').fill(NEW_PASSPHRASE);
    await other.getByRole('button', { name: 'Unlock' }).click();
    await expect(other.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  });
});

// #764: the tab that sent the rotation reloads before it hears the answer.
// The device kept the statement's hash, so it knows the rotation as its own:
// it asks only for the new passphrase, never whether the person did it.
test('A page load in the middle of Replace my keys asks only for the new passphrase', async ({
  page,
  admin,
  freshPage,
}) => {
  test.slow();
  const adminPage = await adminTab(freshPage, admin.email);
  await memberWithVault(page, adminPage);
  // The server takes the rotation, but its answer never reaches the tab.
  let landed: () => void = () => {};
  const landing = new Promise<void>((resolve) => (landed = resolve));
  await page.route('**/api/me/identity/rotate', async (route) => {
    await route.fetch();
    landed();
  });
  await replaceKeys(page, { wait: false });
  await landing;
  await page.unroute('**/api/me/identity/rotate');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Did you replace your keys?' })).toBeHidden();
  await shot(page, 'reload-mid-send');
  await page.getByLabel('Vault passphrase').fill(NEW_PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  // The tab keeps the new vault through a reload, and asks nothing.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Did you replace your keys?' })).toBeHidden();
});

/**
 * Replace the keys from Settings, with no agents. With `wait`, until the
 * panel says they are replaced.
 */
async function replaceKeys(page: Page, { wait = true }: { wait?: boolean } = {}) {
  await page.goto('/settings#security');
  await page.getByRole('button', { name: 'Start replace my keys' }).click();
  await choosePassphrase(page, NEW_PASSPHRASE);
  await page.getByRole('button', { name: 'Make new keys' }).click();
  const shown = page.getByTestId('rotation-recovery-key');
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const groups = (await shown.textContent())?.trim().split(/\s+/) ?? [];
  for (const field of await page.getByLabel(/^Group \d+$/).all()) {
    const index = Number((await field.getAttribute('id'))?.replace('rotation-group-', ''));
    await field.fill(groups[index] ?? '');
  }
  await page.getByRole('button', { name: 'Replace my keys', exact: true }).click();
  if (wait)
    await expect(page.getByText(REPLACED, { exact: true })).toBeVisible({ timeout: 30_000 });
}
