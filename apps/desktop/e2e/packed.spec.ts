import { listPackage } from '@electron/asar';
import { _electron, expect, test } from '@playwright/test';
import type { DesktopBridge } from '@wikistow/contracts';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { embedIn, embedWorker, PASSAGES, QUERY } from '../../web/e2e/meaning';
import { launch, newProfile } from './desktop';

// The app as the Arch package installs it: the one app.asar `scripts/asar.ts`
// packs, with the pages, bundles and icon inside. CI packs it in its build
// step; locally, `node scripts/asar.ts` first.
const ASAR = fileURLToPath(new URL('../out/app.asar', import.meta.url));
// WikiStow.app as scripts/macos-app.sh builds it, for CI's macOS job.
const MAC_APP = process.env['MAC_APP'];

declare global {
  interface Window {
    wikistowDesktop?: DesktopBridge;
  }
}

test('the packed app starts on its own pages', async () => {
  test.skip(Boolean(MAC_APP), 'the Mac app is checked on its own');
  const packed = await access(ASAR).then(
    () => true,
    () => false,
  );
  test.skip(!packed && !process.env['CI'], 'pack it first: node scripts/asar.ts');
  const desktop = await launch(await newProfile(), [], ASAR);
  try {
    await expect(desktop.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(await desktop.app.evaluate(({ app }) => app.getName())).toBe('WikiStow');
  } finally {
    await desktop.app.close();
  }
});

// The app ships the search model and the runtime's WebAssembly, and runs
// them under its own policy from its files, with no cache of its own and
// without the Brotli copies, which only the server sends (ADR 0016, step 2).
test('the packed app embeds a text with the model it carries', async () => {
  test.skip(Boolean(MAC_APP), 'the Mac app is checked on its own');
  test.setTimeout(120_000);
  const packed = await access(ASAR).then(
    () => true,
    () => false,
  );
  test.skip(!packed && !process.env['CI'], 'pack it first: node scripts/asar.ts');
  const files = listPackage(ASAR, { isPack: false });
  expect(files.filter((file) => file.endsWith('.br'))).toEqual([]);
  expect(files.filter((file) => /\/web\/assets\/meaning\/.+\.onnx$/.test(file))).toHaveLength(1);
  const desktop = await launch(await newProfile(), [], ASAR);
  try {
    const { window } = desktop;
    await expect(window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const worker = await embedWorker(
      fileURLToPath(new URL('../../web/dist/assets/', import.meta.url)),
    );
    const run = await embedIn(window, worker, { keep: false, query: QUERY, passages: PASSAGES });
    const { from, loadMs, firstMs, queryMs, passageMs, passageTokens } = run;
    test.info().annotations.push({
      type: 'timing',
      description: JSON.stringify({
        name: 'desktop',
        from,
        loadMs,
        firstMs,
        queryMs,
        passageMs,
        passageTokens,
      }),
    });
    expect(from).toBe('files');
    expect(run.query).toHaveLength(384);
    const [holiday = 0, boiler = 0] = run.scores;
    expect(holiday).toBeGreaterThan(boiler + 0.1);
    expect(await window.evaluate(() => caches.keys())).toEqual([]);
  } finally {
    await desktop.app.close();
  }
});

// Starts with its own pages, its menu bar, the Keychain as its secret store,
// and the system's window buttons in place of the titlebar's.
test('the Mac app starts', async () => {
  test.skip(!MAC_APP, 'build it on a Mac first: scripts/macos-app.sh, then MAC_APP=<WikiStow.app>');
  const app = await _electron.launch({
    executablePath: `${MAC_APP}/Contents/MacOS/WikiStow`,
    args: [`--user-data-dir=${await newProfile()}`],
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    const { name, menu } = await app.evaluate(({ app, Menu }) => ({
      name: app.getName(),
      menu: Menu.getApplicationMenu()?.items.map((item) => item.label),
    }));
    expect(name).toBe('WikiStow');
    expect(menu).toEqual(['WikiStow', 'Edit', 'View', 'Window']);
    expect(await page.evaluate(() => window.wikistowDesktop?.secureStorage())).toBe(true);
    const titlebar = page.getByRole('group', { name: 'Window' });
    await expect(titlebar).toBeVisible();
    await expect(titlebar.getByRole('button')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
