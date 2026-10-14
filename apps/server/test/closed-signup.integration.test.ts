import { AccountError, bootstrapAdmin, schema } from '@wikistow/server';
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { DISABLED_AUTH_PATHS } from '../src/auth/auth.ts';
import {
  Browser,
  createTestApp,
  lastMailTo,
  linkIn,
  scratchApps,
  type TestApp,
} from './support/harness.ts';

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

describe('bootstrapping the first administrator', () => {
  const scratchApp = scratchApps();
  const OWNER_PASSWORD = 'a long admin passphrase';

  /** A fresh installation, so each case starts with no administrator. */
  async function fresh() {
    const app = await scratchApp();
    const accept = (token: string, email: string) =>
      new Browser(app.app).request('/api/accounts', {
        method: 'POST',
        json: { token, email, name: 'Owner', password: OWNER_PASSWORD },
      });
    const verify = (email: string) =>
      new Browser(app.app).request(linkIn(lastMailTo(app.mails, email)));
    const invited = async (email: string) => {
      const result = await bootstrapAdmin(app.db, email);
      if (result.kind !== 'invited') throw new Error(`expected a link, got ${result.kind}`);
      return result.token;
    };
    const roleOf = async (email: string) =>
      (await app.db.select().from(schema.users).where(eq(schema.users.email, email)))[0]?.role;
    return { app, accept, verify, invited, roleOf };
  }

  it('invites, then promotes only after the account verifies, then refuses', async () => {
    const f = await fresh();
    expect(
      (await f.accept(await f.invited('Owner@Example.test'), 'owner@example.test')).status,
    ).toBe(201);
    expect(await f.roleOf('owner@example.test')).toBe('user');
    // Running again before verifying leaves the account alone.
    expect(await bootstrapAdmin(f.app.db, 'owner@example.test')).toEqual({
      kind: 'awaiting-verification',
    });
    await f.verify('owner@example.test');
    // Untouched by that run: the account signs in normally once verified.
    const signIn = await new Browser(f.app.app).request('/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: 'owner@example.test', password: OWNER_PASSWORD },
    });
    expect(signIn.status).toBe(200);
    expect(await bootstrapAdmin(f.app.db, 'owner@example.test')).toMatchObject({
      kind: 'promoted',
    });
    expect(await f.roleOf('owner@example.test')).toBe('admin');
    await expect(bootstrapAdmin(f.app.db, 'someone@example.test')).rejects.toThrow(
      expect.objectContaining({ code: 'admin-exists' }) as AccountError,
    );
  });

  it('never leaves the owner of a mistyped address with an account', async () => {
    const f = await fresh();
    const typo = await f.invited('owner@exmaple.test');
    expect((await f.accept(typo, 'owner@exmaple.test')).status).toBe(201);
    // Whoever owns the mistyped domain verifies and signs in before the operator notices.
    await f.verify('owner@exmaple.test');
    const stranger = new Browser(f.app.app);
    const signIn = () =>
      stranger.request('/api/auth/sign-in/email', {
        method: 'POST',
        json: { email: 'owner@exmaple.test', password: OWNER_PASSWORD },
      });
    expect((await signIn()).status).toBe(200);

    const fixed = await f.invited('owner@example.test');
    expect((await f.accept(fixed, 'owner@example.test')).status).toBe(201);
    await f.verify('owner@example.test');
    // Another slip leaves a link open just before promotion.
    const stray = await f.invited('owner@exampel.test');
    expect(await bootstrapAdmin(f.app.db, 'owner@example.test')).toMatchObject({
      kind: 'promoted',
      suspended: 1,
    });
    const late = await f.accept(stray, 'owner@exampel.test');
    expect((await late.json()).error.code).toBe('invitation-revoked');
    expect(await f.roleOf('owner@exmaple.test')).toBe('user');
    expect((await stranger.request('/api/me')).status).toBe(401);
    expect((await signIn()).status).not.toBe(200);
  });

  it('stops a bootstrap link working once a verified administrator exists', async () => {
    const f = await fresh();
    const token = await f.invited('late@example.test');
    await f.app.db.insert(schema.users).values({
      name: 'A',
      email: 'other-admin@example.test',
      role: 'admin',
      emailVerified: true,
    });
    const res = await f.accept(token, 'late@example.test');
    expect((await res.json()).error.code).toBe('admin-exists');
  });
});
