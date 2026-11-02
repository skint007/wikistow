import { createServer, type Server } from 'node:http';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../web/e2e/fixtures';
import { adminTab, memberWithVault, PASSPHRASE } from '../../web/e2e/vault';
import { accountMenu, launch, newProfile, signInThroughBrowser, type Desktop } from './desktop';

// A server whose host moved: the reverse proxy answers every path with a 404 (#257).
const NOT_HERE = '404 page not found';

// The second test keeps a session and an unlock, which needs GNOME Keyring on
// a session bus; CI sets one up and says so with KEYRING=1 (`remember.spec.ts`).
const KEYRING = process.env['KEYRING'] === '1';

let desktop: Desktop | null = null;
let responder: Server | null = null;
test.afterEach(async () => {
  await desktop?.app.close();
  desktop = null;
  await new Promise((resolve) => (responder ? responder.close(resolve) : resolve(undefined)));
  responder = null;
});

const chosenServer = async (profile: string): Promise<unknown> =>
  JSON.parse(await readFile(join(profile, 'config.json'), 'utf8')).server;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

// A launch whose chosen server now gets the proxy's 404 at every path.
test('starts on its own screen when its server answers 404, and signs out on this computer', async () => {
  const gone = createServer((_request, response) => {
    response.writeHead(404, { 'content-type': 'text/plain' }).end(NOT_HERE);
  });
  responder = gone;
  await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve));
  const address = gone.address();
  if (!address || typeof address === 'string') throw new Error('The responder has no port');
  const goneAt = `http://127.0.0.1:${address.port}`;
  const profile = await newProfile();
  await writeFile(join(profile, 'config.json'), JSON.stringify({ server: goneAt }));

  desktop = await launch(profile);
  const { window } = desktop;
  await expect(
    window.getByRole('heading', { name: 'The server didn’t answer as WikiStow' }),
  ).toBeVisible();
  await expect(window.getByText(goneAt)).toBeVisible();
  await window.getByRole('button', { name: 'Sign out on this computer' }).click();
  await expect(window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(window.getByLabel('Server')).toHaveValue('');
  expect(await chosenServer(profile)).toBeNull();

  // Forgotten for good: the next launch asks for a server too.
  await desktop.app.close();
  desktop = await launch(profile);
  await expect(desktop.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(desktop.window.getByLabel('Server')).toHaveValue('');
});

test('a sign-out that gets a 404 offers to sign out on this computer, which forgets everything', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  test.skip(!KEYRING, 'needs GNOME Keyring on a session bus (KEYRING=1)');
  test.setTimeout(180_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  const profile = await newProfile();
  desktop = await launch(profile, ['--password-store=gnome-libsecret']);
  const { window } = desktop;
  await expect(window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await signInThroughBrowser(desktop, page, baseURL ?? '');
  await window.getByLabel('Vault passphrase').fill(PASSPHRASE);
  await window.getByLabel('Remember on this computer').click();
  await window.getByRole('button', { name: 'Unlock' }).click();
  await expect(window.getByRole('heading', { name: 'Pick a page' })).toBeVisible();
  // The session, the unlock and the trust marks are kept.
  await expect.poll(() => exists(join(profile, 'secrets.json'))).toBe(true);
  await expect.poll(() => exists(join(profile, 'trust-marks'))).toBe(true);

  // A sign-out main sends now gets the proxy's 404, and is counted. Only
  // that one, so nothing else that fails (an owner check, say) opens a
  // dialog over the menu.
  await desktop.app.evaluate((_electron, body) => {
    const send = globalThis.fetch;
    Reflect.set(globalThis, '__signOuts', 0);
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (!url.endsWith('/api/auth/sign-out')) return send(input, init);
      Reflect.set(globalThis, '__signOuts', Number(Reflect.get(globalThis, '__signOuts')) + 1);
      return new Response(body, { status: 404 });
    };
  }, NOT_HERE);
  const signOutsSent = () =>
    desktop?.app.evaluate(() => Number(Reflect.get(globalThis, '__signOuts')));
  await accountMenu(window, 'Sign out');
  await expect(window.getByRole('alert')).toContainText('Couldn’t reach the server to sign out');
  expect(await signOutsSent()).toBe(1);
  await window.getByRole('button', { name: 'Sign out on this computer' }).click();
  await expect(window.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(window.getByLabel('Server')).toHaveValue('');
  expect(await chosenServer(profile)).toBeNull();
  expect(await exists(join(profile, 'secrets.json'))).toBe(false);
  expect(await exists(join(profile, 'trust-marks'))).toBe(false);
  // The server wasn't asked again: its session is still there.
  expect(await signOutsSent()).toBe(1);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Desktop apps' })).toHaveAccessibleDescription(
    '1 signed in',
  );
});
