// Exports the web app downloads, unzipped for the tests to read.
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { expect } from './fixtures';

/** Press Export in the open Export dialog; the zip it downloads, unzipped. */
export async function download(page: Page) {
  const dialog = page.getByRole('dialog', { name: /^Export “/ });
  const [saved] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Export', exact: true }).click(),
  ]);
  await expect(dialog).toBeHidden();
  const zip = unzipSync(new Uint8Array(await readFile(await saved.path())));
  return { name: saved.suggestedFilename(), zip };
}

export const text = (zip: Record<string, Uint8Array>, path: string) => {
  const bytes = zip[path];
  if (!bytes) throw new Error(`No ${path} in ${Object.keys(zip).join(', ')}`);
  return strFromU8(bytes);
};
