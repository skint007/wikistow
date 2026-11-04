import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../web/e2e/fixtures';
import { adminTab, memberWithVault } from '../../web/e2e/vault';
import { catchBrowser, launch, newProfile } from './desktop';

// The packed app where the AUR's beta package puts it, which is what makes
// it the beta (src/install.ts). Writing there needs root, as in CI's
// container, and the packed app (`node scripts/asar.ts`).
const FOLDER = '/usr/lib/wikistow-desktop-beta';
const BETA = `${FOLDER}/app.asar`;
const ASAR = fileURLToPath(new URL('../out/app.asar', import.meta.url));

test('the beta app signs in through its own wikistow-beta:// link', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.setTimeout(180_000);
  test.skip(process.getuid?.() !== 0, `installing it in ${FOLDER} needs root, as in CI`);
  const packed = await access(ASAR).then(
    () => true,
    () => false,
  );
  test.skip(!packed && !process.env['CI'], 'pack it first: node scripts/asar.ts');
  await mkdir(FOLDER, { recursive: true });
  await copyFile(ASAR, BETA);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const profile = await newProfile();
  const desktop = await launch(profile, [], BETA);
  try {
    expect(await desktop.app.evaluate(({ app }) => app.getName())).toBe('WikiStow Beta');
    const opened = await catchBrowser(desktop);
    await desktop.window.getByLabel('Server').fill(baseURL ?? '');
    await desktop.window.getByRole('button', { name: 'Sign in with your browser' }).click();
    const url = await opened();
    expect(url).toContain('&app=beta');
    await page.goto(url);
    await page.getByRole('button', { name: 'Sign in to the desktop app' }).click();
    const link = (await page.getByTestId('desktop-link').getAttribute('href')) ?? '';
    expect(link.startsWith('wikistow-beta://signed-in?code=')).toBe(true);
    await expect(page.getByTestId('desktop-link')).toHaveText('Open WikiStow Beta');
    // As the desktop hands it over: a second launch of the beta with the link.
    const second = spawn(
      desktop.app.process().spawnfile,
      [BETA, `--user-data-dir=${profile}`, '--no-sandbox', '--disable-dev-shm-usage', link],
      { stdio: 'ignore' },
    );
    await new Promise((resolve) => second.once('exit', resolve));
    await expect(desktop.window.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  } finally {
    await desktop.app.close();
    await rm(FOLDER, { recursive: true, force: true });
  }
});
