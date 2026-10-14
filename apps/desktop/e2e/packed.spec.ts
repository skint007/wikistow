import { expect, test } from '@playwright/test';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launch, newProfile } from './desktop';

// The app as the Arch package installs it: the one app.asar `scripts/asar.ts`
// packs, with the pages, bundles and icon inside. CI packs it in its build
// step; locally, `node scripts/asar.ts` first.
const ASAR = fileURLToPath(new URL('../out/app.asar', import.meta.url));

test('the packed app starts on its own pages', async () => {
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
