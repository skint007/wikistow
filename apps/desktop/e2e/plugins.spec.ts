import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { showIn, visual } from '../../web/e2e/editor';
import { expect, pick, serverBlobDir, test } from '../../web/e2e/fixtures';
import {
  adminTab,
  expectSource,
  fillSource,
  memberWithVault,
  newPage,
  PASSPHRASE,
  waitForSave,
} from '../../web/e2e/vault';
import { accountMenu, launch, newProfile, signInThroughBrowser, type Desktop } from './desktop';

const PROBE = fileURLToPath(new URL('probe-plugin', import.meta.url));
const BUILD = fileURLToPath(new URL('../../../packages/plugin-sdk/src/build.ts', import.meta.url));
const CALCULATOR = fileURLToPath(new URL('../../../examples/plugins/calculator', import.meta.url));

let desktop: Desktop | null = null;
test.afterEach(async () => {
  await desktop?.app.close();
  desktop = null;
});

/** What the page says a plugin command did (the probe throws its outcome). */
async function runCommand(window: Page, title: string) {
  await window.getByRole('button', { name: 'Plugins' }).click();
  await window.getByRole('menuitem', { name: title }).click();
  const notice = window.getByRole('alert').filter({ hasText: title });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  const text = (await notice.textContent()) ?? '';
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  return text;
}

// In the app, never by loading an address: that would lock the vault.
const toSettings = (window: Page) => window.getByRole('link', { name: 'Settings' }).first().click();
const backToPage = async (window: Page) => {
  await window.goBack();
  await expect(window.locator('#page-title')).toHaveValue('Probed');
};

async function setAccess(window: Page, access: 'none' | 'Read' | 'Read and write') {
  const probe = window.getByRole('listitem', { name: 'Probe' });
  const listed = probe.getByRole('list', { name: 'Page access' });
  if (await listed.isVisible()) await listed.getByRole('button', { name: 'Remove' }).click();
  if (access === 'none') return;
  await pick(probe.getByRole('button', { name: /^Where/ }), (await wholeSpace(window)) ?? '');
  await pick(probe.getByRole('button', { name: /^Access/ }), access);
  await probe.getByRole('button', { name: 'Add' }).click();
  await expect(probe.getByRole('list', { name: 'Page access' })).toContainText(
    access === 'Read' ? ': read' : 'read and write',
  );
}

async function wholeSpace(window: Page) {
  const probe = window.getByRole('listitem', { name: 'Probe' });
  await probe.getByRole('button', { name: /^Where/ }).click();
  const option = window.getByRole('menuitemradio', { name: /whole space/ }).first();
  const name = await option.textContent();
  await window.keyboard.press('Escape');
  return name;
}

// A script plugin installed from a folder: its worker reaches nothing but
// the host, and the host gives it only the page access the person chose.
test('a script plugin gets only the page access it is given', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.setTimeout(240_000);
  execFileSync(process.execPath, [BUILD, 'build', PROBE], { stdio: 'inherit' });
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  desktop = await launch(await newProfile());
  const { app, window } = desktop;
  await signInThroughBrowser(desktop, page, baseURL ?? '');
  await window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await window.getByRole('button', { name: 'Unlock' }).click();
  await newPage(window, 'Probed');
  await fillSource(window, 'Before the probe.');
  await waitForSave(window);

  // The folder dialog answers with the built probe.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, `${PROBE}/dist`);
  await toSettings(window);
  await window.getByRole('button', { name: 'Install plugin…' }).click();
  const approval = window.getByRole('dialog');
  await expect(approval).toContainText('Script');
  await expect(approval).toContainText('sandbox');
  await approval.getByRole('button', { name: 'Install' }).click();
  await expect(window.getByRole('listitem', { name: 'Probe' })).toBeVisible();

  await backToPage(window);
  // The worker's own policy refuses every request, the app's API included.
  expect(await runCommand(window, 'Try the network')).toContain('network blocked');
  // The page shown needs no access. What was typed just before is kept:
  // the handle reads the draft as it is now, not as it opened.
  await fillSource(window, 'Typed before appending.');
  await waitForSave(window);
  await window.getByRole('button', { name: 'Plugins' }).click();
  await window.getByRole('menuitem', { name: 'Append a line' }).click();
  await expectSource(window, 'Typed before appending.\n\nAppended by the probe.\n');
  await waitForSave(window);
  // No page access: not even reading.
  expect(await runCommand(window, 'Save a draft here')).toContain('may not read there');

  await toSettings(window);
  await setAccess(window, 'Read');
  await backToPage(window);
  // Read access reads, but can't save.
  expect(await runCommand(window, 'Save a draft here')).toContain('may not change pages there');

  await toSettings(window);
  await setAccess(window, 'Read and write');
  await backToPage(window);
  expect(await runCommand(window, 'Save a draft here')).toContain('write saved');

  // Disabled, it registers nothing: no menu, no commands. The page opened
  // again shows the draft the probe saved.
  await toSettings(window);
  await window.getByRole('switch', { name: 'Probe enabled' }).click();
  await expect(window.getByRole('switch', { name: 'Probe enabled' })).not.toBeChecked();
  await backToPage(window);
  await expect(window.locator('#page-source')).toContainText('The probe wrote this.');
  await expect(window.getByRole('button', { name: 'Plugins' })).toHaveCount(0);
});

// A plugin shared to the library from one computer and approved there
// installs on another at unlock, from the server, only once every file
// matches the approved hash; a file changed on the server is refused.
test('a library plugin installs at unlock, checked against its hash', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.setTimeout(300_000);
  execFileSync(process.execPath, [BUILD, 'build', PROBE], { stdio: 'inherit' });
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const unlock = async (window: Page) => {
    await window.getByLabel('Vault passphrase').fill(PASSPHRASE);
    await window.getByRole('button', { name: 'Unlock' }).click();
  };
  const copies = (profile: string) =>
    readdir(join(profile, 'library-plugins', 'probe')).catch(() => []);

  // The first computer installs the probe from its folder, shares it, and
  // installs it again from the library in its place.
  desktop = await launch(await newProfile());
  const first = desktop;
  await signInThroughBrowser(first, page, baseURL ?? '');
  await unlock(first.window);
  await newPage(first.window, 'Probed');
  await first.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, `${PROBE}/dist`);
  await toSettings(first.window);
  await first.window.getByRole('button', { name: 'Install plugin…' }).click();
  await first.window.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
  const folderInstall = first.window
    .getByRole('list', { name: 'Installed plugins' })
    .getByRole('listitem', { name: 'Probe' });
  await folderInstall.getByRole('button', { name: 'Share to library…' }).click();
  await first.window.getByRole('dialog').getByRole('button', { name: 'Share' }).click();
  await expect(first.window.getByText('Shared Probe 1.0.0 to the library.')).toBeVisible();
  await folderInstall.getByRole('button', { name: 'Remove Probe' }).click();
  await expect(folderInstall).toHaveCount(0);
  await first.window
    .getByRole('list', { name: 'Plugin library' })
    .getByRole('listitem', { name: 'Probe' })
    .getByRole('button', { name: 'Install…' })
    .click();
  await first.window.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
  await expect(
    first.window
      .getByRole('list', { name: 'Installed from the library' })
      .getByRole('listitem', { name: 'Probe' }),
  ).toBeVisible();
  const [hash = ''] = await copies(first.profile);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await backToPage(first.window);
  expect(await runCommand(first.window, 'Try the network')).toContain('network blocked');
  await first.app.close();

  // Changed on the server after it was approved: the second computer refuses it.
  const script = join(await serverBlobDir(), 'plugins', hash, 'script.js');
  const original = await readFile(script);
  await writeFile(script, Buffer.concat([original, Buffer.from('\n// changed\n')]));
  desktop = await launch(await newProfile());
  const second = desktop;
  await signInThroughBrowser(second, page, baseURL ?? '');
  await unlock(second.window);
  await newPage(second.window, 'Second computer');
  await toSettings(second.window);
  await expect(
    second.window
      .getByRole('list', { name: 'Installed from the library' })
      .getByRole('listitem', { name: 'Probe' })
      .getByRole('alert'),
  ).toContainText('don’t match the version you approved');
  expect(await copies(second.profile)).toEqual([]);

  // Put back, it installs at the next unlock, with nothing to approve, and runs.
  await writeFile(script, original);
  await second.window.goBack();
  await expect(second.window.locator('#page-title')).toHaveValue('Second computer');
  await accountMenu(second.window, 'Lock vault');
  await unlock(second.window);
  expect(await runCommand(second.window, 'Try the network')).toContain('network blocked');
  expect(await copies(second.profile)).toEqual([hash]);
});

// A plugin block is the fence's text, drawn as a form for its script: each
// field edited there rewrites its own line as the person's own text, the
// block is never joined into from beside it, it is kept as text while the
// plugin is off, and in the reader what a reader enters stays theirs.
test('a plugin block keeps its page text whole', async ({ page, freshPage, admin, baseURL }) => {
  test.setTimeout(240_000);
  execFileSync(process.execPath, [BUILD, 'build', CALCULATOR], { stdio: 'inherit' });
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  desktop = await launch(await newProfile());
  const { app, window } = desktop;
  await signInThroughBrowser(desktop, page, baseURL ?? '');
  await window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await window.getByRole('button', { name: 'Unlock' }).click();
  await newPage(window, 'Prices');
  const text = (quantity: number) =>
    `Before.\n\n\`\`\`plugin:calculator/product\nnote: seeds\nquantity: ${quantity}\nprice: 3.5\n\`\`\`\n\nAfter.\n`;
  await fillSource(window, text(2));
  await waitForSave(window);

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, `${CALCULATOR}/dist`);
  const settings = () => window.getByRole('link', { name: 'Settings' }).first().click();
  const toggle = async (checked: boolean) => {
    await settings();
    await window.getByRole('switch', { name: 'Calculator enabled' }).click();
    await expect(window.getByRole('switch', { name: 'Calculator enabled' })).toBeChecked({
      checked,
    });
    await window.goBack();
  };
  await settings();
  await window.getByRole('button', { name: 'Install plugin…' }).click();
  await window.getByRole('dialog').getByRole('button', { name: 'Install' }).click();
  await expect(window.getByRole('listitem', { name: 'Calculator' })).toBeVisible();
  await window.goBack();

  await showIn(window, 'Visual');
  const total = visual(window).locator('output[data-output="total"]');
  await expect(total).toHaveText('7');
  await visual(window).getByLabel('Quantity').fill('4');
  await expect(total).toHaveText('14');
  // Backspace at the start of the next line selects the block: its hidden text takes nothing.
  await visual(window)
    .locator('p', { hasText: 'After.' })
    .evaluate((paragraph) => {
      paragraph.closest<HTMLElement>('#page-visual')?.focus();
      const selection = paragraph.ownerDocument.getSelection();
      selection?.selectAllChildren(paragraph);
      selection?.collapseToStart();
      paragraph.ownerDocument.dispatchEvent(new Event('selectionchange'));
    });
  await window.keyboard.press('Backspace');
  await expect(visual(window).locator('.code-block.ProseMirror-selectednode')).toHaveCount(1);
  await waitForSave(window);
  await showIn(window, 'Source');
  await expectSource(window, text(4));

  await window.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(window.getByText('Published v1')).toBeVisible();
  const reader = window.locator('.page-body');
  const readerTotal = reader.locator('output[data-output="total"]');
  await reader.getByLabel('Quantity').fill('10');
  await expect(readerTotal).toHaveText('35');
  // The page around it drawn again (History opening) leaves the reader's values.
  await window.getByRole('button', { name: 'History' }).click();
  await expect(window.getByRole('dialog')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(readerTotal).toHaveText('35');

  await toggle(false);
  await expect(reader).toContainText('without the calculator plugin');
  await expect(reader).toContainText('quantity: 4');
  await toggle(true);
  await expect(readerTotal).toHaveText('14');
});
