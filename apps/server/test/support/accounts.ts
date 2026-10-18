// Signed-in people for tests, created the way real ones are.
import { createInvitation, schema } from '@wikistow/server';
import { expect } from 'vite-plus/test';
import { Browser, lastMailTo, linkIn, type TestApp } from './harness.ts';

export const PASSWORD = 'a long enough passphrase';
let counter = 0;

const issuers = new WeakMap<TestApp, Promise<string>>();
/**
 * An administrator to issue invitations, as every account invitation needs
 * one. Inserted directly, so it also ends the test app's first-run setup.
 */
export function testIssuer(t: TestApp): Promise<string> {
  let issuer = issuers.get(t);
  if (!issuer) {
    issuer = t.db
      .insert(schema.users)
      .values({ name: 'Issuer', email: 'test-issuer@example.test', role: 'admin' })
      .returning({ id: schema.users.id })
      .then(([row]) => {
        if (!row) throw new Error('issuer was not inserted');
        return row.id;
      });
    issuers.set(t, issuer);
  }
  return issuer;
}

/** A verified, signed-in account, invited by `testIssuer`. */
export async function signedInPerson(
  t: TestApp,
  role: 'user' | 'admin' = 'user',
  password = PASSWORD,
) {
  const email = `${role}${++counter}-${Date.now()}@example.test`;
  const { token } = await createInvitation(t.db, { email, role, createdBy: await testIssuer(t) });
  const browser = new Browser(t.app);
  const created = await browser.request('/api/accounts', {
    method: 'POST',
    json: { token, email, name: email.split('@')[0], password },
  });
  expect(created.status).toBe(201);
  await new Browser(t.app).request(linkIn(lastMailTo(t.mails, email)));
  const signedIn = await browser.request('/api/auth/sign-in/email', {
    method: 'POST',
    json: { email, password },
  });
  expect(signedIn.status).toBe(200);
  const { accountId } = (await created.json()) as { accountId: string };
  return { browser, email, id: accountId };
}

/** Reset a password through the emailed link, as someone who forgot it would. */
export async function resetPassword(t: TestApp, email: string, newPassword: string) {
  const anon = new Browser(t.app);
  await anon.request('/api/auth/request-password-reset', {
    method: 'POST',
    json: { email, redirectTo: '/reset-password' },
  });
  const callback = await anon.request(linkIn(lastMailTo(t.mails, email)));
  const token = new URL(callback.headers.get('location') ?? '', 'http://x').searchParams.get(
    'token',
  );
  const res = await anon.request('/api/auth/reset-password', {
    method: 'POST',
    json: { token, newPassword },
  });
  expect(res.status).toBe(200);
}
