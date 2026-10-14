import type { Page } from '@playwright/test';
import { expect, expectSignedIn, pick, signIn, swapKey, test } from '../e2e/fixtures';
import {
  addPerson,
  folderMenu,
  newFolder,
  newSpace,
  openShared,
  publishedPageIn,
  shareDialog,
  shareFolder,
} from '../e2e/sharing';
import { showIn, typeAtEnd } from '../e2e/editor';
import { shooter as bothPalettes } from './shots';
import {
  adminTab,
  expectSource,
  fillSource,
  memberWithVault,
  newPage,
  PASSPHRASE,
  waitForSave,
} from '../e2e/vault';

// Pictures for pull requests, not tests: `pnpm screenshots` in apps/web (see playwright.config.ts here).
test.skip(!process.env['SCREENSHOTS'], 'set SCREENSHOTS=1 to capture');

test.use({ viewport: { width: 1280, height: 800 } });

const PALETTES = [
  ['light', 'Light'],
  ['slate', 'Midnight slate'],
  ['warm', 'Warm charcoal'],
  ['oled', 'OLED black'],
] as const;

const shooter = (page: Page) => (name: string) =>
  page.screenshot({ path: `screenshots/${name}.png`, animations: 'disabled' });

test('capture the sign-in, admin, and settings pages in every palette', async ({ page, admin }) => {
  const shoot = shooter(page);
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await shoot('sign-in-light');

  await signIn(page, admin.email);
  await expectSignedIn(page);
  await page.goto('/admin');
  await expect(page.getByRole('table')).toBeVisible();
  await shoot('admin-accounts');
  await bothPalettes(page)('admin-accounts');

  await page.goto('/settings');
  for (const [palette, label] of PALETTES) {
    await page.getByRole('button', { name: label }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
    await shoot(`settings-${palette}`);
  }
  await page.getByRole('button', { name: 'System' }).click();
});

const PAGE = `Our router sits in the hall cupboard. Restart it before calling the provider.

## Wi-Fi

- **Network:** Home
- **Guests:** use the guest network, never the main one

## Checklist

| Step | Done |
| --- | --- |
| Restart the router | ✓ |
| Check the lights | ✓ |
`;

test('capture the vault: a page published, its draft, history, palettes, and the phone drawer', async ({
  page,
  freshPage,
  admin,
}) => {
  const shoot = shooter(page);
  // A fixed clock in the browser; dates the server records still vary.
  await page.clock.setFixedTime(new Date('2026-10-01T09:30:00Z'));
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Household');
  await page.getByRole('button', { name: 'Create folder' }).click();
  await page.getByRole('treeitem', { name: /Household/ }).hover();
  await page.getByRole('button', { name: 'Actions for Household' }).click();
  await page.getByRole('menuitem', { name: 'New page here' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill('Network notes');
  await page.getByRole('button', { name: 'Create page' }).click();
  await expect(page.locator('#page-title')).toHaveValue('Network notes');
  await page.locator('#page-source').fill(PAGE);
  await waitForSave(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('#page-source').fill(`${PAGE}\nAsk before changing the password.\n`);
  await waitForSave(page);
  await shoot('vault-draft');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: /Draft has changes/ })).toBeVisible();
  await shoot('vault-published');
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'History' }).getByText('Version 1')).toBeVisible();
  await shoot('vault-history');
  await page.keyboard.press('Escape');

  // Settings is reached inside the app: a reload would lock the vault.
  for (const [palette, label] of PALETTES) {
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('button', { name: label }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', palette);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Network notes', level: 1 })).toBeVisible();
    await shoot(`vault-published-${palette}`);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  await shoot('vault-phone-drawer');
});

/** Switch palettes from inside the app: a reload would lock the vault. */
async function usePalette(page: Page, [value, label]: (typeof PALETTES)[number]) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: label }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  await page.goBack();
}

async function unlock(page: Page) {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Lock vault' }).click();
  await page.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

test('capture sharing: the Share dialog, removal, a key change, Shared with me, members, and a new owner', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const reader = await freshPage();
  const editor = await freshPage();
  for (const person of [owner, reader, editor]) {
    await person.setViewportSize({ width: 1280, height: 800 });
    await person.clock.setFixedTime(new Date('2026-10-01T09:30:00Z'));
  }
  await memberWithVault(owner, adminPage, 'Olive Owner');
  const { email: readerEmail } = await memberWithVault(reader, adminPage, 'Rita Reader');
  const { email: editorEmail } = await memberWithVault(editor, adminPage, 'Eddie Editor');
  await newSpace(owner, 'Family');
  await newFolder(owner, 'Garden');
  await publishedPageIn(owner, 'Garden', 'Planting plan', PAGE);
  await newFolder(owner, 'Recipes');
  await publishedPageIn(owner, 'Recipes', 'Lentil soup', 'Lentils, carrots, cumin.');
  await publishedPageIn(owner, 'Recipes', 'Sourdough', 'Flour, water, salt, time.');
  const garden = await shareFolder(owner, 'Garden', editorEmail, 'publisher');
  await addPerson(garden, readerEmail, 'reader', 'Rita Reader');
  await owner.keyboard.press('Escape');
  await owner.getByRole('button', { name: 'Space menu' }).click();
  await owner.getByRole('menuitem', { name: 'Members and owners' }).click();
  await expect(owner.getByRole('heading', { name: 'Members and owners' })).toBeVisible();

  const palettes = [PALETTES[0], PALETTES[1]] as const;
  for (const palette of palettes) {
    const [name] = palette;
    await usePalette(reader, palette);
    await reader.getByRole('link', { name: 'Shared', exact: true }).click();
    await expect(reader.getByRole('link', { name: /Garden/ })).toContainText('Olive Owner');
    await shooter(reader)(`shared-with-me-${name}`);

    const shoot = shooter(owner);
    await usePalette(owner, palette);
    await expect(owner.getByRole('region', { name: 'Shared folders' })).toContainText('Garden');
    await shoot(`space-members-${name}`);

    // The first share of a folder: what goes, and the history that comes with it.
    await folderMenu(owner, 'Recipes', 'Share…');
    const recipes = shareDialog(owner, 'Recipes');
    await recipes.getByLabel('Email').fill(readerEmail);
    await pick(recipes.getByLabel('Access'), 'Editor');
    await recipes.getByRole('button', { name: 'Next' }).click();
    await expect(recipes.getByRole('region', { name: 'What will be shared' })).toContainText(
      'Sourdough',
    );
    await shoot(`sharing-preview-${name}`);
    await owner.keyboard.press('Escape');

    // Who has access, and what removing someone keeps.
    await owner
      .getByRole('region', { name: 'Shared folders' })
      .getByRole('button', { name: 'Manage' })
      .click();
    const dialog = shareDialog(owner, 'Garden');
    await expect(dialog.getByLabel('Access for Rita Reader')).toBeVisible();
    await shoot(`sharing-access-${name}`);
    await dialog.getByRole('button', { name: 'More for Rita Reader' }).click();
    await owner.getByRole('menuitem', { name: 'Remove from this folder' }).click();
    await expect(dialog).toContainText('Loses access');
    await shoot(`sharing-remove-${name}`);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await owner.keyboard.press('Escape');
  }

  // A changed key, held back until the owner checks it.
  await swapKey(readerEmail);
  for (const palette of palettes) {
    await usePalette(owner, palette);
    await owner
      .getByRole('region', { name: 'Shared folders' })
      .getByRole('button', { name: 'Manage' })
      .click();
    await shareDialog(owner, 'Garden').getByRole('button', { name: 'Key changed' }).click();
    await expect(owner.getByRole('region', { name: 'Rita Reader’s key changed' })).toBeVisible();
    await shooter(owner)(`sharing-key-change-${palette[0]}`);
    await owner.getByRole('button', { name: 'Not now' }).click();
    await owner.keyboard.press('Escape');
  }

  // A new owner is asked who added them after their next unlock. They wait
  // on Shared with me, outside the space, so the question can't open under
  // the account menu; the note after unlocking leads to it.
  await openShared(editor, 'Garden', 'Planting plan');
  await editor.getByRole('link', { name: 'Shared', exact: true }).click();
  await owner.getByRole('button', { name: 'Add co-owner' }).click();
  const adding = owner.getByRole('dialog', { name: 'Add a co-owner' });
  await adding.getByLabel('Email').fill(editorEmail);
  await adding.getByRole('button', { name: 'Next' }).click();
  await adding.getByRole('button', { name: 'Make owner' }).click();
  await expect(adding).toBeHidden({ timeout: 30_000 });
  for (const palette of palettes) {
    await usePalette(editor, palette);
    await expect(editor.getByRole('heading', { name: 'Shared with me' })).toBeVisible();
    await unlock(editor);
    const waiting = editor.locator('aside[aria-label="Waiting for you"]');
    await waiting.getByRole('link', { name: 'Family' }).click();
    const confirming = editor.getByRole('dialog', { name: /added you as an owner of “Family”/ });
    await expect(confirming).toBeVisible({ timeout: 30_000 });
    await shooter(editor)(`owner-confirm-${palette[0]}`);
    // Put off, so the next unlock asks again.
    await confirming.getByRole('button', { name: 'Not now' }).click();
    await expect(editor.getByRole('button', { name: 'Confirm who added you' })).toBeVisible();
    await shooter(editor)(`owner-put-off-${palette[0]}`);
    await editor.getByRole('link', { name: 'Shared', exact: true }).click();

    // Leaving shows who keeps each folder before any keys change.
    await usePalette(owner, palette);
    const owners = owner.getByRole('region', { name: 'Owners' });
    await owners.getByRole('button', { name: 'Leave' }).click();
    const leaving = owner.getByRole('dialog', { name: 'Leave this space' });
    await expect(leaving.getByText(/^Keeps access \(\d+\)$/)).toBeVisible();
    await shooter(owner)(`owner-leave-review-${palette[0]}`);
    await leaving.getByRole('button', { name: 'Cancel' }).click();
  }
});

test('capture the message for an account that has made as many spaces as the server allows', async ({
  page,
  freshPage,
  admin,
}) => {
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  // The real refusal's body; reaching the real cap would take a hundred spaces.
  await page.route('**/api/spaces', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          json: { error: { code: 'space-limit', message: 'Too many spaces.' } },
        })
      : route.fallback(),
  );
  await page.getByRole('button', { name: 'New space' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('One too many');
  await page.getByRole('button', { name: 'Create space' }).click();
  await expect(
    page.getByText('Your account has made as many spaces as this server allows.'),
  ).toBeVisible();
  await shooter(page)('space-limit');
});

const GARDEN = `## Beds

| Bed | Rows |
| :-- | ---: |
| A   |    3 |

- [ ] Water the beans
- [x] Sow the peas

See [[Watering]] before you start.
`;

test('capture the editors, [[ completion, search, the cover pickers and publication, in light and Midnight slate', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  const shoot = bothPalettes(page, 'm3-');
  await page.clock.setFixedTime(new Date('2026-10-01T09:30:00Z'));
  await memberWithVault(page, await adminTab(freshPage, admin.email), 'Olive Owner');
  await newSpace(page, 'Club');
  await newSpace(page, 'Garden');
  await newPage(page, 'Watering');
  await fillSource(page, '## Mornings\n\nBefore nine.\n\n## Evenings\n\nAfter six.');
  await waitForSave(page);
  await newPage(page, 'Spring beds');
  await fillSource(page, GARDEN);
  await waitForSave(page);
  await shoot('editor-source');

  // [[ in the source editor: titles, then a page's headings.
  const source = page.locator('#page-source');
  await source.focus();
  await source.press('ControlOrMeta+End');
  await page.keyboard.type('Then [[Wat');
  await expect(page.getByRole('option', { name: 'Watering' })).toBeVisible();
  await shoot('completion-source');
  await page.keyboard.press('Enter');
  await expectSource(page, /Then \[\[Watering\]\]$/);
  await waitForSave(page);

  await showIn(page, 'Visual');
  await shoot('editor-visual');
  await typeAtEnd(page, ' and [[Watering#');
  await expect(page.getByRole('option', { name: 'Evenings' })).toBeVisible();
  await shoot('completion-visual');
  await page.keyboard.press('Enter');
  await waitForSave(page);

  // The cover pickers, on the draft view.
  await page.getByRole('button', { name: 'Banner' }).click();
  const banner = page.getByRole('dialog', { name: 'Banner' });
  await banner.getByRole('button', { name: 'Meadow' }).click();
  await expect(banner.getByRole('button', { name: 'Meadow' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await waitForSave(page);
  await shoot('cover-banner');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add emoji' }).click();
  const emoji = page.getByLabel('Search emoji');
  await emoji.fill('seedling');
  await expect(page.getByRole('button', { name: 'seedling', exact: true })).toBeVisible();
  await shoot('cover-emoji');
  await emoji.press('Enter');
  await waitForSave(page);

  // Published, and on its way to another space.
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
  await shoot('published');
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Publish to another space…' }).click();
  const publishing = page.getByRole('dialog', { name: 'Publish “Spring beds” to another space' });
  await pick(publishing.getByLabel('Space'), 'Club');
  await publishing.getByRole('button', { name: 'Next' }).click();
  await expect(publishing.getByRole('region', { name: 'Who can read it there' })).toBeVisible();
  await shoot('publication-preview');
  await page.keyboard.press('Escape');

  // Search, from the rail.
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  const search = page.getByRole('dialog', { name: 'Search' });
  await search.getByRole('combobox', { name: 'Search pages' }).fill('water');
  await expect(search.getByRole('option')).toHaveCount(2);
  await shoot('search');
});
