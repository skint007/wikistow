import { schema } from '@wikistow/server';
import { count } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { DISABLED_AUTH_PATHS } from '../src/auth/auth.ts';
import { Browser, createTestApp, scratchApps, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

const users = async () => (await t.db.select({ n: count() }).from(schema.users))[0]?.n ?? 0;

/**
 * Every Better Auth route left enabled. A Better Auth upgrade or a new plugin
 * that adds a route fails here until someone checks it can't create accounts
 * or change protected fields, then adds it to this list or to DISABLED_AUTH_PATHS.
 */
const ENABLED_AUTH_PATHS = [
  '/change-password',
  '/error',
  '/get-session',
  '/list-accounts',
  '/list-sessions',
  '/ok',
  '/request-password-reset',
  '/reset-password',
  '/reset-password/:token',
  '/revoke-session',
  '/revoke-sessions',
  '/send-verification-email',
  '/sign-in/email',
  '/sign-out',
  // TOTP: each needs a session or the pending two-factor cookie; the four
  // that change settings also need the password.
  '/two-factor/disable',
  '/two-factor/enable',
  '/two-factor/generate-backup-codes',
  '/two-factor/get-totp-uri',
  '/two-factor/verify-backup-code',
  '/two-factor/verify-totp',
  '/verify-email',
  '/verify-password',
];

/** Neither GET nor POST to `path` gets past a 404, and no account appears. */
async function expectUnreachable(path: string) {
  const url = `/api/auth${path.replace(':id', 'credential')}`;
  for (const method of ['GET', 'POST']) {
    const res = await new Browser(t.app).request(url, {
      method,
      ...(method === 'POST'
        ? { json: { email: 'x@example.test', password: 'long enough password', name: 'X' } }
        : {}),
    });
    expect(res.status, `${method} ${url}`).toBe(404);
  }
  expect(await users()).toBe(0);
}

describe('closed sign-up', () => {
  it('matches the reviewed inventory of Better Auth routes', () => {
    const paths = Object.values(t.auth.api)
      .map((endpoint) => ('path' in endpoint ? endpoint.path : undefined))
      .filter((path): path is string => typeof path === 'string');
    const disabled: readonly string[] = DISABLED_AUTH_PATHS;
    expect(paths.filter((path) => !disabled.includes(path)).sort()).toEqual(ENABLED_AUTH_PATHS);
  });

  it.each(DISABLED_AUTH_PATHS.map((path) => [path]))(
    '%s is not reachable over HTTP',
    expectUnreachable,
  );

  it('refuses account creation without an invitation', async () => {
    const res = await new Browser(t.app).request('/api/accounts', {
      method: 'POST',
      json: { email: 'walk-in@example.test', name: 'X', password: 'long enough password' },
    });
    expect(res.status).toBe(403);
    expect(await users()).toBe(0);
  });
});

describe('setting up the first administrator', () => {
  const scratchApp = scratchApps();
  const PASSWORD = 'a long admin passphrase';

  it('makes exactly one administrator, who signs in without mail, then closes', async () => {
    const app = await scratchApp();
    const installation = async () =>
      (await (await new Browser(app.app).request('/api/installation')).json()) as {
        setup: boolean;
      };
    const setUp = (email: string) =>
      new Browser(app.app).request('/api/setup', {
        method: 'POST',
        json: { name: 'Owner', email, password: PASSWORD },
      });
    expect((await installation()).setup).toBe(true);

    // Two people racing for a fresh server: one wins, the other is refused.
    const answers = await Promise.all([setUp('Owner@Example.test'), setUp('other@example.test')]);
    expect(answers.map((res) => res.status).toSorted((a, b) => a - b)).toEqual([201, 409]);
    const accounts = await app.db.select().from(schema.users);
    expect(accounts).toEqual([expect.objectContaining({ role: 'admin', emailVerified: true })]);
    const [owner] = accounts;
    if (!owner) throw new Error('no first account');
    const [event] = await app.db.select().from(schema.auditEvents);
    expect(event).toMatchObject({
      actorKind: 'operator',
      action: 'account.first-admin',
      targetId: owner.id,
    });

    const signIn = await new Browser(app.app).request('/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: owner.email, password: PASSWORD },
    });
    expect(signIn.status).toBe(200);
    expect(app.mails).toEqual([]);

    expect((await installation()).setup).toBe(false);
    const late = await setUp('late@example.test');
    expect((await late.json()).error.code).toBe('admin-exists');
    expect(await app.db.select().from(schema.users)).toHaveLength(1);
  });
});
