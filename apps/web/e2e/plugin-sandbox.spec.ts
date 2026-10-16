import { execFileSync } from 'node:child_process';
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
import { adminTab, fillSource, memberWithVault, newPage, waitForSave } from './vault';

const BUILD = fileURLToPath(new URL('../../../packages/plugin-sdk/src/build.ts', import.meta.url));
const PAGE_TOOLS = fileURLToPath(new URL('../../../examples/plugins/page-tools', import.meta.url));

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
  await page.goto('/settings');
  await page.getByLabel('Plugin folder').setInputFiles(`${PAGE_TOOLS}/dist`);
  const approval = page.getByRole('dialog');
  await expect(approval).toContainText('App');
  await expect(approval).toContainText(/[0-9a-f]{64}/);
  await approval.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Uploaded and installed Page tools 0.1.0.')).toBeVisible({
    timeout: 15_000,
  });
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
  await listed.getByRole('button', { name: 'Remove from library' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('list', { name: 'Plugin library' })).toHaveCount(0);
  const gone = page
    .getByRole('list', { name: 'Installed plugins' })
    .getByRole('listitem', { name: 'page-tools' });
  await expect(gone).toContainText('no longer in the library');
  await expect(page.locator('link[data-plugin]')).toHaveCount(0);
  await expect(page.locator('iframe[src="/plugin-host.html"]')).toHaveCount(0);
  await gone.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('list', { name: 'Installed plugins' })).toHaveCount(0);
});
