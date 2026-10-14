import { createHash, randomBytes } from 'node:crypto';
import { schema } from '@wikistow/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { PASSWORD, resetPassword, signedInPerson } from './support/accounts.ts';
import { createTestApp, ORIGIN, type TestApp } from './support/harness.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/** A verifier and its challenge, as the desktop app makes them. */
function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

type Person = Awaited<ReturnType<typeof signedInPerson>>;

async function approve(person: Person, challenge: string): Promise<string> {
  const res = await person.browser.request('/api/desktop/handoffs', {
    method: 'POST',
    json: { challenge },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

/** The desktop app's request: no Origin, no cookies of its own. */
const redeem = (code: string, verifier: string) =>
  t.app.request('/api/desktop/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier }),
  });

async function desktopCookie(person: Person): Promise<string> {
  const { verifier, challenge } = pkce();
  const res = await redeem(await approve(person, challenge), verifier);
  expect(res.status).toBe(200);
  return ((await res.json()) as { cookie: string }).cookie;
}

/** A read as the desktop app's main process sends it. */
const asDesktop = (cookie: string, path: string) => t.app.request(path, { headers: { cookie } });

describe('desktop sign-in', () => {
  it('redeems a code once, for a desktop session that is never a recent sign-in', async () => {
    const person = await signedInPerson(t);
    const { verifier, challenge } = pkce();
    const code = await approve(person, challenge);

    const first = await redeem(code, verifier);
    expect(first.status).toBe(200);
    const { cookie } = (await first.json()) as { cookie: string };
    expect((await asDesktop(cookie, '/api/me')).status).toBe(200);

    expect((await redeem(code, verifier)).status).toBe(410);
    const rows = await t.db
      .select({ kind: schema.sessions.kind, authenticatedAt: schema.sessions.authenticatedAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, person.id));
    expect(rows.filter((row) => row.kind === 'desktop')).toEqual([
      { kind: 'desktop', authenticatedAt: null },
    ]);
  });

  it('uses the code up when the verifier is wrong', async () => {
    const person = await signedInPerson(t);
    const { verifier, challenge } = pkce();
    const code = await approve(person, challenge);
    expect((await redeem(code, pkce().verifier)).status).toBe(410);
    expect((await redeem(code, verifier)).status).toBe(410);
  });
});

// The desktop app keeps whatever cookie the server sets next, so the
// session a password change makes for it must stay a desktop session.
it('keeps a desktop session one when a password change replaces it', async () => {
  const person = await signedInPerson(t);
  const cookie = await desktopCookie(person);
  const changed = await t.app.request('/api/auth/change-password', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      currentPassword: PASSWORD,
      newPassword: 'a different long passphrase',
      revokeOtherSessions: true,
    }),
  });
  expect(changed.status).toBe(200);
  const kinds = await t.db
    .select({ kind: schema.sessions.kind })
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, person.id));
  expect(kinds).toEqual([{ kind: 'desktop' }]);
  const next = changed.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  expect((await asDesktop(next, '/api/me')).status).toBe(200);
});

describe('desktop sessions in Settings', () => {
  it('lists and revokes a desktop app without signing the browser out', async () => {
    const person = await signedInPerson(t);
    const cookie = await desktopCookie(person);

    const fromDesktop = await asDesktop(cookie, '/api/me/desktop-sessions');
    const { sessions } = (await fromDesktop.json()) as { sessions: { id: string }[] };
    expect(sessions).toHaveLength(1);

    const other = await signedInPerson(t);
    const foreign = await other.browser.request(`/api/me/desktop-sessions/${sessions[0]?.id}`, {
      method: 'DELETE',
    });
    expect(foreign.status).toBe(404);

    const revoked = await person.browser.request(`/api/me/desktop-sessions/${sessions[0]?.id}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    expect((await asDesktop(cookie, '/api/me')).status).toBe(401);
    expect((await person.browser.request('/api/me')).status).toBe(200);
  });

  it('ends desktop sessions, and codes not yet redeemed, on a password reset', async () => {
    const person = await signedInPerson(t);
    const cookie = await desktopCookie(person);
    const { verifier, challenge } = pkce();
    const code = await approve(person, challenge);
    await resetPassword(t, person.email, 'another long passphrase');
    expect((await asDesktop(cookie, '/api/me')).status).toBe(401);
    expect((await redeem(code, verifier)).status).toBe(410);
  });
});
