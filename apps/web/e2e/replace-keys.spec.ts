// Replacing your keys (protocol section 4.6, #327), with the server setting
// on as the e2e server has it: new keys, a new passphrase and recovery key,
// the other device signed out, and asked there whether it was you.
import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixtures';
import { adminTab, choosePassphrase, memberWithVault, PASSPHRASE } from './vault';

const NEW_PASSPHRASE = 'a brand new vault passphrase for tests';

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
    await expect(page.getByText('You have no agents to keep.')).toBeVisible();
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
    await page.getByRole('button', { name: 'Replace my keys' }).click();
    await expect(page.getByText('Your keys are replaced.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Your keys were replaced\. Moving what you share/)).toBeVisible();
    await shot(page, 'keys-replaced');
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
