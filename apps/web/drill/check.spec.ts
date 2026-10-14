// Check a restored copy of the seeded installation, at WIKISTOW_URL, against
// what DRILL_STATE recorded (docs/operations.md, "Checking a restore"). It
// sends no mail and changes nothing.
import type { Page } from '@playwright/test';
import { expect, test } from '../e2e/fixtures';
import { openShared } from '../e2e/sharing';
import {
  downloadedHash,
  installationId,
  openUnlocked,
  quietly,
  readState,
  signInAs,
  unlockWithPassphrase,
  WIKISTOW_URL,
  type State,
} from './drill';

let state: State;
test.beforeAll(() => {
  state = readState();
  if (!state.complete)
    throw new Error('The seed recorded in the drill state didn’t finish; resume it first.');
});

/** What the seed made that the check needs, failing if it wasn't recorded. */
function seeded() {
  const { reader, folder, published, private: unshared } = state;
  if (!reader?.totpSecret || !folder || !published || !unshared)
    throw new Error(
      'The drill state is missing what the seed records; resume the seed (DRILL_RESUME=1).',
    );
  return { reader, folder, published, unshared };
}

/** The published page in view shows its marker and picture, and its attachment has the seeded bytes. */
async function expectPublishedPage(page: Page, who: string) {
  const { published } = seeded();
  await expect(
    page.getByText(published.marker),
    `${who} sees the published page without its text`,
  ).toBeVisible({ timeout: 30_000 });
  const { name, sha256 } = published.attachment;
  await expect(page.getByRole('img', { name }), `${name} didn't show for ${who}`).toHaveAttribute(
    'src',
    /^blob:/,
    { timeout: 30_000 },
  );
  expect(await downloadedHash(page, name), `${name} downloaded by ${who} has other bytes`).toBe(
    sha256,
  );
}

test('the installation ID is the one recorded', () =>
  quietly(async () => {
    expect(
      await installationId(),
      `${WIKISTOW_URL} is not a copy of the installation seeded at ${state.url}`,
    ).toBe(state.installationId);
  }));

test('the administrator signs in, unlocks, and opens both pages and the attachment', ({ page }) =>
  quietly(async () => {
    const { published, unshared } = seeded();
    await signInAs(page, state.admin);
    await openUnlocked(page, state.admin, published.path);
    await expect(page.getByRole('heading', { name: published.title, level: 1 })).toBeVisible();
    await expectPublishedPage(page, state.admin.email);

    // Through the sidebar: going to its address would lock the vault again.
    const item = page.getByRole('treeitem', { name: unshared.title });
    await expect(
      item,
      'the private page is missing from the administrator’s sidebar',
    ).toBeVisible();
    await item.click();
    await expect(
      page.getByText(unshared.marker),
      'the administrator sees the private page without its text',
    ).toBeVisible({ timeout: 30_000 });
  }));

test('the reader signs in with two-factor and opens the shared page, but not the private one', ({
  page,
}) =>
  quietly(async () => {
    const { reader, folder, published, unshared } = seeded();
    // A code from the recorded key passes only if the server can decrypt the
    // key it stored, which needs the same BETTER_AUTH_SECRET.
    const { withCode } = await signInAs(page, reader);
    expect(withCode, 'the reader signed in without the two-factor code').toBe(true);
    await unlockWithPassphrase(page, reader);
    await openShared(page, folder, published.title);
    await expectPublishedPage(page, reader.email);
    await expect(
      page.getByRole('treeitem', { name: unshared.title }),
      'the reader’s sidebar lists the page nobody shared with them',
    ).toHaveCount(0);

    // Not even at its address: the page view says it isn't there.
    await openUnlocked(page, reader, unshared.path);
    await expect(
      page.getByRole('article').getByRole('link', { name: 'Go home' }),
      'the reader was not refused the page nobody shared with them',
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: unshared.title })).toHaveCount(0);
    await expect(
      page.getByText(unshared.marker),
      'the reader can read the page nobody shared with them',
    ).toHaveCount(0);
  }));

test('the administrator’s recovery key opens the vault too', ({ page }) =>
  quietly(async () => {
    await signInAs(page, state.admin);
    await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
    await page.getByRole('link', { name: 'Use your recovery key instead' }).click();
    await page.getByLabel('Recovery key').fill(state.admin.recoveryKey);
    await page.getByRole('button', { name: 'Continue' }).click();
    // Opened, it asks for a new passphrase; leaving here keeps the old one.
    await expect(
      page.getByRole('heading', { name: 'Choose a new passphrase' }),
      'the recorded recovery key didn’t open the vault',
    ).toBeVisible({ timeout: 30_000 });
  }));
