import { createInvitation, schema } from '@wikistow/server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  Browser,
  createTestApp,
  lastMailTo,
  linkIn,
  scratchApps,
  type TestApp,
} from './support/harness.ts';
import { testIssuer } from './support/accounts.ts';

let t: TestApp;
const scratchApp = scratchApps();
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const PASSWORD = 'correct horse battery staple';
let counter = 0;
const uniqueEmail = () => `person${++counter}@example.test`;

const invite = async (email: string | null, role: 'user' | 'admin' = 'user') =>
  (await createInvitation(t.db, { email, role, createdBy: await testIssuer(t) })).token;

const createAccount = (body: Record<string, unknown>, browser = new Browser(t.app)) =>
  browser.request('/api/accounts', {
    method: 'POST',
    json: { name: 'Jo', password: PASSWORD, ...body },
  });

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;
/** Better Auth's own routes answer `{ code, message }`. */
const authErrorCode = async (res: Response) => ((await res.json()) as { code: string }).code;

const signIn = (browser: Browser, email: string, password = PASSWORD) =>
  browser.request('/api/auth/sign-in/email', { method: 'POST', json: { email, password } });

/** Follow the newest verification link sent to `email`. */
async function verify(email: string) {
  const res = await new Browser(t.app).request(linkIn(lastMailTo(t.mails, email)));
  expect(res.status).toBe(302);
}

/** An invited, verified, signed-in account. */
async function signedInAccount(role: 'user' | 'admin' = 'user') {
  const email = uniqueEmail();
  const browser = new Browser(t.app);
  expect((await createAccount({ token: await invite(email, role), email }, browser)).status).toBe(
    201,
  );
  await verify(email);
  expect((await signIn(browser, email)).status).toBe(200);
  return { browser, email };
}

describe('accepting an invitation', () => {
  it('creates an account that must verify its email before signing in', async () => {
    const email = uniqueEmail();
    const browser = new Browser(t.app);
    const res = await createAccount(
      { token: await invite(email), email: email.toUpperCase() },
      browser,
    );
    expect(res.status).toBe(201);
    // Invitation holders already know the address is theirs, so they get the ID.
    expect(await res.json()).toMatchObject({ accountId: expect.any(String) });

    const unverified = await signIn(browser, email);
    expect(unverified.status).toBe(403);
    expect(await authErrorCode(unverified)).toBe('EMAIL_NOT_VERIFIED');
    await verify(email);
    expect((await signIn(browser, email)).status).toBe(200);

    const me = await (await browser.request('/api/me')).json();
    expect(me.account).toMatchObject({ email, role: 'user', theme: 'system' });
  });

  it.each([
    ['expired', { expiresAt: sql`now() - interval '1 second'` }, 'invitation-expired'],
    ['revoked', { revokedAt: sql`now()` }, 'invitation-revoked'],
  ] as const)('refuses an %s invitation', async (_name, change, code) => {
    const email = uniqueEmail();
    const token = await invite(email);
    await t.db.update(schema.invitations).set(change).where(eq(schema.invitations.email, email));
    expect(await errorCode(await createAccount({ token, email }))).toBe(code);
  });

  it('refuses a used or misaddressed invitation', async () => {
    const email = uniqueEmail();
    const token = await invite(email);
    expect(await errorCode(await createAccount({ token, email: uniqueEmail() }))).toBe(
      'invitation-email-mismatch',
    );
    expect((await createAccount({ token, email })).status).toBe(201);
    expect(await errorCode(await createAccount({ token, email }))).toBe('invitation-used');
  });
});

describe('password reset', () => {
  it('signs out every existing session and leaves the old password useless', async () => {
    const { browser, email } = await signedInAccount();
    const stolen = browser.clone();
    expect((await stolen.request('/api/me')).status).toBe(200);

    const anon = new Browser(t.app);
    await anon.request('/api/auth/request-password-reset', {
      method: 'POST',
      json: { email, redirectTo: '/reset-password' },
    });
    const callback = await anon.request(linkIn(lastMailTo(t.mails, email)));
    expect(callback.status).toBe(302);
    const token = new URL(callback.headers.get('location') ?? '', 'http://x').searchParams.get(
      'token',
    );
    const reset = await anon.request('/api/auth/reset-password', {
      method: 'POST',
      json: { token, newPassword: 'a different long passphrase' },
    });
    expect(reset.status).toBe(200);

    expect((await stolen.request('/api/me')).status).toBe(401);
    expect((await signIn(new Browser(t.app), email)).status).toBe(401);
    expect((await signIn(new Browser(t.app), email, 'a different long passphrase')).status).toBe(
      200,
    );
  });
});

describe('a suspended account', () => {
  it('is refused on its next request and cannot sign in again', async () => {
    const { browser, email } = await signedInAccount();
    // Set directly, without deleting sessions, to prove every request re-checks.
    await t.db
      .update(schema.users)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.users.email, email));
    const res = await browser.request('/api/me');
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('account-suspended');
    const again = await signIn(new Browser(t.app), email);
    expect(again.status).toBe(403);
    expect(await authErrorCode(again)).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('session renewal', () => {
  it('sends the renewed cookie, so active people stay signed in', async () => {
    const { browser, email } = await signedInAccount();
    const [user] = await t.db.select().from(schema.users).where(eq(schema.users.email, email));
    // Two days into a seven-day session: due for renewal.
    await t.db
      .update(schema.sessions)
      .set({ expiresAt: sql`now() + interval '5 days'` })
      .where(eq(schema.sessions.userId, user?.id ?? ''));
    const viaApp = await browser.request('/api/me');
    expect(viaApp.headers.getSetCookie().join()).toMatch(/session_token=/);
  });
});

describe('sign-in rate limiting', () => {
  // What @hono/node-server hands the app for a real connection.
  const fromSocket = (address: string) => ({
    incoming: { socket: { remoteAddress: address, remotePort: 5555, remoteFamily: 'IPv4' } },
  });

  it('keys on the socket address, which spoofed headers cannot change', async () => {
    const limited = await scratchApp({ rateLimit: true, trustProxy: false });
    const attempt = (socket: string, spoof: string) =>
      limited.app.request(
        '/api/auth/sign-in/email',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: limited.config.publicOrigin,
            'x-real-ip': spoof,
            'x-forwarded-for': spoof,
            'x-wikistow-client-address': spoof,
          },
          body: JSON.stringify({
            email: 'target@example.test',
            password: 'wrong password guess',
          }),
        },
        fromSocket(socket),
      );
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await attempt('198.51.100.1', `203.0.113.${i}`)).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    // A different client has its own allowance; nobody shares one bucket.
    expect((await attempt('198.51.100.2', '203.0.113.99')).status).toBe(401);
  });

  it('slows password guessing per client address', async () => {
    const limited = await scratchApp({ rateLimit: true, trustProxy: true });
    const attempt = (ip: string) =>
      new Browser(limited.app).request('/api/auth/sign-in/email', {
        method: 'POST',
        json: { email: 'target@example.test', password: 'wrong password guess' },
        headers: { 'x-real-ip': ip },
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt('203.0.113.7')).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    // Another client is unaffected.
    expect((await attempt('203.0.113.8')).status).toBe(401);
  });
});
