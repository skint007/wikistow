// Enrolling the real CLI from a person's browser, for the agent tests.
import type { Locator, Page } from '@playwright/test';
import type { cliInstall } from './cli';
import { expect } from './fixtures';

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

/** Open the Agents page from the rail. */
export async function agentsPage(page: Page) {
  await page.getByRole('link', { name: 'Agents', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
}

/**
 * Enroll a CLI from the browser, as its person would: the code the CLI
 * shows, the same fingerprint on both sides, a name, and picks. `pick`
 * fills in the picks before approving.
 */
export async function addAgent(
  page: Page,
  cli: Awaited<ReturnType<typeof cliInstall>>,
  name: string,
  pick: (dialog: Locator) => Promise<void> = async () => {},
) {
  const enrolling = await cli.enroll();
  await agentsPage(page);
  await page.getByRole('button', { name: 'Add an agent' }).click();
  const dialog = page.getByRole('dialog');
  // The command the CLI needs, with this server's address, ready to copy.
  await expect(dialog.getByTestId('enroll-command')).toHaveText(
    `wikistow agent enroll --server ${new URL(page.url()).origin}`,
  );
  await expect(dialog).toContainText('In a terminal on the computer the agent runs on');
  await dialog.getByLabel('Lookup code').fill(enrolling.code.toLowerCase().replace('-', ' '));
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('heading', { name: 'Compare the fingerprints' })).toBeVisible();

  // Both sides show the same fingerprint, each worked out on its own.
  const shown = await dialog.getByTestId('enrollment-fingerprint').getAttribute('aria-label');
  const printed = await enrolling.fingerprint();
  expect(shown).toBe(`Enrollment fingerprint: ${printed}`);
  for (const group of printed.split(' ')) {
    await expect(dialog.getByTestId('enrollment-fingerprint')).toContainText(group);
  }
  // The code the person typed shows beside it, as the CLI shows it.
  await expect(dialog.getByTestId('claimed-code')).toHaveText(enrolling.code);
  const approve = dialog.getByRole('button', { name: 'Fingerprints match, approve' });
  await expect(approve).toBeDisabled();
  await enrolling.confirm();
  // The CLI's yes is only reported; the comparison stays the person's.
  await expect(
    dialog.getByText(
      'Yes was typed in the CLI. Still check every group above against the CLI before you approve.',
    ),
  ).toBeVisible();
  // Named, the agent still waits for the comparison.
  await dialog.getByLabel('Name the agent').fill(name);
  await expect(approve).toBeDisabled();

  // Approving takes one group, read off the CLI's own output.
  const asking = dialog.getByLabel(/group of the fingerprint your CLI shows/);
  const question = await dialog.locator('label[for="fingerprint-group"]').textContent();
  const ordinal = /Type the (\w+) group/.exec(question ?? '')?.[1] ?? '';
  const index = ORDINALS.indexOf(ordinal);
  expect(index, question ?? '').toBeGreaterThanOrEqual(0);
  const groups = printed.split(' ');
  const asked = groups[index] ?? '';
  // Another group is refused, and Approve stays off.
  const other = groups.find((g) => g !== asked) ?? 'zzzz';
  await asking.fill(other);
  await expect(dialog).toContainText(`That isn’t the ${ordinal} group here.`);
  await expect(approve).toBeDisabled();
  await asking.fill(asked.toUpperCase());
  await expect(dialog).not.toContainText('That isn’t');
  await expect(approve).toBeEnabled();

  await pick(dialog);
  // The fingerprint and Approve fit on screen together, at the desktop
  // window's size (1280×720) and at a phone's.
  // A desktop app's window has no emulated viewport: only its own size is checked.
  const size = page.viewportSize();
  for (const viewport of size ? [size, { width: 390, height: 844 }] : [null]) {
    if (viewport) await page.setViewportSize(viewport);
    await expect(dialog.getByTestId('enrollment-fingerprint')).toBeInViewport({ ratio: 1 });
    await expect(approve).toBeInViewport({ ratio: 1 });
  }
  if (size) await page.setViewportSize(size);
  await dialog.getByRole('button', { name: 'Fingerprints match, approve' }).click();
  await expect(dialog.getByRole('heading', { name: `${name} is approved` })).toBeVisible({
    timeout: 30_000,
  });
  const done = await enrolling.done;
  expect(done.code, done.stderr).toBe(0);
  await dialog.getByRole('button', { name: 'Done' }).click();
  return { code: enrolling.code, fingerprint: printed };
}
