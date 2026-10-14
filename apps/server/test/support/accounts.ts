// Signed-in people for tests, created the way real ones are.
import { bootstrapAdmin, createInvitation, schema } from '@wikistow/server';
import { expect } from 'vite-plus/test';
import { Browser, lastMailTo, linkIn, type TestApp } from './harness.ts';

export const PASSWORD = 'a long enough passphrase';
let counter = 0;

const issuers = new WeakMap<TestApp, Promise<string>>();
/**
 * An administrator to issue invitations, as every account invitation needs
 * one. Never verified, so it doesn't count as the installation's admin.
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

async function bootstrapLink(t: TestApp, email: string): Promise<string> {
  const result = await bootstrapAdmin(t.db, email);
  if (result.kind !== 'invited') throw new Error(`expected a bootstrap link, got ${result.kind}`);
  return result.token;
}

/** A verified, signed-in account. Administrators come from the bootstrap command, run twice. */
export async function signedInPerson(
  t: TestApp,
  role: 'user' | 'admin' = 'user',
  password = PASSWORD,
) {
  const email = `${role}${++counter}-${Date.now()}@example.test`;
  const token =
    role === 'admin'
      ? await bootstrapLink(t, email)
      : (await createInvitation(t.db, { email, role, createdBy: await testIssuer(t) })).token;
  const browser = new Browser(t.app);
  const created = await browser.request('/api/accounts', {
    method: 'POST',
    json: { token, email, name: email.split('@')[0], password },
  });
  expect(created.status).toBe(201);
  await new Browser(t.app).request(linkIn(lastMailTo(t.mails, email)));
  // Promoted before signing in: a role change ends the sessions from before it.
  if (role === 'admin')
    expect(await bootstrapAdmin(t.db, email)).toMatchObject({ kind: 'promoted' });
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
