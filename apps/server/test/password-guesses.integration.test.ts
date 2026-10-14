import { schema } from '@wikistow/server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vite-plus/test';
import { GUESSES_REFUSED_MESSAGE } from '../src/auth/password-guesses.ts';
import { PASSWORD, signedInPerson } from './support/accounts.ts';
import { Browser, createTestApp, type TestApp } from './support/harness.ts';

const ALLOWANCE = 3;
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ rateLimit: true, trustProxy: true, passwordGuessesPerHour: ALLOWANCE });
});
afterAll(() => t.drop());
beforeEach(async () => {
  // signedInPerson always signs in from the same client address.
  await t.db.delete(schema.rateLimits);
});

// Every attempt comes from its own client address, as from a botnet.
let address = 0;
const attempt = (browser: Browser, path: string, json: unknown) =>
  browser.request(path, {
    method: 'POST',
    json,
    headers: { 'x-real-ip': `203.0.${Math.floor(++address / 250)}.${address % 250}` },
  });
const signIn = (browser: Browser, email: string, password: string) =>
  attempt(browser, '/api/auth/sign-in/email', { email, password });
const refused = async (res: Response) => [res.status, await res.json()];
const REFUSED = [429, { code: 'account-rate-limited', message: GUESSES_REFUSED_MESSAGE }];
/** The owner's signed-in browser, minus the device cookie its sign-in earned. */
const sessionOnly = (browser: Browser) => {
  const copy = browser.clone();
  copy.forget('wikistow-device-');
  return copy;
};

it('shares one allowance per address across routes and client addresses, and keeps the owner’s device in', async () => {
  const owner = await signedInPerson(t);
  const session = sessionOnly(owner.browser);
  const outsider = new Browser(t.app);
  expect((await signIn(outsider, owner.email, 'wrong password one')).status).toBe(401);
  expect(
    (await attempt(session, '/api/auth/verify-password', { password: 'wrong password two' }))
      .status,
  ).toBe(400);
  expect(
    (
      await attempt(session, '/api/auth/change-password', {
        currentPassword: 'wrong password three',
        newPassword: 'a new password long enough',
      })
    ).status,
  ).toBe(400);

  // Spent: even the right password is refused without its device cookie.
  const reauth = await attempt(session, '/api/me/reauth', { password: PASSWORD });
  expect([reauth.status, ((await reauth.json()) as { error: unknown }).error]).toEqual([
    429,
    { code: 'account-rate-limited', message: GUESSES_REFUSED_MESSAGE },
  ]);
  expect(await refused(await signIn(new Browser(t.app), owner.email, PASSWORD))).toEqual(REFUSED);
  const other = await signedInPerson(t);

  // The device the owner signed in on keeps its own allowance, on every route.
  expect((await signIn(owner.browser, owner.email, PASSWORD)).status).toBe(200);
  expect((await attempt(owner.browser, '/api/me/reauth', { password: PASSWORD })).status).toBe(200);
  // Other accounts never shared this allowance.
  expect((await signIn(new Browser(t.app), other.email, PASSWORD)).status).toBe(200);

  // The allowance refills over the hour.
  await t.db
    .update(schema.passwordBudgets)
    .set({
      refilledAt: sql`${schema.passwordBudgets.refilledAt} - ${(60 * 60 * 1000) / ALLOWANCE}`,
    })
    .where(eq(schema.passwordBudgets.key, `address:${owner.email}`));
  expect((await signIn(new Browser(t.app), owner.email, PASSWORD)).status).toBe(200);
});
