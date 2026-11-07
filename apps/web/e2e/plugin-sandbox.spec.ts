import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, pick, test } from './fixtures';
import {
  ask,
  expectLoopStopped,
  fromFrame,
  frameRefusedAll,
  openSandbox,
  outsideServer,
  PROBE,
  probedRequests,
  refusedAll,
  start,
} from './sandbox';
import { adminTab, fillSource, memberWithVault, newPage, PASSPHRASE, waitForSave } from './vault';

const BUILD = fileURLToPath(new URL('../../../packages/plugin-sdk/src/build.ts', import.meta.url));
const PAGE_TOOLS = fileURLToPath(new URL('../../../examples/plugins/page-tools', import.meta.url));

// The app's service worker checks `/sw.js` again when the browser chooses,
// such as after a frame loads, and that request lands on the route the first
// test counts. The frames aren't the worker's, so these tests run without it.
test.use({ serviceWorkers: 'block' });

// The sandboxed frame that holds plugin scripts' workers (ADR 0002), driven
// from the app's page (`sandbox.ts`). The desktop app checks it under
// `app://` too (`apps/desktop/e2e/plugins.spec.ts`).
test('a script in the sandbox reaches no storage, cookies, page or network', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  const outside = await outsideServer();
  try {
    // Signed in and unlocked: a session cookie, and the tab's kept unlock in IndexedDB.
    await memberWithVault(page, await adminTab(freshPage, admin.email));
    await page.evaluate(async () => {
      localStorage.setItem('sandbox-secret', 'local');
      sessionStorage.setItem('sandbox-secret', 'session');
      await caches.open('sandbox-secret');
    });
    expect((await page.context().cookies()).length).toBeGreaterThan(0);
    const shownAt = page.url();
    const sandbox = await openSandbox(page);
    expect(await fromFrame(page)).toEqual(frameRefusedAll);

    // Its script's worker. Nothing it tries reaches the app's server or another one.
    const before = await probedRequests();
    await start(sandbox, 1, PROBE);
    const fromWorker = await ask(sandbox, 1, { app: baseURL, outside: outside.url });
    expect(fromWorker).toEqual({
      message: {
        origin: 'null',
        // What the SDK reads as `host.pluginId`.
        name: 'sandbox-test',
        indexedDB: expect.stringMatching(/^refused: /),
        // WebKit gives it an empty Cache Storage of its own; the others refuse.
        caches: expect.not.stringContaining('sandbox-secret'),
        session: 'refused: TypeError',
        app: refusedAll,
        outside: refusedAll,
      },
    });
    expect(outside.arrived).toEqual([]);
    expect(await probedRequests()).toBe(before);
    expect(page.url()).toBe(shownAt);
  } finally {
    outside.close();
  }
});

test('a script in a loop is stopped while the page keeps answering', async ({ page }) => {
  await page.goto('/sign-in');
  await expectLoopStopped(page);
});

// A library plugin in the browser, from upload to removal (ADR 0002): its
// styles, app code and script all come from the server's library route,
// the script running in a worker in the sandboxed frame, and a version
// removed from the library stops loading.
test('a library plugin runs in the browser until it leaves the library', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, [BUILD, 'build', PAGE_TOOLS], { stdio: 'inherit' });
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Tools');
  await fillSource(page, 'Three short words.');
  await waitForSave(page);
  const shownAt = page.url();

  // Uploaded from its built folder, which installs it once approved.
  await page.goto('/settings/plugins?tab=library');
  await page.getByLabel('Plugin folder').setInputFiles(`${PAGE_TOOLS}/dist`);
  const approval = page.getByRole('dialog');
  await expect(approval).toContainText('App');
  await expect(approval).toContainText(/[0-9a-f]{64}/);
  await approval.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Uploaded and installed Page tools 0.1.0.')).toBeVisible({
    timeout: 15_000,
  });
  const tab = (name: 'Installed' | 'Library') =>
    page.getByRole('navigation', { name: 'Plugins' }).getByRole('link', { name }).click();
  await tab('Installed');
  const listed = page
    .getByRole('list', { name: 'Plugin library' })
    .getByRole('listitem', { name: 'Page tools' });
  const installed = page
    .getByRole('list', { name: 'Installed plugins' })
    .getByRole('listitem', { name: 'Page tools' });
  await expect(installed.getByRole('switch', { name: 'Page tools enabled' })).toBeChecked();
  await installed.getByRole('button', { name: /^Where/ }).click();
  await page
    .getByRole('menuitemradio', { name: /whole space/ })
    .first()
    .click();
  await pick(installed.getByRole('button', { name: /^Access/ }), 'Read and write');
  await installed.getByRole('button', { name: 'Add' }).click();
  await expect(installed.getByRole('list', { name: 'Page access' })).toContainText(
    'read and write',
  );

  // On the page, after a reload: its styles, its panel, and its script's
  // command, which writes a page through the access given.
  await page.goto(shownAt);
  const fromLibrary = /^\/plugins\/page-tools\/[0-9a-f]{64}\/page-tools\.css$/;
  await expect(page.locator('link[data-plugin="page-tools"]')).toHaveAttribute('href', fromLibrary);
  await page.getByRole('button', { name: 'Plugins' }).click();
  await page.getByRole('menuitem', { name: 'Page stats' }).click();
  await expect(page.getByTestId('page-tools-words')).toHaveText('3');
  await page.keyboard.press('Escape');
  await expect(page.locator('iframe[src="/plugin-host.html"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Plugins' }).click();
  await page.getByRole('menuitem', { name: 'Write this folder’s index' }).click();
  await expect(page.getByRole('treeitem', { name: /^Index/ })).toBeVisible();

  // Safe mode in this tab: nothing loads until it is turned off.
  await page.goto('/settings?safe-mode');
  const banner = page.locator('[data-region="safe-mode"]');
  await expect(banner).toContainText('plugins are off');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('link[data-plugin]')).toHaveCount(0);
  await banner.getByRole('button', { name: 'Turn plugins back on' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('link[data-plugin="page-tools"]')).toHaveCount(1);

  // Removed from the library: it stops, and Settings says why.
  await page.goto('/settings/plugins?tab=library');
  await listed.getByRole('button', { name: 'Remove from library' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('list', { name: 'Plugin library' })).toHaveCount(0);
  await tab('Installed');
  const gone = page
    .getByRole('list', { name: 'Installed plugins' })
    .getByRole('listitem', { name: 'page-tools' });
  await expect(gone).toContainText('no longer in the library');
  await expect(page.locator('link[data-plugin]')).toHaveCount(0);
  await expect(page.locator('iframe[src="/plugin-host.html"]')).toHaveCount(0);
  await gone.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('list', { name: 'Installed plugins' })).toHaveCount(0);
});

// A plugin drawing the rail hides the rail's way to Settings (ADR 0011,
// decision 6). Each way back still reaches Settings → Plugins: the safe
// mode keys, `?safe-mode` in the address, and Open without plugins as the
// vault is unlocked, each showing the banner that links there.
test('a plugin drawing the rail leaves every way back to its settings', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(120_000);
  // Built by hand: a manifest and a ui file are all a plugin folder needs.
  const dist = mkdtempSync(join(tmpdir(), 'own-rail-'));
  writeFileSync(
    join(dist, 'wikistow-plugin.json'),
    JSON.stringify({
      id: 'own-rail',
      name: 'Own rail',
      version: '0.1.0',
      api: 1,
      ui: 'ui.js',
      replaces: ['rail'],
    }),
  );
  writeFileSync(
    join(dist, 'ui.js'),
    `export default {
      activate(host) {
        host.ui.replace('rail', {
          id: 'rail',
          view(element) {
            element.textContent = 'A rail of its own';
          },
        });
      },
    };`,
  );
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const space = page.url();
  await page.goto('/settings/plugins?tab=library');
  await page.getByLabel('Plugin folder').setInputFiles(dist);
  const approval = page.getByRole('dialog');
  await expect(approval).toContainText('It replaces the rail with its own.');
  await approval.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Uploaded and installed Own rail 0.1.0.')).toBeVisible({
    timeout: 15_000,
  });

  const ownRail = page.getByRole('navigation', { name: 'Spaces and navigation' });
  const banner = page.locator('[data-region="safe-mode"]');
  /** In the space: the plugin's rail, with no link to Settings anywhere. */
  const replaced = async () => {
    await page.goto(space);
    await expect(page.getByText('A rail of its own')).toBeVisible();
    await expect(ownRail).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  };
  /** Safe mode: the app's own rail, and the banner, which leads to Settings → Plugins. */
  const safe = async () => {
    await expect(banner).toContainText('plugins are off');
    await expect(ownRail).toBeVisible();
    await expect(page.getByText('A rail of its own')).toHaveCount(0);
    await banner.getByRole('link', { name: 'Manage plugins' }).click();
    await expect(page).toHaveURL(/\/settings\/plugins$/);
    await expect(
      page
        .getByRole('list', { name: 'Installed plugins' })
        .getByRole('listitem', { name: 'Own rail' }),
    ).toBeVisible();
    await banner.getByRole('button', { name: 'Turn plugins back on' }).click();
    await expect(banner).toHaveCount(0);
  };

  await replaced();
  // The safe mode keys, which reload the tab without plugins.
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await safe();
  await replaced();
  // The address.
  await page.goto(`${space}?safe-mode`);
  await safe();
  await replaced();
  // Open without plugins, in a new tab, which unlocks afresh.
  const other = await page.context().newPage();
  await other.goto(space);
  await other.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await other.getByRole('button', { name: 'Open without plugins' }).click();
  await expect(other.locator('[data-region="safe-mode"]')).toContainText('plugins are off');
  await expect(other.getByRole('navigation', { name: 'Spaces and navigation' })).toBeVisible();
  await other
    .locator('[data-region="safe-mode"]')
    .getByRole('link', { name: 'Manage plugins' })
    .click();
  await expect(other).toHaveURL(/\/settings\/plugins$/);
});
