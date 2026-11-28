// Following someone who replaced their keys (protocol sections 4.6 and 8.4,
// #327), with the server setting on as the e2e server has it: the person
// still opens what they wrote before, and a contact's app follows the chain
// to their new key and says so once.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newFolder, newSpace, openShared, publishedPageIn, shareFolder } from './sharing';
import { adminTab, choosePassphrase, memberWithVault, waitForSave } from './vault';

const NEW_PASSPHRASE = 'a brand new vault passphrase for tests';
const TEXT = {
  diary: 'Written before the keys were replaced.',
  plan: 'Plant the beans after the last frost.',
};

// Pictures for a pull request, only when asked for (`E2E_SHOTS=<directory>`).
const shot = async (page: Page, name: string) => {
  const dir = process.env['E2E_SHOTS'];
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

/** Replace the keys of the person signed in on `page`, from Settings, keeping no agents. */
async function replaceKeys(page: Page) {
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
  await page.getByRole('button', { name: 'Replace my keys' }).click();
  // Exactly: "once your keys are replaced" is in the panel before it lands.
  await expect(page.getByText('Your keys are replaced.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

test('a contact follows replaced keys with a notice, and the person still opens what they wrote', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.slow();
  const adminPage = await adminTab(freshPage, admin.email);
  const reader = await freshPage();
  await memberWithVault(owner, adminPage, 'Olive Owner');
  const { email: readerEmail } = await memberWithVault(reader, adminPage, 'Rita Reader');

  let space = '';
  await test.step('the owner writes a private page and shares a folder', async () => {
    await newSpace(owner, 'Family');
    space = owner.url();
    await newFolder(owner, 'Private');
    await owner.getByRole('treeitem', { name: /Private/ }).hover();
    await owner.getByRole('button', { name: 'Actions for Private' }).click();
    await owner.getByRole('menuitem', { name: 'New page here' }).click();
    await owner.getByRole('dialog').getByLabel('Title').fill('Diary');
    await owner.getByRole('button', { name: 'Create page' }).click();
    await owner.locator('#page-source').fill(TEXT.diary);
    await waitForSave(owner);
    await newFolder(owner, 'Garden');
    await publishedPageIn(owner, 'Garden', 'Planting plan', TEXT.plan);
    await shareFolder(owner, 'Garden', readerEmail, 'reader');
    await owner.keyboard.press('Escape');
    await openShared(reader, 'Garden', 'Planting plan');
    await expect(reader.getByText(TEXT.plan)).toBeVisible();
  });

  await test.step('the owner replaces their keys, and opens what they wrote before', async () => {
    await replaceKeys(owner);
    // A page load at once opens the new vault, and asks nothing (#764).
    await owner.goto(space);
    await expect(owner.getByRole('heading', { name: 'Did you replace your keys?' })).toBeHidden();
    await owner.getByRole('treeitem', { name: 'Diary' }).click();
    await expect(owner.getByText(TEXT.diary)).toBeVisible({ timeout: 30_000 });
    await shot(owner, 'opens-earlier');
  });

  await test.step('the reader’s app follows the new key and says so once', async () => {
    await reader.goto('/');
    await openShared(reader, 'Garden', 'Planting plan');
    const notice = reader.getByRole('dialog', { name: 'Olive Owner replaced their keys' });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice.getByTestId('earlier-fingerprint')).toBeVisible();
    await expect(notice.getByTestId('new-fingerprint')).toBeVisible();
    await expect(notice.getByTestId('earlier-fingerprint')).not.toHaveText(
      (await notice.getByTestId('new-fingerprint').textContent()) ?? '',
    );
    await shot(reader, 'follow-notice');
    // Not them? says what declining does, and Back changes nothing.
    await notice.getByRole('button', { name: 'Not them?' }).click();
    await expect(
      reader.getByRole('dialog', { name: /Decline Olive Owner’s new key/ }),
    ).toBeVisible();
    await shot(reader, 'not-them');
    await reader.getByRole('button', { name: 'Back' }).click();
    await notice.getByRole('button', { name: 'OK' }).click();
    await expect(notice).toBeHidden();
    // What the owner shared before still reads, and the notice doesn't come back.
    await expect(reader.getByText(TEXT.plan)).toBeVisible();
    await reader.reload();
    await expect(reader.getByText(TEXT.plan)).toBeVisible({ timeout: 30_000 });
    await reader.waitForTimeout(4_000);
    await expect(notice).toBeHidden();
  });

  await test.step('Settings shows both keys again, and declining goes back to the key it had', async () => {
    await reader.goto('/settings#security');
    const people = reader.getByRole('list', { name: 'People who replaced their keys' });
    await people.getByRole('button', { name: 'Details' }).click();
    const notice = reader.getByRole('dialog', { name: 'Olive Owner replaced their keys' });
    await expect(notice.getByTestId('earlier-fingerprint')).toBeVisible();
    await notice.getByRole('button', { name: 'Not them?' }).click();
    await reader.getByRole('button', { name: 'Decline new key' }).click();
    const declined = reader.getByRole('dialog', { name: 'You declined Olive Owner’s new key' });
    await expect(declined).toBeVisible({ timeout: 30_000 });
    await shot(reader, 'declined');
    await declined.getByRole('button', { name: 'Done' }).click();
    await expect(people).toBeHidden();
  });
});
