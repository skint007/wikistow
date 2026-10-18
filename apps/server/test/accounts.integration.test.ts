import { createInvitation, schema } from '@wikistow/server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  Browser,
  ORIGIN,
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

// Names are unique on a server, so each account gets its own unless the test names it.
let named = 0;
const createAccount = (body: Record<string, unknown>, browser = new Browser(t.app)) =>
  browser.request('/api/accounts', {
    method: 'POST',
    json: { name: `Jo ${++named}`, password: PASSWORD, ...body },
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

describe('changing the email address', () => {
  it('needs a recent sign-in, and changes nothing until the new address opens its link', async () => {
    const { browser, email } = await signedInAccount();
    await t.db
      .update(schema.sessions)
      .set({ authenticatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(schema.sessions.userId, sql`(select id from users where email = ${email})`));
    const next = uniqueEmail();
    const ask = () => browser.request('/api/me/email', { method: 'POST', json: { email: next } });
    expect(await errorCode(await ask())).toBe('reauth-required');
    const reauth = { method: 'POST', json: { password: PASSWORD } };
    expect((await browser.request('/api/me/reauth', reauth)).status).toBe(200);
    expect((await ask()).status).toBe(200);

    expect((await signIn(new Browser(t.app), next)).status).toBe(401);
    expect((await signIn(new Browser(t.app), email)).status).toBe(200);

    const token = new URL(linkIn(lastMailTo(t.mails, next)), ORIGIN).searchParams.get('token');
    const confirm = () =>
      new Browser(t.app).request('/api/accounts/email/confirm', {
        method: 'POST',
        json: { token },
      });
    expect(await (await confirm()).json()).toEqual({ email: next });
    expect((await signIn(new Browser(t.app), next)).status).toBe(200);
    expect((await signIn(new Browser(t.app), email)).status).toBe(401);
    expect(lastMailTo(t.mails, email)?.text).toContain(next);
    expect(await errorCode(await confirm())).toBe('email-link-invalid');
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

describe('avatars', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const svg = (body: string) =>
    new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${body}</svg>`,
    );
  // Node needs `duplex` to send a streamed body; the DOM's types don't list it.
  const streams = { duplex: 'half' };
  const upload = (browser: Browser, body: BodyInit, headers: Record<string, string> = {}) =>
    browser.fetch('/api/me/avatar', { method: 'PUT', body, headers, ...streams });
  const avatarOf = async (browser: Browser) =>
    ((await (await browser.request('/api/me')).json()) as { account: { avatar: string | null } })
      .account.avatar;
  const fetchAvatar = (id: string | null) => new Browser(t.app).request(`/api/avatars/${id}`);

  it('changes only the signed-in account’s own avatar, and drops the old image', async () => {
    const alice = (await signedInAccount()).browser;
    const bob = (await signedInAccount()).browser;
    expect((await upload(alice, PNG)).status).toBe(200);
    const before = await avatarOf(alice);
    // Nobody signed out, and no other site, can set or remove one.
    expect((await upload(new Browser(t.app), PNG)).status).toBe(401);
    for (const method of ['PUT', 'DELETE'] as const) {
      const crossSite = await alice.request('/api/me/avatar', {
        method,
        headers: { origin: 'https://evil.example' },
      });
      expect(crossSite.status).toBe(403);
    }

    // Bob's changes reach only Bob's avatar, which anyone may fetch.
    expect((await upload(bob, svg(''))).status).toBe(200);
    expect((await bob.request('/api/me/avatar', { method: 'DELETE' })).status).toBe(200);
    expect(await avatarOf(alice)).toBe(before);
    const served = await fetchAvatar(before);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    // Replacing gives a new address, and the old one stops working.
    expect((await upload(alice, svg(''))).status).toBe(200);
    const after = await avatarOf(alice);
    expect(after).not.toBe(before);
    expect((await fetchAvatar(before)).status).toBe(404);
    expect((await alice.request('/api/me/avatar', { method: 'DELETE' })).status).toBe(200);
    expect(await avatarOf(alice)).toBeNull();
    expect((await fetchAvatar(after)).status).toBe(404);
  });

  it('takes images by their bytes, serves SVG sandboxed, and refuses big ones', async () => {
    const { browser } = await signedInAccount();
    // A page claiming to be an image, and SVGs that would run or fetch something.
    for (const body of [
      new TextEncoder().encode('<html><script>alert(1)</script></html>'),
      svg('<script>alert(1)</script>'),
      svg('<rect onload="alert(1)"/>'),
      svg('<image href="https://evil.example/x.png"/>'),
      svg('<style>rect { fill: url(https://evil.example/f) }</style>'),
    ]) {
      expect((await upload(browser, body, { 'content-type': 'image/png' })).status).toBe(415);
    }

    expect((await upload(browser, svg('<rect width="1" height="1"/>'))).status).toBe(200);
    const res = await fetchAvatar(await avatarOf(browser));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    expect(res.headers.get('content-disposition')).toBe('inline; filename="avatar.svg"');

    // Too big whether the length is stated or only found while streaming.
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    expect((await upload(browser, big)).status).toBe(413);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.close();
      },
    });
    expect((await upload(browser, streamed)).status).toBe(413);
  });
});
