// Install, start and uninstall the Windows app, on a Windows runner (CI's
// windows-packages-check). Node's own modules only, so the runner needs no
// install of the workspace:
//
//   node scripts/windows-check.ts <wikistow-desktop-…-setup.exe>
//
// It checks what the installer adds, that the app opens its sign-in page,
// keeps its data apart from the CLI's and trusts the system's secret store
// (DPAPI), that a second launch with a `wikistow://` link hands it over and
// quits, that the web clipper's helper reaches it over its named pipe and
// answers for it once it's closed, and that the uninstaller takes
// everything away again. The runner is fresh, so the app runs on its own
// data folder.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [given] = process.argv.slice(2);
if (!given) throw new Error('Usage: windows-check.ts <setup.exe>');
const installer = resolve(given);
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const folder = join(env('LOCALAPPDATA'), 'Programs', 'WikiStow Desktop');
const exe = join(folder, 'WikiStow.exe');
const shortcut = join(
  env('APPDATA'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  'WikiStow.lnk',
);
const LINKS = 'HKCU\\Software\\Classes\\wikistow\\shell\\open\\command';
const UNINSTALL = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WikiStow';
const helper = join(folder, 'wikistow-clip-host.exe');
// The one host manifest a release writes before the Chrome Web Store has an ID.
const FIREFOX_HOST = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\io.github.skint007.wikistow';
const manifests = join(env('APPDATA'), 'WikiStow Desktop', 'native-messaging');
const PORT = 9333;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`Failed: ${what}`);
  process.stdout.write(`ok: ${what}\n`);
}
/** The key's values as `reg query` lists them, or null when the key is missing. */
function registry(key: string) {
  const found = spawnSync('reg', ['query', key], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout : null;
}
/**
 * Ask the helper one message, as Firefox starts it: with the manifest's
 * path and the extension's ID. Answers its first reply.
 */
async function askHelper(message: object): Promise<Record<string, unknown>> {
  const child = spawn(helper, ['manifest.json', 'web-clipper@wikistow.skint007.github.io'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
  let held = Buffer.alloc(0);
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    held = Buffer.concat([held, chunk]);
    if (held.length >= 4 && held.length >= 4 + held.readUInt32LE(0)) {
      child.stdin.end();
      return JSON.parse(held.subarray(4, 4 + held.readUInt32LE(0)).toString('utf8'));
    }
  }
  throw new Error('The helper answered nothing');
}

async function until<T>(what: string, look: () => Promise<T | null | undefined>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await look().catch(() => null);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`Timed out: ${what}`);
}

// NSIS's silent install runs to the end before it exits.
execFileSync(installer, ['/S'], { stdio: 'inherit' });
check(existsSync(exe), 'the app is installed in %LOCALAPPDATA%\\Programs\\WikiStow Desktop');
check(
  readFileSync(join(folder, 'resources', 'install-source'), 'utf8') === 'windows\n',
  'install-source says windows',
);
check(existsSync(shortcut), 'the Start menu has WikiStow');
check(registry(LINKS)?.includes(`"${exe}" "%1"`) === true, 'wikistow:// links open the app');
check(registry(UNINSTALL) !== null, 'Settings > Apps lists the uninstaller');
check(existsSync(helper), 'the web clipper’s helper is installed beside the app');

const app = spawn(exe, [`--remote-debugging-port=${PORT}`], {
  stdio: 'inherit',
});
const exited = new Promise<number | null>((resolve) => app.once('exit', resolve));
try {
  const Target = (value: unknown) =>
    Array.isArray(value)
      ? value.find(
          (target): target is { url: string; webSocketDebuggerUrl: string } =>
            typeof target?.url === 'string' && target.url.startsWith('app://wikistow/'),
        )
      : undefined;
  const page = await until('the app’s page', async () =>
    Target(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()),
  );
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  /** The value of `expression` in the page, awaited. */
  const evaluate = (expression: string) =>
    new Promise<unknown>((resolve) => {
      const asked = ++id;
      socket.addEventListener('message', function answer(event) {
        const message = JSON.parse(String(event.data));
        if (message.id !== asked) return;
        socket.removeEventListener('message', answer);
        resolve(message.result?.result?.value);
      });
      socket.send(
        JSON.stringify({
          id: asked,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  await until('the sign-in page', async () =>
    (await evaluate(
      `[...document.querySelectorAll('h1, h2, h3')].some((h) => h.textContent?.trim() === 'Sign in')`,
    )) === true
      ? true
      : null,
  );
  check(true, 'the app opens its sign-in page');
  check(
    (await evaluate('window.wikistowDesktop.secureStorage()')) === true,
    'the app trusts the secret store',
  );
  // %APPDATA%\WikiStow would be the CLI's %APPDATA%\wikistow.
  const data = join(env('APPDATA'), 'WikiStow Desktop');
  check(existsSync(data), 'the app keeps its data in %APPDATA%\\WikiStow Desktop');
  check(!existsSync(join(env('APPDATA'), 'WikiStow')), 'and nothing in %APPDATA%\\WikiStow');

  // The app writes Firefox's host manifest and its key, and its pipe answers the helper.
  await until('the host manifest', async () => registry(FIREFOX_HOST));
  const manifest = join(manifests, 'io.github.skint007.wikistow.firefox.json');
  check(
    registry(FIREFOX_HOST)?.includes(manifest) === true &&
      JSON.parse(readFileSync(manifest, 'utf8')).path === helper,
    'the app names its helper to Firefox',
  );
  check(
    existsSync(join(env('LOCALAPPDATA'), 'WikiStow Desktop', 'clip-host.json')),
    'the app says where its pipe is in %LOCALAPPDATA%\\WikiStow Desktop',
  );
  const status = await askHelper({ v: 1, id: 'a', type: 'hello' });
  check(
    status['type'] === 'status' && status['app'] === 'signed-out',
    `the helper reaches the app over its pipe (${JSON.stringify(status)})`,
  );

  // As the browser does with a sign-in link: the second launch hands it over and quits.
  const second = spawnSync(exe, ['wikistow://desktop-sign-in?code=x'], { timeout: 30_000 });
  check(second.status === 0 && app.exitCode === null, 'a second launch hands over its link');

  // Closing the window quits the app, as its close button does.
  void evaluate(`window.wikistowDesktop.windowAction('close')`);
  await until('the app to quit', async () => (await Promise.race([exited, sleep(250)])) === 0);
  check(true, 'closing the window quits the app');
  const closed = await askHelper({ v: 1, id: 'b', type: 'hello' });
  check(
    closed['app'] === 'closed',
    `the helper answers for a closed app (${JSON.stringify(closed)})`,
  );
} finally {
  // Its helpers too, which would keep WikiStow.exe open for the uninstaller.
  if (app.exitCode === null) spawnSync('taskkill', ['/F', '/T', '/PID', String(app.pid)]);
}

// The uninstaller copies itself away to remove its folder, so it returns at once.
execFileSync(join(folder, 'Uninstall WikiStow.exe'), ['/S'], { stdio: 'inherit' });
await until('the uninstall', async () => !existsSync(folder) || null);
check(!existsSync(shortcut), 'the Start menu entry is gone');
check(registry(LINKS) === null && registry(UNINSTALL) === null, 'the registry keys are gone');
check(
  registry(FIREFOX_HOST) === null && !existsSync(manifests),
  'the host manifests and their keys are gone',
);
