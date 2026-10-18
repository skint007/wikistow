import type { Page } from '@playwright/test';
import { expect, joinWith, linkFor, PASSWORD, signIn, uniqueEmail } from './fixtures';

export const PASSPHRASE = 'a separate vault passphrase for tests';

/** Strings that must never reach the server in readable form. */
export const MARKERS = {
  title: 'Network notes PLAINTEXT-TITLE-e2e1',
  published: 'Router admin is on vlan 20. PLAINTEXT-PUBLISHED-e2e2',
  private: 'The wifi password is hunter2. PLAINTEXT-PRIVATE-e2e3',
  folder: 'Household PLAINTEXT-FOLDER-e2e4',
  attachment: 'router PLAINTEXT-FILENAME-e2e5.png',
} as const;

/** A 1×1 PNG, so attachments render as images. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Fill in a new passphrase, with the account password it's compared to. */
export async function choosePassphrase(page: Page, passphrase: string) {
  await page.getByLabel('Vault passphrase').fill(passphrase);
  await page.getByLabel('Repeat passphrase').fill(passphrase);
  await page.getByLabel('Account password').fill(PASSWORD);
}

/** Set up the vault from the setup page, confirming the recovery key; returns the key. */
export async function setUpVault(page: Page, passphrase = PASSPHRASE): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Set up your vault' })).toBeVisible();
  await choosePassphrase(page, passphrase);
  await page.getByRole('button', { name: 'Create vault' }).click();
  return confirmRecoveryKey(page);
}

/** Once the vault is made, type back the groups of the recovery key it asks for; returns the key. */
export async function confirmRecoveryKey(page: Page): Promise<string> {
  const shown = page.getByTestId('recovery-key');
  await expect(shown).toBeVisible({ timeout: 30_000 });
  const groups = (await shown.textContent())?.trim().split(/\s+/) ?? [];
  for (const field of await page.getByLabel(/^Group \d+$/).all()) {
    const label = await field.getAttribute('id');
    const index = Number(label?.replace('group-', ''));
    await field.fill(groups[index] ?? '');
  }
  await page.getByRole('button', { name: 'I saved it' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  return groups.join('-');
}

/** The administrator, signed in in a browser of their own. */
export async function adminTab(freshPage: () => Promise<Page>, email: string) {
  const page = await freshPage();
  await signIn(page, email);
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
  return page;
}

/** An invited member, signed in and on the vault setup page. */
export async function invitedMember(page: Page, adminPage: Page, name?: string) {
  const email = uniqueEmail('writer');
  await adminPage.goto('/admin/invitations');
  await adminPage.getByLabel('Email (optional)').fill(email);
  await adminPage.getByRole('button', { name: 'Create invitation' }).click();
  await expect(adminPage.getByText(`Invitation sent to ${email}.`)).toBeVisible();
  await joinWith(page, await linkFor(email, /invited you/), email, name);
  return email;
}

/** An invited member with a vault, on their first space. */
export async function memberWithVault(page: Page, adminPage: Page, name?: string) {
  const email = await invitedMember(page, adminPage, name);
  const recoveryKey = await setUpVault(page);
  return { email, recoveryKey };
}

/** Make a page from the sidebar; ends on its draft view. */
export async function newPage(page: Page, title: string) {
  await page.getByRole('button', { name: 'New page' }).first().click();
  await page.getByRole('dialog').getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Create page' }).click();
  // The title, not just an editor: the page open before may still be showing.
  await expect(page.locator('#page-title')).toHaveValue(title);
  await expect(page.locator('#page-source')).toBeVisible();
}

/**
 * The text in the page's source editor, exactly, each line break as the
 * page writes it. The lines on screen don't show which break ends each, so
 * this asks CodeMirror's view for the text, through the content element as
 * `EditorView.findFromDOM` does.
 */
export const sourceOf = (page: Page) =>
  page.locator('#page-source').evaluate((editor) => {
    type Found = { cmTile?: { root?: { view?: { state: { sliceDoc(): string } } } } };
    const view = (editor as Found).cmTile?.root?.view;
    if (!view) throw new Error('No CodeMirror view found from #page-source');
    return view.state.sliceDoc();
  });

/**
 * Type `text` over everything in the page's source editor. `fill` selects
 * the text in the DOM, then types; but CodeMirror redraws its own selection
 * a moment after it gains focus, which can collapse that selection first
 * and leave the old text after the new. Selecting through the editor
 * doesn't race it.
 */
export async function fillSource(page: Page, text: string) {
  const source = page.locator('#page-source');
  await source.focus();
  await source.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

/** Wait for the source editor to hold `expected`, as `toHaveValue` waits for a field. */
export async function expectSource(page: Page, expected: string | RegExp) {
  const poll = expect.poll(() => sourceOf(page), { timeout: 15_000 });
  await (typeof expected === 'string' ? poll.toBe(expected) : poll.toMatch(expected));
}

/** The draft's save status, apart from the editor's own (why a page stays in source mode). */
export const saveStatus = (page: Page) =>
  page.getByRole('status').filter({ hasText: /saved|Saving/ });

export async function waitForSave(page: Page) {
  await expect(saveStatus(page)).toHaveText('All changes saved', { timeout: 15_000 });
}
