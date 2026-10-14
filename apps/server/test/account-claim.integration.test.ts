import { createInvitation, hashInvitationToken, inspectInvitation, schema } from '@wikistow/server';
import { createEmailVerificationToken } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { PASSWORD, signedInPerson, testIssuer } from './support/accounts.ts';
import { Browser, createTestApp, lastMailTo, linkIn, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
  await t.db.update(schema.settings).set({ publicRegistration: true });
});
afterAll(() => t.drop());

const SETUP_SUBJECT = 'Finish setting up your WikiStow account';
const genericLink = async () =>
  (await createInvitation(t.db, { email: null, role: 'user', createdBy: await testIssuer(t) }))
    .token;

/** Submit a registration, as somebody who may not own the address. */
const register = (email: string, token?: string, extra: Record<string, unknown> = {}) =>
  new Browser(t.app).request('/api/accounts', {
    method: 'POST',
    json: { email, token, ...extra },
  });

const signIn = (email: string, password: string) =>
  new Browser(t.app).request('/api/auth/sign-in/email', {
    method: 'POST',
    json: { email, password },
  });

const post = (path: string, json: unknown) =>
  new Browser(t.app).request(path, { method: 'POST', json });

/** The setup link mailed to `email`, which must be the newest mail there. */
function setupToken(email: string): string {
  const mail = lastMailTo(t.mails, email);
  expect(mail?.subject).toBe(SETUP_SUBJECT);
  const url = new URL(linkIn(mail), t.config.publicOrigin);
  expect([url.pathname, url.searchParams.get('setup')]).toEqual(['/reset-password', '1']);
  return url.searchParams.get('token') ?? '';
}

const finish = (token: string, name: string, password: string) =>
  post('/api/accounts/setup', { token, name, password });

const userAt = async (email: string) =>
  (await t.db.select().from(schema.users).where(eq(schema.users.email, email)))[0];

it.each(['open', 'generic'] as const)(
  'takes only the address at %s registration, and the mailbox owner finishes the account',
  async (kind) => {
    const email = `${kind}@example.test`;
    const token = kind === 'generic' ? await genericLink() : undefined;
    // A name and password from whoever filled in the form are never kept.
    const created = await register(email, token, { name: 'Stranger', password: PASSWORD });
    expect([created.status, await created.json()]).toEqual([201, {}]);
    expect(await userAt(email)).toMatchObject({ name: '', emailVerified: false });
    const link = setupToken(email);

    // An old-style confirmation link verifies the address but turns nothing on.
    const verificationToken = await createEmailVerificationToken(t.config.authSecret, email);
    await new Browser(t.app).request(`/api/auth/verify-email?token=${verificationToken}`);
    expect((await signIn(email, PASSWORD)).status).toBe(401);

    const ownerPassword = 'a password only the owner chose';
    expect((await finish(link, '  Owner Name ', ownerPassword)).status).toBe(200);
    expect(await userAt(email)).toMatchObject({ name: 'Owner Name', emailVerified: true });
    expect((await signIn(email, PASSWORD)).status).toBe(401);
    expect((await signIn(email, ownerPassword)).status).toBe(200);
    // The link works once.
    const again = await finish(link, 'Someone', 'another password entirely');
    expect([
      again.status,
      ((await again.json()) as { error: { code: string } }).error.code,
    ]).toEqual([410, 'setup-link-invalid']);
  },
);

it('mails the setup link wherever an unfinished account would get a confirmation or reset', async () => {
  const email = 'unfinished@example.test';
  await register(email);
  const sent = () => t.mails.filter((m) => m.to === email).length;

  const before = sent();
  const resend = await post('/api/auth/send-verification-email', { email });
  expect([resend.status, await resend.json()]).toEqual([200, { status: true }]);
  expect(sent()).toBe(before + 1);
  setupToken(email);

  await post('/api/auth/request-password-reset', { email, redirectTo: '/reset-password' });
  expect(sent()).toBe(before + 2);
  setupToken(email);

  const admin = await signedInPerson(t, 'admin');
  const id = (await userAt(email))?.id;
  const adminResend = await admin.browser.request(`/api/admin/accounts/${id}/resend-verification`, {
    method: 'POST',
  });
  expect(adminResend.status).toBe(200);
  expect(sent()).toBe(before + 3);
  // Every one of the links works until one of them is used.
  expect((await finish(setupToken(email), 'Finally', 'the password I picked')).status).toBe(200);
  expect((await signIn(email, 'the password I picked')).status).toBe(200);
});

it('lets an email-bound invitation take over an account verified without a password', async () => {
  const email = 'claimed@example.test';
  await register(email, await genericLink());
  await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, email));
  const { token } = await createInvitation(t.db, {
    email,
    role: 'admin',
    createdBy: await testIssuer(t),
  });
  const ownerPassword = 'the actual owners chosen password';
  const accepted = await post('/api/accounts', {
    token,
    email,
    name: 'Owner',
    password: ownerPassword,
  });
  expect(accepted.status).toBe(201);
  // Confirmed again from the invitation's own mail before anyone signs in.
  expect(await userAt(email)).toMatchObject({ name: 'Owner', role: 'admin', emailVerified: false });
  expect((await signIn(email, ownerPassword)).status).toBe(403);
  await new Browser(t.app).request(linkIn(lastMailTo(t.mails, email)));
  expect((await signIn(email, ownerPassword)).status).toBe(200);
});

it('refuses an email-bound invitation for an account that has a password', async () => {
  const { email } = await signedInPerson(t);
  const { token } = await createInvitation(t.db, {
    email,
    role: 'user',
    createdBy: await testIssuer(t),
  });
  const res = await post('/api/accounts', { token, email, name: 'Other', password: PASSWORD });
  expect(res.status).toBe(409);
});

it('uses up a generic link whether or not the address is taken, and only tells the owner', async () => {
  const { email: taken } = await signedInPerson(t);
  const before = await userAt(taken);
  const token = await genericLink();
  const repeat = await register(taken.toUpperCase(), token);
  expect([repeat.status, await repeat.json()]).toEqual([201, {}]);
  expect(lastMailTo(t.mails, taken)?.subject).toBe('Your WikiStow account');
  expect(await userAt(taken)).toEqual(before);
  const [link] = await t.db
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.tokenHash, hashInvitationToken(token)));
  expect(link).toMatchObject({ acceptedAt: expect.any(Date), acceptedUserId: null });
  expect(await inspectInvitation(t.db, token)).toEqual({ status: 'used' });
  const fresh = await register('fresh@example.test', token);
  expect((await fresh.json()) as unknown).toMatchObject({ error: { code: 'invitation-used' } });
});
