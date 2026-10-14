import { createInvitation, schema } from '@wikistow/server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { Browser, createTestApp, lastMailTo, linkIn, type TestApp } from './support/harness.ts';
import { signedInPerson, testIssuer } from './support/accounts.ts';
import { secretFromUri, totp } from './support/totp.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const PASSWORD = 'a long enough passphrase';
let counter = 0;

const signIn = (browser: Browser, email: string) =>
  browser.request('/api/auth/sign-in/email', {
    method: 'POST',
    json: { email, password: PASSWORD },
  });

/** A verified, signed-in account with TOTP enabled. */
async function accountWithTotp() {
  const email = `totp${++counter}@example.test`;
  const { token } = await createInvitation(t.db, {
    email,
    role: 'user',
    createdBy: await testIssuer(t),
  });
  const browser = new Browser(t.app);
  await browser.request('/api/accounts', {
    method: 'POST',
    json: { token, email, name: 'T', password: PASSWORD },
  });
  await new Browser(t.app).request(linkIn(lastMailTo(t.mails, email)));
  await signIn(browser, email);

  const enabled = await browser.request('/api/auth/two-factor/enable', {
    method: 'POST',
    json: { password: PASSWORD },
  });
  const { totpURI, backupCodes } = (await enabled.json()) as {
    totpURI: string;
    backupCodes: string[];
  };
  const secret = secretFromUri(totpURI);

  // Not active until a code from the authenticator proves it was set up.
  const pending = (await (await browser.request('/api/auth/get-session')).json()) as {
    user: { twoFactorEnabled: boolean };
  };
  expect(pending.user.twoFactorEnabled).toBe(false);
  const verified = await browser.request('/api/auth/two-factor/verify-totp', {
    method: 'POST',
    json: { code: totp(secret) },
  });
  expect(verified.status).toBe(200);
  return { email, secret, backupCodes, browser };
}

/** As if the account's last full sign-in was eleven minutes ago. */
async function ageSessions(db: TestApp['db'], email: string) {
  await db
    .update(schema.sessions)
    .set({ authenticatedAt: sql`now() - interval '11 minutes'` })
    .where(
      eq(
        schema.sessions.userId,
        sql`(select ${schema.users.id} from ${schema.users} where ${schema.users.email} = ${email})`,
      ),
    );
}

async function sessionsOf(email: string) {
  return t.db
    .select({ id: schema.sessions.id, authenticatedAt: schema.sessions.authenticatedAt })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(eq(schema.users.email, email));
}

describe('two-factor sign-in', () => {
  it('withholds the session until a valid code is given', async () => {
    const { email, secret } = await accountWithTotp();
    const browser = new Browser(t.app);
    const first = await signIn(browser, email);
    expect(await first.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await browser.request('/api/me')).status).toBe(401);

    const wrong = await browser.request('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      json: { code: '000000' },
    });
    expect(wrong.status).toBe(401);
    const right = await browser.request('/api/auth/two-factor/verify-totp', {
      // The setup used this step's code; codes work once, so the next step's.
      method: 'POST',
      json: { code: totp(secret, Date.now() + 30_000) },
    });
    expect(right.status).toBe(200);
    expect((await browser.request('/api/me')).status).toBe(200);
  });

  it('counts a backup-code sign-in as recent, so a lost authenticator can be replaced', async () => {
    const { email, backupCodes } = await accountWithTotp();
    const browser = new Browser(t.app);
    await signIn(browser, email);
    await browser.request('/api/auth/two-factor/verify-backup-code', {
      method: 'POST',
      json: { code: backupCodes[1] },
    });
    const uri = await browser.request('/api/auth/two-factor/get-totp-uri', {
      method: 'POST',
      json: { password: PASSWORD },
    });
    expect(uri.status).toBe(200);
  });

  it('still lets someone sign in again from a browser holding an old session', async () => {
    const { email, secret } = await accountWithTotp();
    const browser = new Browser(t.app);
    await signIn(browser, email);
    await browser.request('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      json: { code: totp(secret) },
    });
    await t.db
      .update(schema.sessions)
      .set({ authenticatedAt: sql`now() - interval '11 minutes'` })
      .where(sql`true`);
    expect((await signIn(browser, email)).status).toBe(200);
    // A code from the next time step, since the last one was just used.
    const verified = await browser.request('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      json: { code: totp(secret, Date.now() + 30_000) },
    });
    expect(verified.status).toBe(200);
  });
});

describe('confirming it’s you again', () => {
  type Body = { password: string; code?: { kind: 'totp'; value: string | undefined } };
  const reauth = async (browser: Browser, body: Body) => {
    const res = await browser.request('/api/me/reauth', { method: 'POST', json: body });
    return { res, body: (await res.json()) as { status?: string; error?: { code: string } } };
  };
  const totpUri = (browser: Browser) =>
    browser.request('/api/auth/two-factor/get-totp-uri', {
      method: 'POST',
      json: { password: PASSWORD },
    });

  it('takes the password and then a code, keeping the same session throughout', async () => {
    const { email, secret, browser } = await accountWithTotp();
    await ageSessions(t.db, email);
    const before = await sessionsOf(email);
    expect((await totpUri(browser)).status).toBe(403);

    const first = await reauth(browser, { password: PASSWORD });
    expect(first.body).toEqual({ status: 'code-required' });
    expect((await browser.request('/api/me')).status).toBe(200);
    expect((await totpUri(browser)).status).toBe(403);

    const code = totp(secret, Date.now() + 30_000);
    const second = await reauth(browser, {
      password: PASSWORD,
      code: { kind: 'totp', value: code },
    });
    expect(second.body).toEqual({ status: 'confirmed' });
    expect((await totpUri(browser)).status).toBe(200);
    expect((await sessionsOf(email)).map((s) => s.id)).toEqual(before.map((s) => s.id));
  });

  it('needs only the password when two-factor is off', async () => {
    const { browser, email } = await signedInPerson(t);
    await ageSessions(t.db, email);
    const wrong = await reauth(browser, { password: 'not the password at all' });
    expect(wrong.body.error?.code).toBe('wrong-password');
    const [stale] = await sessionsOf(email);
    expect(Date.now() - (stale?.authenticatedAt?.getTime() ?? 0)).toBeGreaterThan(600_000);

    expect((await reauth(browser, { password: PASSWORD })).body).toEqual({ status: 'confirmed' });
    const [fresh] = await sessionsOf(email);
    expect(fresh?.id).toBe(stale?.id);
    expect(Date.now() - (fresh?.authenticatedAt?.getTime() ?? 0)).toBeLessThan(60_000);
  });
});
