// Mail set on the admin page: its password is write-only and sealed at rest,
// and the server's environment wins over it.
import { fileBlobStore, schema } from '@wikistow/server';
import { createTestDatabase } from '@wikistow/server/testing';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import type { MailSetup } from '../src/mail/mailer.ts';
import { Browser, testConfig } from './support/harness.ts';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
const setups: MailSetup[] = [];
const ADMIN = 'admin@example.test';
const PASSWORD = 'a long enough passphrase';
const SMTP_PASSWORD = 'relay-password-1234';

/** An administrator signed in to an app on the shared database with `overrides`. */
async function adminOn(overrides: Partial<Config>) {
  const app = createApp({
    db: db.db,
    config: testConfig(db.url, overrides),
    log: () => {},
    blobs: fileBlobStore('/nonexistent'),
    transport: (setup) => async () => {
      setups.push(setup);
    },
  }).app;
  const browser = new Browser(app);
  const res = await browser.request('/api/auth/sign-in/email', {
    method: 'POST',
    json: { email: ADMIN, password: PASSWORD },
  });
  expect(res.status).toBe(200);
  return browser;
}

const noEnv = { smtp: { url: undefined, from: undefined } };
const mailOf = async (admin: Browser) => (await admin.request('/api/admin/settings/mail')).json();

beforeAll(async () => {
  db = await createTestDatabase();
  const [user] = await db.db
    .insert(schema.users)
    .values({ name: 'Admin', email: ADMIN, role: 'admin', emailVerified: true })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('admin was not inserted');
  await db.db.insert(schema.accounts).values({
    userId: user.id,
    accountId: user.id,
    providerId: 'credential',
    password: await hashPassword(PASSWORD),
  });
});
afterAll(() => db.drop());

it('keeps the SMTP password write-only, sealed, and unset under another secret', async () => {
  const admin = await adminOn(noEnv);
  const saved = await admin.request('/api/admin/settings/mail', {
    method: 'PUT',
    json: {
      host: 'smtp.example.test',
      port: 587,
      security: 'starttls',
      username: 'wiki',
      password: SMTP_PASSWORD,
      from: 'WikiStow <wiki@example.test>',
    },
  });
  const body = await saved.text();
  expect(body).not.toContain(SMTP_PASSWORD);
  expect(JSON.parse(body)).toMatchObject({ passwordSaved: true, ready: true });
  const [row] = await db.db.select().from(schema.settings);
  expect(row?.smtpPassword).not.toContain(SMTP_PASSWORD);
  // The mail that goes out has it.
  await admin.request('/api/admin/settings/mail/test', { method: 'POST', json: {} });
  expect(setups.at(-1)?.connection).toMatchObject({ password: SMTP_PASSWORD });

  const elsewhere = await adminOn({ ...noEnv, authSecret: 'x'.repeat(48) });
  expect(await mailOf(elsewhere)).toMatchObject({
    host: 'smtp.example.test',
    passwordSaved: false,
  });
});

it('lets the environment win, showing none of its values', async () => {
  const env = { url: 'smtp://env.example.test:25', from: 'Env <env@example.test>' };
  const admin = await adminOn({ smtp: env });
  expect(await mailOf(admin)).toEqual({
    host: null,
    port: null,
    security: null,
    username: null,
    passwordSaved: false,
    from: null,
    environment: ['host', 'port', 'security', 'username', 'password', 'from'],
    ready: true,
  });
  await admin.request('/api/admin/settings/mail/test', {
    method: 'POST',
    json: { host: 'form.example.test', from: 'Form <form@example.test>' },
  });
  expect(setups.at(-1)).toEqual({ from: env.from, connection: { url: env.url } });
});
