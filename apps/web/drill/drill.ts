// What the restore drill's seed and check share: settings, the state file,
// the test instance's Mailpit, and keeping secrets out of whatever a failure
// prints or writes.
import type { Download, Page } from '@playwright/test';
import { totp } from '@wikistow/server-app/testing/totp';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { expect } from '../e2e/fixtures';

const env = (name: string, fallback: string) => process.env[name]?.trim() || fallback;

export const WIKISTOW_URL = new URL(env('WIKISTOW_URL', 'http://localhost:3000')).origin;
export const MAILPIT_URL = new URL(env('MAILPIT_URL', 'http://127.0.0.1:8025')).origin;
const MAILPIT_AUTH_FILE = join(homedir(), '.config', 'wikistow-drill', 'mailpit-auth');
export const DRILL_STATE = env(
  'DRILL_STATE',
  join(homedir(), '.config', 'wikistow-drill', 'state.json'),
);

export type Person = {
  name: string;
  email: string;
  password: string;
  passphrase: string;
  recoveryKey: string;
  /** Their authenticator's key, in base32, once they turn two-factor on. */
  totpSecret?: string;
  backupCodes?: string[];
};

/** A page the seed made: where it is, and a marker only its text holds. */
export type SeededPage = { title: string; marker: string; path: string };

export type State = {
  /** False until the seed got through every step. */
  complete: boolean;
  /** The titles of the seed's steps done so far, which DRILL_RESUME=1 skips. */
  done: string[];
  seededAt: string;
  installationId: string;
  url: string;
  mailpitUrl: string;
  admin: Person;
  reader?: Person;
  space?: string;
  folder?: string;
  /** In `folder`, shared with the reader, with `attachment` in its publication. */
  published?: SeededPage & { attachment: { name: string; sha256: string } };
  /** Outside `folder`, published, shared with nobody. */
  private?: SeededPage;
};

const secrets = new Set<string>();

/** Note `value` as a secret, so failures show it as ‹secret›. Returns it. */
export function secret(value: string): string {
  if (value) secrets.add(value);
  return value;
}

/** A strong random password or passphrase, noted as a secret. */
export const randomSecret = () => secret(randomBytes(24).toString('base64url'));

/** A random marker for a page's text, so the check finds this seed's page and no other. */
export const randomMarker = (label: string) => `DRILL-${label}-${randomBytes(6).toString('hex')}`;

function redact<T>(error: T): T {
  if (!(error instanceof Error)) return error;
  const hide = (text: string | undefined) =>
    [...secrets].reduce((shown, value) => shown.replaceAll(value, '‹secret›'), text ?? '');
  error.message = hide(error.message);
  error.stack = hide(error.stack);
  redact(error.cause);
  return error;
}

/**
 * Run a test's body, rewriting any error so no noted secret reaches the
 * report: Playwright's call logs echo URLs (an invitation's token) and
 * matchers echo the values they compared.
 */
export async function quietly(body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    throw redact(error);
  }
}

/** The state the seed wrote, its passwords and keys noted as secrets. */
export function readState(): State {
  if (!existsSync(DRILL_STATE))
    throw new Error(`No drill state at ${DRILL_STATE}. Run the seed first, or set DRILL_STATE.`);
  const state: State = JSON.parse(readFileSync(DRILL_STATE, 'utf8'));
  for (const person of [state.admin, state.reader])
    if (person)
      [
        person.password,
        person.passphrase,
        person.recoveryKey,
        person.totpSecret ?? '',
        ...(person.backupCodes ?? []),
      ].forEach(secret);
  return state;
}

/**
 * Write the state, readable only by its owner. A directory made for it only
 * its owner can open; one that exists is left as it is.
 */
export function writeState(state: State) {
  mkdirSync(dirname(DRILL_STATE), { recursive: true, mode: 0o700 });
  writeFileSync(DRILL_STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(DRILL_STATE, 0o600);
}

/** The installation's ID, from the address a restore must keep. */
export async function installationId(): Promise<string> {
  const res = await fetch(`${WIKISTOW_URL}/api/installation`);
  expect(res.ok, `GET ${WIKISTOW_URL}/api/installation answered ${res.status}`).toBe(true);
  const body: { installationId?: unknown } = await res.json();
  expect(typeof body.installationId, 'the installation has no installationId').toBe('string');
  return String(body.installationId);
}

type MailpitSummary = { ID: string; Subject: string; Created: string };

let mailpitAuth: string | undefined;

/**
 * GET from Mailpit's API, with its login: MAILPIT_AUTH (`user:password`), or
 * else the contents of ~/.config/wikistow-drill/mailpit-auth.
 */
async function mailpit<T>(path: string): Promise<T> {
  if (!mailpitAuth) {
    let login = process.env['MAILPIT_AUTH']?.trim();
    if (!login && existsSync(MAILPIT_AUTH_FILE))
      login = readFileSync(MAILPIT_AUTH_FILE, 'utf8').trim();
    if (!login)
      throw new Error(
        `No Mailpit login: set MAILPIT_AUTH, or write user:password to ${MAILPIT_AUTH_FILE}.`,
      );
    secret(login);
    mailpitAuth = secret(`Basic ${Buffer.from(login).toString('base64')}`);
  }
  const res = await fetch(`${MAILPIT_URL}${path}`, { headers: { authorization: mailpitAuth } });
  if (!res.ok) throw new Error(`Mailpit answered ${res.status} for ${path.split('?')[0]}`);
  return res.json();
}

/**
 * The path of the link in the newest mail to `to` whose subject matches,
 * received since `since`, from Mailpit's API, waiting for it to arrive.
 */
export async function mailedLink(to: string, subject: RegExp, since: Date): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        const query = new URLSearchParams({ query: `to:"${to}"`, limit: '50' });
        const { messages } = await mailpit<{ messages: MailpitSummary[] }>(
          `/api/v1/search?${query}`,
        );
        id = messages.find((m) => subject.test(m.Subject) && new Date(m.Created) >= since)?.ID;
        return id;
      },
      { message: `no mail to ${to} matching ${subject} reached ${MAILPIT_URL}`, timeout: 30_000 },
    )
    .toBeTruthy();
  const { Text } = await mailpit<{ Text: string }>(`/api/v1/message/${id}`);
  const link = Text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`The mail to ${to} matching ${subject} holds no link`);
  const url = new URL(link);
  secret(url.search.slice(1));
  secret(url.hash.slice(1));
  return url.pathname + url.search + url.hash;
}

/**
 * Sign in from the sign-in page; ends past it. When the server asks for a
 * two-factor code, it's made from the person's recorded key; the result says
 * whether it asked. Sign-in allows five tries a minute from one address,
 * which a seed and a check run back to back can use up, so a refusal for
 * that waits out the minute once.
 */
export async function signInAs(page: Page, person: Person): Promise<{ withCode: boolean }> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(person.password);
  const code = page.getByLabel('Code', { exact: true });
  const tooMany = page.getByRole('alert').filter({ hasText: 'Too many attempts' });
  const submit = async () => {
    await page.getByRole('button', { name: 'Sign in' }).click();
    let outcome: 'signed in' | 'code' | 'limited' | undefined;
    await expect
      .poll(
        async () => {
          if (!new URL(page.url()).pathname.startsWith('/sign-in')) outcome = 'signed in';
          else if (await code.isVisible()) outcome = 'code';
          else if (await tooMany.isVisible()) outcome = 'limited';
          return outcome;
        },
        { message: `${person.email} didn't get past sign-in with the recorded password` },
      )
      .toBeTruthy();
    return outcome;
  };

  let outcome = await submit();
  if (outcome === 'limited') {
    await page.waitForTimeout(61_000);
    outcome = await submit();
  }
  if (outcome === 'limited')
    throw new Error(`Sign-in for ${person.email} is still refused for too many attempts`);
  if (outcome === 'signed in') return { withCode: false };

  if (!person.totpSecret)
    throw new Error(`Sign-in asked ${person.email} for a two-factor code, but no key is recorded`);
  const secretKey = person.totpSecret;
  const alert = page.getByRole('alert');
  // The next 30-second step's code: each step's works once, and turning
  // two-factor on, or a sign-in just before this one, may have used this
  // step's. The app says the same for a used code as for a wrong one.
  const verify = async () => {
    await code.fill(totp(secretKey, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Verify' }).click();
    let outcome: 'signed in' | 'refused' | undefined;
    let answer = '';
    await expect
      .poll(
        async () => {
          if (!new URL(page.url()).pathname.startsWith('/sign-in')) outcome = 'signed in';
          else if (await alert.first().isVisible()) {
            answer = (await alert.first().textContent())?.trim() ?? '';
            outcome = 'refused';
          }
          return outcome;
        },
        { message: `${person.email}'s two-factor code got no answer` },
      )
      .toBeTruthy();
    // Anything but a refusal of the code, such as the error a server shows
    // when it can't open the stored key, is no reason to try another.
    if (outcome === 'refused' && !answer.includes('That code didn’t work'))
      throw new Error(
        `The server answered ${person.email}'s two-factor code with “${answer}”. A restored ` +
          'server whose BETTER_AUTH_SECRET differs from the original can’t open the stored key.',
      );
    return outcome;
  };
  if ((await verify()) === 'refused') {
    // A sign-in in the last 30 seconds may have used it. The next step's isn't.
    await page.waitForTimeout(30_000);
    if ((await verify()) === 'refused')
      throw new Error(
        `The server refused two codes in a row from ${person.email}'s recorded two-factor key`,
      );
  }
  return { withCode: true };
}

/** Unlock the vault from its unlock page with the passphrase. */
export async function unlockWithPassphrase(page: Page, person: Person) {
  await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await page.getByLabel('Vault passphrase').fill(person.passphrase);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(
    page.getByRole('heading', { name: 'Unlock your vault' }),
    `${person.email}'s recorded passphrase didn't unlock the vault`,
  ).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Open `path` in the app, which reloads and so locks the vault, then unlock
 * again; the app comes back to `path`.
 */
export async function openUnlocked(page: Page, person: Person, path: string) {
  await page.goto(path);
  await unlockWithPassphrase(page, person);
  await page.waitForURL((url) => url.pathname === path);
}

/** Download the attachment linked from the page in view; returns its SHA-256, as hex. */
export async function downloadedHash(page: Page, name: string): Promise<string> {
  const link = page.getByRole('link', { name: `Download ${name}` });
  // The link's address is the decrypted file, once it has been decrypted.
  await expect(link, `${name} didn't decrypt`).toHaveAttribute('href', /^blob:/, {
    timeout: 30_000,
  });
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  return sha256(await bytesOf(download));
}

async function bytesOf(download: Download): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** An 8×8 PNG of random pixels, so each seed's attachment has bytes of its own. */
export function randomPng(): Buffer {
  const side = 8;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(crc32(body), body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  // Each row starts with its filter type, 0 for none.
  const rows = Array.from({ length: side }, () =>
    Buffer.concat([Buffer.alloc(1), randomBytes(side * 3)]),
  );
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
