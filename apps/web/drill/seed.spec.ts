// Fill a fresh installation for the restore drill, and record in DRILL_STATE
// everything `check` needs to prove a restored copy of it. Every password,
// passphrase and recovery key is new and random, and kept only there.
import type { Page } from '@playwright/test';
import { totp } from '@wikistow/server-app/testing/totp';
import { existsSync } from 'node:fs';
import { expect, test } from '../e2e/fixtures';
import { folderMenu, newFolder, newSpace, shareFolder } from '../e2e/sharing';
import {
  confirmRecoveryKey,
  expectSource,
  fillSource,
  newPage,
  sourceOf,
  waitForSave,
} from '../e2e/vault';
import {
  DRILL_STATE,
  installationId,
  MAILPIT_URL,
  mailedLink,
  quietly,
  readState,
  secret,
  randomMarker,
  randomPng,
  randomSecret,
  sha256,
  signInAs,
  unlockWithPassphrase,
  WIKISTOW_URL,
  writeState,
  type Person,
  type State,
} from './drill';

const person = (name: string, email: string): Person => ({
  name,
  email,
  password: randomSecret(),
  passphrase: randomSecret(),
  recoveryKey: '',
});

/** Mail sent from now on, allowing for the server's clock running a little behind. */
const fromNow = () => new Date(Date.now() - 60_000);

/** Accept an invitation, confirm the email from Mailpit, sign in, and set up the vault. */
async function join(page: Page, invitePath: string, who: Person, sentSince: Date) {
  await page.goto(invitePath);
  await expect(
    page.getByRole('heading', { name: 'Join WikiStow' }),
    `the invitation for ${who.email} didn't open`,
  ).toBeVisible();
  await page.getByLabel('Your name').fill(who.name);
  const emailField = page.getByLabel('Email');
  if (await emailField.isEditable()) await emailField.fill(who.email);
  await page.getByLabel('Password', { exact: true }).fill(who.password);
  await page.getByLabel('Repeat password').fill(who.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  await page.goto(await mailedLink(who.email, /confirm|verify/i, sentSince));
  await expect(page, `${who.email}'s confirmation link didn't verify it`).toHaveURL(
    /\/sign-in\?verified=/,
  );
  await signInAs(page, who);
  await setUpVault(page, who);
}

/** Create the signed-in person's vault, recording its recovery key. */
async function setUpVault(page: Page, who: Person) {
  await expect(page.getByRole('heading', { name: 'Set up your vault' })).toBeVisible();
  await page.getByLabel('Vault passphrase').fill(who.passphrase);
  await page.getByLabel('Repeat passphrase').fill(who.passphrase);
  await page.getByLabel('Account password').fill(who.password);
  await page.getByRole('button', { name: 'Create vault' }).click();
  who.recoveryKey = secret(await confirmRecoveryKey(page));
}

/** Publish the draft in view as its first version. */
async function publish(page: Page) {
  await waitForSave(page);
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published v1')).toBeVisible();
}

/**
 * The seed's state: a new one, or with DRILL_RESUME=1 the one recorded, whose
 * steps not yet in `done` run: those after where a seed stopped, or any added
 * since it finished.
 */
async function startingState(): Promise<State> {
  if (process.env['DRILL_RESUME'] === '1') return { ...readState(), complete: false };
  if (existsSync(DRILL_STATE) && process.env['DRILL_FORCE'] !== '1')
    throw new Error(
      `${DRILL_STATE} exists: it may hold the only copy of a seeded instance's passwords. ` +
        'Move it away, set DRILL_RESUME=1 to finish the seed that wrote it, ' +
        'or set DRILL_FORCE=1 to overwrite it.',
    );
  return {
    complete: false,
    done: [],
    seededAt: new Date().toISOString(),
    installationId: await installationId(),
    url: WIKISTOW_URL,
    mailpitUrl: MAILPIT_URL,
    admin: person('Drill Admin', 'admin@wikistow.test'),
  };
}

test('seed a fresh installation for the restore drill', ({ page, freshPage }) =>
  quietly(async () => {
    test.setTimeout(300_000);
    const state = await startingState();
    expect(state.installationId, `${WIKISTOW_URL} is not the installation being seeded`).toBe(
      await installationId(),
    );
    // Written before each secret is used, so a seed that stops halfway still
    // leaves the passwords of the accounts it made.
    writeState(state);
    const { admin } = state;

    /**
     * Run a step of the seed once: skipped when `done` lists its title,
     * listed there as soon as it succeeds. A step that stops partway isn't
     * listed, so resuming runs it again; one that changed something first is
     * finished by hand and listed, with what it records (README.md).
     */
    async function once(title: string, body: () => Promise<void>) {
      if (state.done.includes(title)) return test.step.skip(title, async () => {});
      await test.step(title, body).catch((error: unknown) => {
        // The title exactly as `done` would list it.
        const stopped = `The step ${JSON.stringify(title)} stopped. `;
        if (error instanceof Error) {
          error.message = stopped + error.message;
          error.stack = stopped + error.stack;
        }
        throw error;
      });
      state.done.push(title);
      writeState(state);
    }

    /** The administrator, signed in afresh in a browser of their own. */
    async function adminPage() {
      const page = await freshPage();
      await signInAs(page, admin);
      return page;
    }

    await once('the first administrator sets up the installation', async () => {
      await page.goto('/');
      await expect(
        page.getByRole('heading', { name: 'Set up WikiStow' }),
        `${WIKISTOW_URL} has no setup page (it may have an administrator already)`,
      ).toBeVisible();
      await page.getByLabel('Your name').fill(admin.name);
      await page.getByLabel('Email').fill(admin.email);
      await page.getByLabel('Password', { exact: true }).fill(admin.password);
      await page.getByLabel('Repeat password').fill(admin.password);
      await page.getByRole('button', { name: 'Create administrator' }).click();
      await setUpVault(page, admin);
    });

    const reader = (state.reader ??= person('Drill Reader', 'reader@wikistow.test'));
    writeState(state);
    await once('the administrator invites a second person, who joins', async () => {
      const page = await adminPage();
      // The admin dashboard isn't behind the vault.
      await page.goto('/admin/invitations');
      const sentSince = fromNow();
      await page.getByLabel('Email (optional)').fill(reader.email);
      await page.getByLabel('Member').check();
      await page.getByRole('button', { name: 'Create invitation' }).click();
      await expect(page.getByText(`Invitation sent to ${reader.email}.`)).toBeVisible();
      await join(
        await freshPage(),
        await mailedLink(reader.email, /invited you/, sentSince),
        reader,
        sentSince,
      );
    });

    await once('the administrator fills a space', async () => {
      const page = await adminPage();
      await unlockWithPassphrase(page, admin);
      const space = (state.space = 'Restore drill');
      const folder = (state.folder = 'Shared with the reader');

      await test.step('with a folder', async () => {
        await newSpace(page, space);
        await newFolder(page, folder);
      });

      await test.step('a page in it, published with an attachment', async () => {
        const title = 'Drill published page';
        const marker = randomMarker('PUBLISHED');
        const name = 'drill-picture.png';
        const png = randomPng();
        await folderMenu(page, folder, 'New page here');
        await page.getByRole('dialog').getByLabel('Title').fill(title);
        await page.getByRole('button', { name: 'Create page' }).click();
        await expect(page.locator('#page-title')).toHaveValue(title);
        await page
          .locator('input[type=file]')
          .setInputFiles({ name, mimeType: 'image/png', buffer: png });
        await expectSource(page, /!\[[^\]]*\]\(attachment:[\w-]+\)/);
        const id = /\(attachment:([\w-]+)\)/.exec(await sourceOf(page))?.[1];
        // The picture, and a link to download it, which the check follows.
        await fillSource(
          page,
          `${marker}\n\n![${name}](attachment:${id})\n\n[Download ${name}](attachment:${id})\n`,
        );
        await publish(page);
        await expect(page.getByRole('img', { name })).toHaveAttribute('src', /^blob:/);
        const path = new URL(page.url()).pathname;
        state.published = { title, marker, path, attachment: { name, sha256: sha256(png) } };
        writeState(state);
      });

      await test.step('the folder shared with the second person as a reader', async () => {
        const dialog = await shareFolder(page, folder, reader.email, 'reader');
        await expect(dialog.getByRole('region', { name: 'People with access' })).toContainText(
          reader.name,
        );
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      });

      await test.step('and a page outside it, published and shared with nobody', async () => {
        const title = 'Drill private page';
        const marker = randomMarker('PRIVATE');
        await newPage(page, title);
        await fillSource(page, `${marker}\n`);
        await publish(page);
        state.private = { title, marker, path: new URL(page.url()).pathname };
      });
    });

    // The server keeps the key encrypted with BETTER_AUTH_SECRET, so the
    // check signing in with a code from it proves a restore kept that too.
    await once('the second person turns on two-factor', async () => {
      const page = await freshPage();
      await signInAs(page, reader);
      // Settings isn't behind the vault.
      await page.goto('/settings');
      await page.getByRole('button', { name: 'Manage two-factor sign-in' }).click();
      await page.getByLabel('Password', { exact: true }).fill(reader.password);
      await page.getByRole('button', { name: 'Set up two-factor' }).click();
      const key = await page.getByText('Or enter this key').locator('code').textContent();
      if (!key) throw new Error('Setting up two-factor showed no key');
      reader.totpSecret = secret(key);
      writeState(state);
      await page.getByLabel('Code', { exact: true }).fill(totp(key));
      await page.getByRole('button', { name: 'Turn on' }).click();
      const codes = page.getByRole('list', { name: 'Backup codes' });
      await expect(codes, 'two-factor didn’t turn on').toBeVisible();
      reader.backupCodes = (await codes.getByRole('listitem').allTextContents()).map(secret);
    });

    state.complete = true;
    writeState(state);
  }));
