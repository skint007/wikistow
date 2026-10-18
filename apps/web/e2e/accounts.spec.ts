import { secretFromUri, totp } from '@wikistow/server-app/testing/totp';
import type { Page } from '@playwright/test';
import {
  expectSignedIn,
  expect,
  joinWith,
  linkFor,
  PASSWORD,
  signIn,
  test,
  uniqueEmail,
} from './fixtures';

type FreshPage = () => Promise<Page>;

async function signedInAs(freshPage: FreshPage, email: string): Promise<Page> {
  const page = await freshPage();
  await signIn(page, email);
  await expectSignedIn(page);
  return page;
}

/** An administrator invites a new address as a member, and returns it. */
async function invite(freshPage: FreshPage, adminEmail: string) {
  const email = uniqueEmail('member');
  const admin = await signedInAs(freshPage, adminEmail);
  await admin.goto('/admin/invitations');
  await admin.getByLabel('Email (optional)').fill(email);
  await admin.getByLabel('Member').check();
  await admin.getByRole('button', { name: 'Create invitation' }).click();
  await expect(admin.getByText(`Invitation sent to ${email}.`)).toBeVisible();
  await admin.close();
  return email;
}

/** An administrator invites someone; the invitee joins in their own browser. */
async function invited(freshPage: FreshPage, adminEmail: string) {
  const email = await invite(freshPage, adminEmail);
  const page = await freshPage();
  await joinWith(page, await linkFor(email, /invited you/), email);
  await expectSignedIn(page);
  return { email, page };
}

test('a forgotten password is reset by email', async ({ freshPage, admin }) => {
  const { email, page } = await invited(freshPage, admin.email);
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('a reset link is on its way')).toBeVisible();

  await page.goto(await linkFor(email, /Reset/));
  await expect(page).toHaveURL(/\/reset-password\?token=/);
  const fresh = 'a brand new password for this test';
  await page.getByLabel('New password').fill(fresh);
  await page.getByLabel('Repeat password').fill(fresh);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Your password is changed.')).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await signIn(page, email, fresh);
  await expectSignedIn(page);
});

test('a sign-in with two-factor turned on asks for a code', async ({ freshPage, admin }) => {
  const { email, page } = await invited(freshPage, admin.email);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Manage two-factor sign-in' }).click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  const key = await page.locator('code').first().textContent();
  const secret = secretFromUri(`otpauth://totp/x?secret=${key ?? ''}`);
  await page.getByLabel('Code').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('list', { name: 'Backup codes' })).toBeVisible();

  const other = await freshPage();
  await other.goto('/sign-in');
  await other.getByLabel('Email').fill(email);
  await other.getByLabel('Password').fill(PASSWORD);
  await other.getByRole('button', { name: 'Sign in' }).click();
  await other.getByLabel('Code').fill(totp(secret, Date.now() + 30_000));
  await other.getByRole('button', { name: 'Verify' }).click();
  await expectSignedIn(other);
});
