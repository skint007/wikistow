import { bootstrapAdmin, createInvitation, inviteAccount, schema } from '@wikistow/server';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { asAgent, enrolledAgent } from './support/agents.ts';
import { personWithVault } from './support/content.ts';
import { Browser, createTestApp, lastMailTo, linkIn, type TestApp } from './support/harness.ts';
import { testIssuer } from './support/accounts.ts';

let t: TestApp;
const PASSWORD = 'a long enough passphrase';
let counter = 0;
const uniqueEmail = () => `member${++counter}@example.test`;

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

async function join(token: string, email: string) {
  const browser = new Browser(t.app);
  const created = await browser.request('/api/accounts', {
    method: 'POST',
    json: { token, email, name: email.split('@')[0], password: PASSWORD },
  });
  expect(created.status).toBe(201);
  await new Browser(t.app).request(linkIn(lastMailTo(t.mails, email)));
  expect((await signIn(browser, email)).status).toBe(200);
  const { accountId } = (await created.json()) as { accountId: string };
  return { browser, email, id: accountId };
}

const signIn = (browser: Browser, email: string) =>
  browser.request('/api/auth/sign-in/email', {
    method: 'POST',
    json: { email, password: PASSWORD },
  });

const member = async () => {
  const email = uniqueEmail();
  return join(
    (await createInvitation(t.db, { email, role: 'user', createdBy: await testIssuer(t) })).token,
    email,
  );
};

let admin: Awaited<ReturnType<typeof join>>;

beforeAll(async () => {
  t = await createTestApp();
  const email = 'owner@example.test';
  const invited = await bootstrapAdmin(t.db, email);
  if (invited.kind !== 'invited') throw new Error('expected a bootstrap link');
  admin = await join(invited.token, email);
  // The operator's second run, after verification, grants the role and ends
  // the sessions from before it, so the administrator signs in again.
  expect(await bootstrapAdmin(t.db, email)).toMatchObject({ kind: 'promoted' });
  expect((await admin.browser.request('/api/me')).status).toBe(401);
  expect((await signIn(admin.browser, email)).ok).toBe(true);
});
afterAll(() => t.drop());

const post = (browser: Browser, path: string, json?: unknown) =>
  browser.request(path, { method: 'POST', ...(json === undefined ? {} : { json }) });

describe('admin routes', () => {
  it('turn away people who are not administrators', async () => {
    const { browser, id } = await member();
    for (const path of ['/api/admin/accounts', '/api/admin/invitations', '/api/admin/settings']) {
      expect((await browser.request(path)).status, path).toBe(403);
      expect((await new Browser(t.app).request(path)).status, path).toBe(401);
    }
    const res = await post(browser, `/api/admin/accounts/${id}/role`, { role: 'admin' });
    expect(res.status).toBe(403);
  });
});

describe('a recent sign-in', () => {
  /** A separate administrator whose last full sign-in was 11 minutes ago. */
  async function staleAdmin() {
    const someone = await member();
    await t.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, someone.id));
    await t.db
      .update(schema.sessions)
      .set({ authenticatedAt: sql`now() - interval '11 minutes'` })
      .where(eq(schema.sessions.userId, someone.id));
    return someone;
  }

  it('is needed for every change but not for reading', async () => {
    const stale = await staleAdmin();
    const { id } = await member();
    const invitationId = (await t.db.select().from(schema.invitations).limit(1))[0]?.id ?? '';
    expect((await stale.browser.request('/api/admin/accounts')).status).toBe(200);
    const changes: [string, string, unknown?][] = [
      ['POST', `/api/admin/accounts/${id}/role`, { role: 'admin' }],
      ['POST', `/api/admin/accounts/${id}/suspend`],
      ['POST', `/api/admin/accounts/${id}/reactivate`],
      ['POST', `/api/admin/accounts/${id}/revoke-sessions`],
      ['POST', `/api/admin/accounts/${id}/resend-verification`],
      ['POST', '/api/admin/invitations', { email: null, role: 'user' }],
      ['POST', `/api/admin/invitations/${invitationId}/resend`],
      ['DELETE', `/api/admin/invitations/${invitationId}`],
      ['PUT', '/api/admin/settings', { publicRegistration: true }],
    ];
    for (const [method, path, json] of changes) {
      const res = await stale.browser.request(path, { method, ...(json ? { json } : {}) });
      expect(await errorCode(res), `${method} ${path}`).toBe('reauth-required');
    }
    // Signing in again is what makes a change go through.
    expect((await signIn(stale.browser, stale.email)).status).toBe(200);
    expect((await post(stale.browser, `/api/admin/accounts/${id}/suspend`)).status).toBe(200);
  });
});

describe('suspension', () => {
  it('ends every session at once, blocks sign-in, and reactivation does not revive old sessions', async () => {
    const target = await member();
    const open = target.browser.clone();
    expect((await post(admin.browser, `/api/admin/accounts/${target.id}/suspend`)).status).toBe(
      200,
    );

    expect((await open.request('/api/me')).status).toBe(401);
    expect((await signIn(new Browser(t.app), target.email)).status).toBe(403);

    expect((await post(admin.browser, `/api/admin/accounts/${target.id}/reactivate`)).status).toBe(
      200,
    );
    expect((await open.request('/api/me')).status).toBe(401);
    expect((await signIn(new Browser(t.app), target.email)).status).toBe(200);
  });

  it('cannot be turned on yourself', async () => {
    const res = await post(admin.browser, `/api/admin/accounts/${admin.id}/suspend`);
    expect(await errorCode(res)).toBe('cannot-target-self');
  });

  it('signs someone out everywhere when their role changes', async () => {
    const target = await member();
    const before = target.browser.clone();
    const res = await post(admin.browser, `/api/admin/accounts/${target.id}/role`, {
      role: 'admin',
    });
    expect(res.ok).toBe(true);
    // A session from before the change never acts as an administrator.
    expect((await before.request('/api/admin/accounts')).status).toBe(401);
  });

  it('revokes the agent credentials of someone suspended', async () => {
    // Through revokeCredentials (#7, protocol section 9.7), as a role change is.
    const suspended = await personWithVault(t);
    const suspendedAgent = await enrolledAgent(t, suspended);
    expect((await asAgent(t, suspendedAgent.token, '/api/spaces')).status).toBe(200);
    expect((await post(admin.browser, `/api/admin/accounts/${suspended.id}/suspend`)).ok).toBe(
      true,
    );
    expect((await post(admin.browser, `/api/admin/accounts/${suspended.id}/reactivate`)).ok).toBe(
      true,
    );
    expect((await asAgent(t, suspendedAgent.token, '/api/spaces')).status).toBe(401);
  });

  it('revoking sessions signs someone out without blocking them', async () => {
    const target = await member();
    expect(
      (await post(admin.browser, `/api/admin/accounts/${target.id}/revoke-sessions`)).status,
    ).toBe(200);
    expect((await target.browser.request('/api/me')).status).toBe(401);
    expect((await signIn(target.browser, target.email)).status).toBe(200);
  });
});

describe('administrator roles', () => {
  it('can never leave the installation without an administrator', async () => {
    expect(
      await errorCode(
        await post(admin.browser, `/api/admin/accounts/${admin.id}/role`, { role: 'user' }),
      ),
    ).toBe('cannot-target-self');
  });
});

describe('invitations', () => {
  it('stop working when the administrator who issued them is suspended', async () => {
    const rogue = await member();
    await t.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, rogue.id));
    const issued = await post(rogue.browser, '/api/admin/invitations', {
      email: null,
      role: 'admin',
    });
    const { link } = (await issued.json()) as { link: string };

    expect((await post(admin.browser, `/api/admin/accounts/${rogue.id}/suspend`)).status).toBe(200);
    expect((await post(admin.browser, `/api/admin/accounts/${rogue.id}/reactivate`)).status).toBe(
      200,
    );

    const res = await new Browser(t.app).request('/api/accounts', {
      method: 'POST',
      json: {
        token: link.split('token=')[1],
        email: uniqueEmail(),
        name: 'Back door',
        password: PASSWORD,
      },
    });
    expect(await errorCode(res)).toBe('invitation-revoked');
  });

  it('are re-checked against their issuer when redeemed', async () => {
    const issuer = await member();
    const setIssuer = (values: Partial<typeof schema.users.$inferInsert>) =>
      t.db.update(schema.users).set(values).where(eq(schema.users.id, issuer.id));
    await setIssuer({ role: 'admin' });
    const { token } = await inviteAccount(t.db, { actor: issuer.id, email: null, role: 'user' });
    // Demoted or suspended without going through the admin routes, so nothing
    // revoked the link.
    await setIssuer({ role: 'user' });
    const res = await new Browser(t.app).request('/api/accounts', {
      method: 'POST',
      json: { token, email: uniqueEmail(), name: 'Late', password: PASSWORD },
    });
    expect(await errorCode(res)).toBe('invitation-revoked');
  });

  it('replace the old link on resend and refuse a revoked one', async () => {
    const created = await post(admin.browser, '/api/admin/invitations', {
      email: null,
      role: 'user',
    });
    const { invitation, link: first } = (await created.json()) as {
      invitation: { id: string };
      link: string;
    };
    const resent = await post(admin.browser, `/api/admin/invitations/${invitation.id}/resend`);
    const { link: second } = (await resent.json()) as { link: string };
    const tokenOf = (link: string) => link.split('token=')[1];

    const attempt = (link: string) =>
      new Browser(t.app).request('/api/accounts', {
        method: 'POST',
        json: { token: tokenOf(link), email: uniqueEmail(), name: 'X', password: PASSWORD },
      });
    expect(await errorCode(await attempt(first))).toBe('invitation-not-found');

    const revoked = await admin.browser.request(`/api/admin/invitations/${invitation.id}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    expect(await errorCode(await attempt(second))).toBe('invitation-revoked');
  });
});
