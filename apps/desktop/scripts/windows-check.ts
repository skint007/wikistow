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
import { closeSync, existsSync, openSync, readFileSync, readdirSync } from 'node:fs';
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
// The app's launch adds a Firefox ID of its own, which Firefox's manifest
// names beside the published one.
const EXTENSION = 'clip-check@wikistow.invalid';
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
  const child = spawn(helper, ['manifest.json', EXTENSION], {
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

/**
 * Whether no program runs from `file`: Windows won't open a running
 * program's file for writing, which is how the installer and uninstaller
 * tell (`WaitUntilClosed` in packaging/windows.nsi).
 */
function notRunning(file: string) {
  try {
    closeSync(openSync(file, 'r+'));
    return true;
  } catch {
    return false;
  }
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

const app = spawn(exe, [`--remote-debugging-port=${PORT}`, `--clip-extension=${EXTENSION}`], {
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

/** What runs from the app's folder, by process ID and command line, Electron's own processes all being WikiStow.exe. */
function runningFrom(dir: string): string[] {
  const listed = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ' +
        "$_.ExecutablePath.StartsWith($env:CHECK_FOLDER, 'OrdinalIgnoreCase') } | " +
        'ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
    ],
    { encoding: 'utf8', env: { ...process.env, CHECK_FOLDER: `${dir}\\` } },
  );
  if (listed.status !== 0) throw new Error(`Couldn’t list processes: ${listed.stderr}`);
  return listed.stdout.split(/\r?\n/).filter(Boolean);
}
/** What runs from the app's folder, as a failure says it. */
function stillRunning() {
  try {
    return runningFrom(folder).join('; ') || 'nothing';
  } catch (error) {
    return (error as Error).message;
  }
}

// A silent uninstall gives up at once, removing nothing, while WikiStow.exe
// or the helper still runs. Each can take a moment to go once it's done:
// the app's own processes after it quits, the helper after its last
// answer. Both files must open for writing, the uninstaller's own test,
// which a program running from either fails.
await until(
  'the app and its helper to exit',
  async () => notRunning(exe) && notRunning(helper),
).catch((error) => {
  const held = `WikiStow.exe free: ${notRunning(exe)}, helper free: ${notRunning(helper)}`;
  throw new Error(`${(error as Error).message} (${held}; running: ${stillRunning()})`);
});
// Said, not checked: what else runs from the folder as the uninstall starts.
process.stdout.write(`running from the app's folder: ${stillRunning()}\n`);
// The uninstaller copies itself away to remove its folder, so it returns at
// once. A slow runner gets a while longer, and says what was left. The
// uninstaller runs once: a file it couldn't delete stays, however long
// this waits. What still runs, and whether WikiStow.exe opens for writing,
// tell a program running from it from another that only had it open.
execFileSync(join(folder, 'Uninstall WikiStow.exe'), ['/S'], { stdio: 'inherit' });
await until('the uninstall', async () => !existsSync(folder) || null, 120_000).catch((error) => {
  const left = existsSync(folder) ? readdirSync(folder).join(', ') : '';
  const writable = existsSync(exe) ? `; WikiStow.exe opens for writing: ${notRunning(exe)}` : '';
  throw new Error(
    `${(error as Error).message} (left: ${left}; running: ${stillRunning()}${writable})`,
  );
});
/**
 * Whether `file` is gone within 30 s. Windows still lists a file deleted
 * while another program has it open until that program lets go, as the
 * shell may a Start menu shortcut: the uninstaller deletes the shortcut
 * first, yet the Arm runner once found it after the folder had gone.
 */
const gone = (file: string) =>
  until(`${file} to go`, async () => !existsSync(file) || null).then(
    () => true,
    () => false,
  );
check(await gone(shortcut), 'the Start menu entry is gone');
check(registry(LINKS) === null && registry(UNINSTALL) === null, 'the registry keys are gone');
check(
  registry(FIREFOX_HOST) === null && (await gone(manifests)),
  'the host manifests and their keys are gone',
);
