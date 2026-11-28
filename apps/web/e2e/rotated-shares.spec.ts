// Shares after someone replaced their keys (protocol section 4.6, #327, PR 4),
// with the server's `IDENTITY_ROTATION` at its default: the person's own
// shares move to the new keys, a space they own alone copies into a new
// one, an owner gives a member who replaced their keys the share again, and
// a co-owner adds a rotated owner again, or removes them instead.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  folderMenu,
  newFolder,
  newSpace,
  openShared,
  publishedPageIn,
  shareDialog,
  shareFolder,
} from './sharing';
import { adminTab, choosePassphrase, memberWithVault } from './vault';

const NEW_PASSPHRASE = 'a brand new vault passphrase for tests';
const PLAN = 'Plant the beans after the last frost.';

// Pictures for a pull request, only when asked for (`E2E_SHOTS=<directory>`).
const shot = async (page: Page, name: string) => {
  const dir = process.env['E2E_SHOTS'];
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
};

/** Replace the keys of the person on `page`, keeping no agents; `check` looks before sending. */
async function replaceKeys(page: Page, check?: () => Promise<void>) {
  await page.goto('/settings#security');
  await page.getByRole('button', { name: 'Start replace my keys' }).click();
  await check?.();
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
  // Exactly: "once your keys are replaced" is in the panel before it lands.
  await expect(page.getByText('Your keys are replaced.', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

/** Settings → Security with Replace my keys open, as the page may have kept it open. */
async function openReplaceKeys(page: Page) {
  await page.goto('/settings#security');
  // Read afresh: a goto that changes only the hash keeps what the page loaded.
  await page.reload();
  const start = page.getByRole('button', { name: 'Start replace my keys' });
  const after = page.getByTestId('rotation-after');
  await expect(start.or(after)).toBeVisible({ timeout: 30_000 });
  if (await start.isVisible()) await start.click();
  await expect(after).toBeVisible();
}

/** A space with a shared folder holding a published page. */
async function gardenSharedWith(owner: Page, email: string, access: 'reader' | 'editor') {
  await newSpace(owner, 'Family');
  await newFolder(owner, 'Garden');
  await publishedPageIn(owner, 'Garden', 'Planting plan', PLAN);
  await shareFolder(owner, 'Garden', email, access);
  await owner.keyboard.press('Escape');
}

test('replacing your keys moves the shares of a space you own, and offers to copy it', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.slow();
  const adminPage = await adminTab(freshPage, admin.email);
  const reader = await freshPage();
  await memberWithVault(owner, adminPage, 'Rhea Rotator');
  const { email: readerEmail } = await memberWithVault(reader, adminPage, 'Ralph Reader');
  await gardenSharedWith(owner, readerEmail, 'reader');
  await openShared(reader, 'Garden', 'Planting plan');
  await expect(reader.getByText(PLAN)).toBeVisible();

  await test.step('the dialog names the space owned alone before anything is sent', async () => {
    await replaceKeys(owner, async () => {
      const spaces = owner.getByTestId('rotation-spaces');
      await expect(spaces).toContainText('which you own alone');
      await expect(spaces).toContainText('Family');
      await shot(owner, 'rotation-spaces');
    });
  });

  await test.step('the share moves to the new keys, with the reader ticked to keep it', async () => {
    const after = owner.getByTestId('rotation-after');
    await expect(after).toContainText('A shared folder still uses keys your old key opens.', {
      timeout: 30_000,
    });
    await after.getByRole('button', { name: 'Move them to your new keys' }).click();
    const dialog = owner.getByRole('dialog', { name: 'Finish replacing your keys' });
    await expect(dialog.getByText('Ralph Reader')).toBeVisible({ timeout: 30_000 });
    await expect(
      dialog.getByText('Waits: only earlier keys of an owner gave them access'),
    ).toBeVisible();
    await dialog.getByLabel('Keep their access').check();
    await expect(dialog.getByText('Keeps access, as a reader', { exact: true })).toBeVisible();
    await shot(owner, 'finish-rotation');
    await dialog.getByRole('button', { name: 'Rotate keys' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(after).toContainText('Your shared folders use your new keys.');
  });

  await test.step('the reader keeps what they had', async () => {
    await reader.reload();
    await expect(reader.getByText(PLAN)).toBeVisible({ timeout: 30_000 });
  });

  await test.step('the space owned alone copies into a new space, shared with nobody', async () => {
    const after = owner.getByTestId('rotation-after');
    await after
      .getByRole('listitem')
      .filter({ hasText: 'Family' })
      .getByRole('button', { name: 'Copy into a new space' })
      .click();
    const dialog = owner.getByRole('dialog', { name: 'Copy Family into a new space' });
    await expect(dialog.getByLabel('Name of the new space')).toHaveValue('Family (copy)');
    await dialog.getByRole('button', { name: 'Make the new space' }).click();
    await shot(owner, 'copy-alone');
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(owner.getByRole('treeitem', { name: /Garden/ })).toBeVisible({ timeout: 30_000 });
    await expect(owner.getByRole('heading', { name: 'Family (copy)' })).toBeVisible();
  });
});

test('an owner gives a member who replaced their keys the share again with Rotate keys and give access', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.slow();
  const adminPage = await adminTab(freshPage, admin.email);
  const member = await freshPage();
  await memberWithVault(owner, adminPage, 'Owen Owner');
  const { email } = await memberWithVault(member, adminPage, 'Mark Member');
  await gardenSharedWith(owner, email, 'editor');
  await openShared(member, 'Garden', 'Planting plan');

  await replaceKeys(member);
  // Mark's own space has nothing shared: nothing to finish.

  await test.step('the folder’s access list offers the rotation, not a plain Give access', async () => {
    await owner.reload();
    await folderMenu(owner, 'Garden', 'Share…');
    const people = shareDialog(owner, 'Garden').getByRole('region', { name: 'People with access' });
    await expect(people.getByRole('button', { name: 'Rotate keys and give access' })).toBeVisible({
      timeout: 30_000,
    });
    await owner.keyboard.press('Escape');
  });

  await test.step('the owner sees them waiting as having replaced their keys', async () => {
    await owner.goto('/');
    const note = owner.getByRole('complementary', { name: 'Waiting for you' });
    await expect(note).toContainText('people wait for their keys', { timeout: 30_000 });
    // The app says once that they replaced their keys: closing the share
    // dialog with Escape isn't seeing it (#771).
    const notice = owner.getByRole('dialog', { name: 'Mark Member replaced their keys' });
    await notice.getByRole('button', { name: 'OK' }).click({ timeout: 30_000 });
    await expect(notice).toBeHidden();
    await note.getByRole('button', { name: 'Give access' }).click();
    const dialog = owner.getByRole('dialog', { name: 'Give access' });
    await expect(dialog.getByText('Replaced their keys')).toBeVisible();
    await shot(owner, 'waiting-replaced');
    await dialog.getByRole('button', { name: 'Rotate keys and give access' }).click();
    // Asked in plain words (#771), the dialog titled with the question.
    const rekey = owner.getByRole('dialog', { name: 'Rotate keys and give Mark Member access?' });
    await expect(rekey).toContainText(
      'Mark Member replaced their keys and needs to be given access',
    );
    const give = rekey.getByRole('button', { name: 'Give access', exact: true });
    // Enabled once the review is worked out ("Working out who keeps access…" shows first).
    await expect(give).toBeEnabled({ timeout: 30_000 });
    await expect(rekey.getByText('Keeps access (', { exact: false })).toBeVisible();
    await shot(owner, 'rotate-and-give');
    await give.click();
    const after = owner.getByRole('dialog', { name: 'Give access' });
    await expect(after.getByText('Mark Member has their keys now, at their new key.')).toBeVisible({
      timeout: 30_000,
    });
  });

  await test.step('the member opens the share at the new key', async () => {
    await member.goto('/');
    await openShared(member, 'Garden', 'Planting plan');
    await expect(member.getByText(PLAN)).toBeVisible({ timeout: 30_000 });
  });
});

/**
 * Alice owns "Shared house" with Olive, then replaces their keys, and
 * Olive's app offers to add them again. Each test names them apart.
 */
async function coOwnersThenRotate(
  alice: Page,
  olive: Page,
  adminPage: Page,
  {
    aliceName,
    oliveName,
    beforeRotate,
  }: {
    aliceName: string;
    oliveName: string;
    /** Anything Alice does in the space before replacing their keys. */
    beforeRotate?: (space: string) => Promise<void>;
  },
) {
  await memberWithVault(alice, adminPage, aliceName);
  const { email: oliveEmail } = await memberWithVault(olive, adminPage, oliveName);
  await newSpace(alice, 'Shared house');
  const space = alice.url();

  await test.step('Alice makes Olive a co-owner, and Olive confirms', async () => {
    await alice.goto(`${space}/members`);
    await alice.getByRole('button', { name: 'Add co-owner' }).click();
    const dialog = alice.getByRole('dialog', { name: 'Add a co-owner' });
    await dialog.getByLabel('Email').fill(oliveEmail);
    await dialog.getByRole('button', { name: oliveEmail }).click();
    await dialog.getByRole('button', { name: 'Make owner' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await olive.goto(space);
    const confirm = olive.getByRole('dialog', { name: `${aliceName} added you as an owner` });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole('button', { name: 'Confirm' }).click();
    await expect(confirm).toBeHidden({ timeout: 30_000 });
  });
  await beforeRotate?.(space);

  await test.step('Alice replaces their keys; the dialog names the space owned with others', async () => {
    await replaceKeys(alice, async () => {
      await expect(alice.getByTestId('rotation-spaces')).toContainText('which you own with others');
    });
    await expect(alice.getByTestId('rotation-waits-for-owner')).toContainText('Shared house', {
      timeout: 30_000,
    });
  });

  await test.step('Olive’s app names Alice and offers to add them again', async () => {
    await olive.goto('/');
    // The app says once that they replaced their keys, first: while that
    // dialog is open, the page under it, the note included, is out of reach.
    const notice = olive.getByRole('dialog', { name: `${aliceName} replaced their keys` });
    await notice.getByRole('button', { name: 'OK' }).click({ timeout: 30_000 });
    await expect(notice).toBeHidden();
    const note = olive.getByRole('complementary', { name: 'Waiting for you' });
    await expect(note).toContainText('an owner replaced their keys', { timeout: 30_000 });
    await note.getByRole('button', { name: new RegExp(`^Add .*${aliceName}.* again$`) }).click();
  });
  return { space };
}

test('a co-owner adds a rotated owner again', async ({ page: alice, freshPage, admin }) => {
  test.slow();
  const adminPage = await adminTab(freshPage, admin.email);
  const olive = await freshPage();
  const { space } = await coOwnersThenRotate(alice, olive, adminPage, {
    aliceName: 'Alice Adder',
    oliveName: 'Olive Other',
  });

  await test.step('Olive adds Alice again', async () => {
    const dialog = olive.getByRole('dialog', { name: 'Add Alice Adder again as an owner?' });
    await expect(dialog.getByTestId('add-again-fingerprint')).toBeVisible();
    await shot(olive, 'add-again');
    await dialog.getByRole('button', { name: 'Add again' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });

  await test.step('Alice confirms who added them again, and waits for nobody', async () => {
    // Until Alice confirms, the rotation isn't finished there.
    await openReplaceKeys(alice);
    await expect(alice.getByTestId('rotation-confirm-owner')).toContainText('Shared house', {
      timeout: 30_000,
    });
    await alice.goto(space);
    const confirm = alice.getByRole('dialog', { name: /Olive Other added you as an owner/ });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await confirm.getByRole('button', { name: 'Confirm' }).click();
    await expect(confirm).toBeHidden({ timeout: 30_000 });
    await openReplaceKeys(alice);
    await expect(alice.getByTestId('rotation-after')).toContainText(
      'Your shared folders use your new keys.',
      { timeout: 30_000 },
    );
    await expect(alice.getByTestId('rotation-waits-for-owner')).toBeHidden();
  });
});

test('a co-owner removes a rotated owner instead of adding them again', async ({
  page: alice,
  freshPage,
  admin,
}) => {
  test.slow();
  const adminPage = await adminTab(freshPage, admin.email);
  const olive = await freshPage();
  const mia = await freshPage();
  const { email: miaEmail } = await memberWithVault(mia, adminPage, 'Mia Member');
  const { space } = await coOwnersThenRotate(alice, olive, adminPage, {
    aliceName: 'Rita Rotated',
    oliveName: 'Rory Remover',
    beforeRotate: (at) =>
      test.step('Alice shares a folder with Mia, who opens it', async () => {
        await alice.goto(at);
        await newFolder(alice, 'Garden');
        await publishedPageIn(alice, 'Garden', 'Planting plan', PLAN);
        await shareFolder(alice, 'Garden', miaEmail, 'reader');
        await alice.keyboard.press('Escape');
        await openShared(mia, 'Garden', 'Planting plan');
        await expect(mia.getByText(PLAN)).toBeVisible({ timeout: 30_000 });
      }),
  });

  await test.step('Olive removes Alice as an owner, keeping Mia', async () => {
    const offer = olive.getByRole('dialog', { name: 'Add Rita Rotated again as an owner?' });
    await offer.getByRole('button', { name: 'Remove them instead' }).click();
    const dialog = olive.getByRole('dialog', { name: 'Remove an owner' });
    await expect(dialog.getByRole('button', { name: 'Remove owner' })).toBeEnabled({
      timeout: 30_000,
    });
    // Only Alice's earlier key gave Mia access: listed unticked, as a reader once ticked.
    await expect(
      dialog.getByText('Waits: only earlier keys of an owner gave them access', { exact: true }),
    ).toBeVisible();
    await dialog.getByLabel('Keep their access').check();
    await expect(dialog.getByText('Keeps access, as a reader', { exact: true })).toBeVisible();
    await shot(olive, 'remove-instead');
    await dialog.getByRole('button', { name: 'Remove owner' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    // Nothing waits for Olive now, so the note offers nothing more.
    await expect(olive.getByText('an owner replaced their keys', { exact: false })).toBeHidden({
      timeout: 30_000,
    });
  });

  await test.step('Alice is no longer an owner there', async () => {
    await olive.goto(`${space}/members`);
    await expect(olive.getByText('Rita Rotated')).toBeHidden({ timeout: 30_000 });
  });

  await test.step('Mia opens what Olive publishes there next', async () => {
    await olive.goto(space);
    await publishedPageIn(olive, 'Garden', 'Harvest plan', 'Pick the beans in August.');
    await mia.goto('/');
    await openShared(mia, 'Garden', 'Harvest plan');
    await expect(mia.getByText('Pick the beans in August.')).toBeVisible({ timeout: 30_000 });
  });
});
