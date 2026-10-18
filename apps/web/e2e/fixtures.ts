import {
  expect,
  test as base,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

const CONTROL = `http://127.0.0.1:${Number(process.env['E2E_PORT'] ?? 3100) + 1}`;
export const PASSWORD = 'a long enough password for tests';

type Violation = { directive: string; blocked: string; source: string };

/**
 * Report every Content Security Policy violation in `context`, across all of
 * its pages and navigations, to `sink`. Each page also keeps its own list,
 * for tests that wait for a violation to happen.
 */
async function watchViolations(context: BrowserContext, sink: Violation[]) {
  await context.exposeFunction('__reportViolation', (violation: Violation) => {
    sink.push(violation);
  });
  await context.addInitScript(() => {
    const seen: unknown[] = [];
    Object.defineProperty(window, '__violations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      const violation = {
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        source: `${location.pathname} ${event.sourceFile}:${event.lineNumber}:${event.columnNumber}`,
      };
      seen.push(violation);
      const report: unknown = Reflect.get(window, '__reportViolation');
      if (typeof report === 'function') void report(violation);
    });
  });
}

/**
 * Every test fails on a Content Security Policy violation it didn't expect,
 * in any page it opens, so a component that injects inline styles or
 * scripts is caught at once.
 */
export const test = base.extend<
  {
    expectedViolations: string[];
    violations: Violation[];
    cspGuard: void;
    freshPage: () => Promise<Page>;
  },
  { admin: { email: string } }
>({
  // The installation's first administrator, made once per run on its setup page.
  admin: [
    async ({ browser }, use) => {
      const existing: { email: string | null } = await (await fetch(`${CONTROL}/owner`)).json();
      if (existing.email) return use({ email: existing.email });
      const email = uniqueEmail('owner');
      const context = await browser.newContext();
      await firstAdmin(await context.newPage(), email);
      await context.close();
      await use({ email });
    },
    { scope: 'worker' },
  ],
  expectedViolations: [[], { option: true }],
  // Playwright reads fixture dependencies from this pattern, so it must be `{}`.
  // oxlint-disable-next-line no-empty-pattern
  violations: async ({}, use) => {
    await use([]);
  },
  // Another person's browser. Closed after the test, so open connections
  // don't pile up across the run.
  freshPage: async ({ browser, violations }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext();
      await watchViolations(context, violations);
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
  cspGuard: [
    async ({ context, violations, expectedViolations }, use) => {
      await watchViolations(context, violations);
      await use();
      const unexpected = violations.filter((v) => !expectedViolations.includes(v.directive));
      expect(unexpected, 'unexpected CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** Pick `option` with `picker`, one of the app's themed pickers (packages/ui's `Picker`). */
export async function pick(picker: Locator, option: string) {
  await picker.click();
  await picker.page().getByRole('menuitemradio', { name: option, exact: true }).click();
}

export async function violationsIn(page: Page): Promise<Violation[]> {
  if (page.isClosed()) return [];
  return page.evaluate(() => {
    const found: unknown = Reflect.get(window, '__violations');
    return Array.isArray(found) ? found : [];
  });
}

type Mail = { to: string; subject: string; text: string };

/** Everything the server holds: every table's rows, every blob file, its log, and its mail. */
export async function serverSnapshot(): Promise<{
  rows: Record<string, unknown[]>;
  blobs: string[];
  logs: unknown[];
  mails: Mail[];
}> {
  return (await fetch(`${CONTROL}/snapshot`)).json();
}

/**
 * Which of `secrets` the server holds readably: in any table, blob file,
 * log line or mail, as text, as hex (how byte columns read), or inside any
 * base64url field or blob file, decoded, and inside any JSON decoded from
 * one.
 */
export async function secretsOnServer(secrets: string[]): Promise<string[]> {
  const { rows, blobs, logs, mails } = await serverSnapshot();
  const parts = [Buffer.from(JSON.stringify({ rows, logs, mails }))];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!/^[\w-]{4,}$/.test(value)) return;
      const bytes = Buffer.from(value, 'base64url');
      parts.push(bytes);
      try {
        visit(JSON.parse(bytes.toString('utf8')));
      } catch {
        // Not JSON; the bytes are already searched.
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value !== null && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(rows);
  for (const blob of blobs) parts.push(Buffer.from(blob, 'base64url'));
  const stored = Buffer.concat(parts);
  return secrets.filter(
    (secret) =>
      stored.includes(Buffer.from(secret)) ||
      stored.includes(Buffer.from(Buffer.from(secret).toString('hex'))),
  );
}

/** Messages received over SMTP, with headers and text decoded as a mail client sees them. */
export async function mailsTo(to: string): Promise<Mail[]> {
  const res = await fetch(`${CONTROL}/mails`);
  const all: Mail[] = await res.json();
  return all.filter((mail) => mail.to === to);
}

/** The path of the link in the newest mail to `to`, waiting for it to arrive. */
export async function linkFor(to: string, subject: RegExp): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(async () => {
      const mail = (await mailsTo(to)).filter((m) => subject.test(m.subject)).at(-1);
      link = mail?.text.match(/https?:\/\/\S+/)?.[0];
      return link;
    })
    .toBeTruthy();
  const url = new URL(link ?? '');
  return url.pathname + url.search + url.hash;
}

/** Give the account's person new keys at the next key version, as a recovery or a hostile server would. */
export async function swapKey(email: string): Promise<void> {
  const res = await fetch(`${CONTROL}/swap-key?email=${encodeURIComponent(email)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`swap-key: ${await res.text()}`);
}

/** The test server's blob folder, where library plugins' files are kept too (`plugins/<hash>/`). */
export async function serverBlobDir(): Promise<string> {
  const { blobDir }: { blobDir: string } = await (await fetch(`${CONTROL}/blob-dir`)).json();
  return blobDir;
}

let counter = 0;
export const uniqueEmail = (label: string) => `${label}${Date.now()}${++counter}@example.test`;

/** Accept an invitation link in the browser, leaving the email unconfirmed. */
export async function acceptInvitation(
  page: Page,
  invitePath: string,
  email: string,
  name = 'Test Person',
) {
  await page.goto(invitePath);
  await page.getByLabel('Your name').fill(name);
  const emailField = page.getByLabel('Email');
  if (await emailField.isEditable()) await emailField.fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();
}

/** Accept an invitation link in the browser, confirm the email, and sign in. */
export async function joinWith(
  page: Page,
  invitePath: string,
  email: string,
  name = 'Test Person',
) {
  await acceptInvitation(page, invitePath, email, name);
  await page.goto(await linkFor(email, /confirm|verify/i));
  await expect(page).toHaveURL(/\/sign-in\?verified=/);
  await signIn(page, email);
}

/** Past sign-in: on the vault pages or in the app, wherever the account belongs next. */
export async function expectSignedIn(page: Page) {
  await page.waitForURL(
    (url) => !['/sign-in', '/invite', '/setup'].some((path) => url.pathname.startsWith(path)),
  );
  await expect(page.getByRole('heading').first()).toBeVisible();
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  if (!page.url().includes('/sign-in')) await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A fresh installation's first administrator, from its setup page, signed in. Only works once per server. */
export async function firstAdmin(page: Page, email: string) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up WikiStow' })).toBeVisible();
  await page.getByLabel('Your name').fill('Owner');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repeat password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expectSignedIn(page);
}
