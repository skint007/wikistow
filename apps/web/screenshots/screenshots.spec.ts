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
  sourceOf,
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

test('capture deleting a shared space, and someone viewing it sent to their home space', async ({
  page: owner,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const adminPage = await adminTab(freshPage, admin.email);
  const member = await freshPage();
  await member.setViewportSize({ width: 1280, height: 800 });
  await memberWithVault(owner, adminPage, 'Dana Deleter');
  const { email } = await memberWithVault(member, adminPage, 'Milo Member');
  await newSpace(owner, 'Book club');
  await newFolder(owner, 'Reading list');
  await publishedPageIn(owner, 'Reading list', 'October', 'Two novels and a short story.');
  await shareFolder(owner, 'Reading list', email, 'editor');
  await owner.keyboard.press('Escape');
  await openShared(member, 'Reading list', 'October');
  // Changes to a busy space gather for a few seconds before anyone hears of
  // them. Let the member's app hear of the share before the space goes.
  await member.waitForTimeout(4_000);

  await owner.getByRole('button', { name: 'Space menu' }).click();
  await owner.getByRole('menuitem', { name: 'Delete space…' }).click();
  const deleting = owner.getByRole('dialog', { name: 'Delete this space' });
  await expect(deleting.getByText('Milo Member')).toBeVisible();
  await deleting.getByLabel(/Type the space’s name/).fill('Book club');
  await shooter(owner)('delete-space');
  await deleting.getByRole('button', { name: 'Delete for good' }).click();
  await expect(owner.getByRole('heading', { name: 'Personal', level: 2 })).toBeVisible();
  // The member's app hears the space is gone and goes home.
  await expect(member.getByRole('heading', { name: 'Personal', level: 2 })).toBeVisible({
    timeout: 30_000,
  });
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
  await memberWithVault(page, await adminTab(freshPage, admin.email));
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

const PLANTING = (
  image: string,
) => `Spring is the busy season. Here is the plan for the **front beds**, with a few _notes_ on timing.

## What goes where

- Peas along the fence, sown in March
- Lettuce in the shady corner
- Beans once the soil is warm

${image}

## Setting up the timer

\`\`\`sh
timer set --zone front --start 06:30 --minutes 20
\`\`\`

Water as [[Watering]] says, and check the beds every Saturday.
`;

/** A small drawing of a garden, as a PNG, so the public page shows a real image. */
async function gardenPicture(page: Page) {
  const base64 = await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(480, 240);
    const draw = canvas.getContext('2d');
    if (!draw) throw new Error('No 2D context');
    const sky = draw.createLinearGradient(0, 0, 0, 240);
    sky.addColorStop(0, '#9fd3f5');
    sky.addColorStop(1, '#e6f4fb');
    draw.fillStyle = sky;
    draw.fillRect(0, 0, 480, 240);
    draw.fillStyle = '#f7c948';
    draw.beginPath();
    draw.arc(390, 60, 30, 0, Math.PI * 2);
    draw.fill();
    draw.fillStyle = '#6aa84f';
    draw.fillRect(0, 160, 480, 80);
    draw.fillStyle = '#8b5a2b';
    for (const x of [40, 180, 320]) draw.fillRect(x, 175, 120, 40);
    draw.fillStyle = '#2e7d32';
    for (const x of [60, 100, 140, 200, 240, 280, 340, 380, 420]) {
      draw.beginPath();
      draw.arc(x, 180, 12, Math.PI, 0);
      draw.fill();
    }
    const bytes = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  return Buffer.from(base64, 'base64');
}

/** Open a page's public link dialog from its right-click menu in the tree. */
async function openLinkDialog(page: Page, title: string) {
  await page.getByRole('treeitem', { name: new RegExp(title) }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Share public link…' }).click();
}

test('capture public links: the dialog, the markers, the Publish prompt and the public page', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(240_000);
  const shoot = bothPalettes(page, 'public-link-');
  await page.clock.setFixedTime(new Date('2026-10-01T09:30:00Z'));
  const picture = await gardenPicture(page);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newSpace(page, 'Garden club');

  // A page to link to, with a link of its own.
  await newPage(page, 'Watering');
  await fillSource(page, '## Mornings\n\nWater before nine, at the roots.');
  await waitForSave(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
  await openLinkDialog(page, 'Watering');
  let dialog = page.getByRole('dialog', { name: 'Share “Watering” with a public link?' });
  await expect(dialog.getByText('The server keeps a readable copy.')).toBeVisible();
  await shoot('dialog-first');
  await dialog.getByRole('button', { name: 'Turn on public link' }).click();
  dialog = page.getByRole('dialog', { name: 'Public link for “Watering”' });
  await expect(dialog.getByLabel('Public link')).toHaveValue(/\/p\/[\w-]{22}$/);
  await shoot('dialog-on');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The page itself: formatting, an image, code, and a link to the public page above.
  await newPage(page, 'Spring planting');
  await page
    .locator('input[type=file]')
    .setInputFiles({ name: 'beds.png', mimeType: 'image/png', buffer: picture });
  await expectSource(page, /attachment:/);
  const image = (await sourceOf(page)).trim();
  await fillSource(page, PLANTING(image));
  await waitForSave(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();

  // Its first upload fails, so the link is on and the public page out of date.
  await page.route('**/api/pages/*/public-copies', (route) => route.abort());
  await page.getByRole('button', { name: 'Page actions' }).click();
  await page.getByRole('menuitem', { name: 'Share public link…' }).click();
  await page.getByRole('button', { name: 'Turn on public link' }).click();
  dialog = page.getByRole('dialog', { name: 'Public link for “Spring planting”' });
  await expect(dialog.getByText('The public page is out of date.')).toBeVisible();
  await page.unroute('**/api/pages/*/public-copies');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'Public link ›' }).click();
  await expect(dialog.getByText('The public page is out of date.')).toBeVisible();
  await shoot('dialog-out-of-date');
  await dialog.getByRole('button', { name: 'Update public page' }).click();
  await expect(dialog.getByText('The public page is out of date.')).toBeHidden();
  const url = await dialog.getByLabel('Public link').inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('treeitem', { name: /Spring planting/ })).toContainText(
    'Public link',
  );
  await shoot('markers');

  // Publish asks first on a page with a link.
  await page.getByRole('button', { name: 'Edit' }).click();
  await fillSource(page, `${PLANTING(image)}\nSow the second row of peas in April.\n`);
  await waitForSave(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const asking = page.getByRole('dialog', { name: 'Publish “Spring planting”?' });
  await expect(asking.getByText('This page has a public link.')).toBeVisible();
  await shoot('publish-prompt');
  await asking.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published v2')).toBeVisible();

  // The public page, as anyone with the link sees it.
  const visitor = await freshPage();
  await visitor.setViewportSize({ width: 1280, height: 800 });
  await visitor.goto(url);
  await expect(visitor.getByText('Sow the second row of peas in April.')).toBeVisible();
  await expect(visitor.getByRole('link', { name: 'Watering' })).toBeVisible();
  await visitor.screenshot({ path: 'screenshots/public-link-page.png', fullPage: true });
});

const RECIPE_PROPERTIES = `# From Obsidian
title: Garlic bread
tags: [recipe, bread, sides]
cook_time: 25 # minutes
servings: 4
vegetarian: true
created: 2026-10-12
source: https://example.com/garlic-bread
goes_with: "[[Tomato soup]]"
notes: |
  Use fresh garlic.`;

test('capture the property rows, on the published and the draft view, wide and on a phone', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const shoot = bothPalettes(page, 'properties-');
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newSpace(page, 'Kitchen');
  await newPage(page, 'Tomato soup');
  await fillSource(page, 'Simmer for an hour.');
  await waitForSave(page);
  await newPage(page, 'Garlic bread');
  await page.getByRole('button', { name: 'Add properties' }).click();
  await page.getByLabel('New property’s name').press('Escape');
  await page.getByRole('button', { name: 'Edit as text' }).click();
  await page.getByLabel('Properties as text').fill(RECIPE_PROPERTIES);
  await page.getByRole('button', { name: 'Show as rows' }).click();
  await fillSource(page, 'Slice the loaf, butter it, and bake.');
  await waitForSave(page);
  const rows = page.getByRole('region', { name: 'Properties' });
  await rows.getByRole('button', { name: /^Cook time/ }).hover();
  await shoot('draft', rows);
  await shoot('draft-phone', page, true);
  await rows.getByRole('button', { name: 'Actions for Servings' }).click();
  await page.getByRole('menuitem', { name: 'Type' }).click();
  await shoot('menu', page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
  await page.getByRole('button', { name: 'Show 3 more' }).waitFor();
  await shoot('reader', rows);
  await shoot('reader-phone', page, true);
  await page.getByRole('button', { name: 'Show 3 more' }).click();
  await shoot('reader-all', rows);
});

test('capture property references: in the reader, the visual editor and its completion', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  const shoot = bothPalettes(page, 'references-');
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newSpace(page, 'Kitchen');
  await newPage(page, 'Tomato soup');
  await fillSource(page, 'Simmer for an hour.');
  await waitForSave(page);
  await newPage(page, 'Garlic bread');
  await page.getByRole('button', { name: 'Add properties' }).click();
  await page.getByLabel('New property’s name').press('Escape');
  await page.getByRole('button', { name: 'Edit as text' }).click();
  await page.getByLabel('Properties as text').fill(RECIPE_PROPERTIES);
  await page.getByRole('button', { name: 'Show as rows' }).click();
  await fillSource(
    page,
    'Serves `=servings`, ready in `=cook time` minutes. Tagged `= this.tags`, written `=created`, and best with `=goes_with`.\n\nNot a property: `=oven`.',
  );
  await waitForSave(page);
  await showIn(page, 'Visual');
  const visual = page.locator('#page-visual');
  await expect(visual.locator('[data-hint="servings · property"]')).toHaveText('4');
  await shoot('visual', visual);
  await typeAtEnd(page, ' Bake at `=se');
  await expect(page.getByRole('listbox', { name: 'Property' })).toBeVisible();
  await shoot('completion', page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await waitForSave(page);

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
  const body = page.locator('.page-body').first();
  await expect(body.getByText('4', { exact: true })).toBeVisible();
  await body.getByText('4', { exact: true }).hover();
  await shoot('reader', page);
  await shoot('reader-phone', page, true);
});
