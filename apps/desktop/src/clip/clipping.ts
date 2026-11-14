// Browser clipping in the desktop app (docs/adr/0017-web-clipper.md): the
// setting, the socket or pipe the extension's helper reaches the app on,
// the host manifests that let the browser start the helper, and the desk
// that hands clips to the page (desk.ts). Main makes one at launch and
// starts it before the window loads.
import type { ClipBrowser, ClippingState, desktopRoutes } from '@wikistow/contracts';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { packagedFolder } from '../install.ts';
import { clipDesk } from './desk.ts';
import { imageFetcher, type Resolve } from './images.ts';
import { clipListener, type ClipConnection, type ClipEndpoint } from './listener.ts';
import {
  HOST_NAMES,
  isAllowed,
  manifestTargets,
  PUBLISHED_EXTENSIONS,
  syncManifests,
  windowsRegistry,
  withExtension,
  type Registry,
} from './manifests.ts';
import { PROTOCOLS, type Message } from './protocol.ts';

/** How long an `open` keeps telling the extension of each change, at most. */
const OPEN_WATCH_MS = 10 * 60_000;
const OPEN_POLL_MS = 500;

export type ClippingOptions = {
  which: desktopRoutes.DesktopApp;
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
  userData: string;
  /** The app was given a data folder of its own (`--user-data-dir`), as the tests are. */
  ownDataFolder: boolean;
  appPath: string;
  execPath: string;
  version: string;
  /** The launch's switches: `--clip-manifests` and `--clip-extension=…`. */
  argv: readonly string[];
  /** What main knows of the app's state itself; the page tells it the vault's. */
  session: () => 'starting' | 'signed-out' | 'signed-in';
  /** Bring the window forward. */
  show: () => void;
  /** The user agent images are fetched with. */
  userAgent: string;
  registry?: Registry;
  /** How the image fetcher looks names up; the system's by default. */
  resolve?: Resolve;
};

const Setting = z.object({ on: z.boolean() });

/** The helper this copy ships, and whether it's an installed package's. */
export function clipHelper(
  options: Pick<ClippingOptions, 'platform' | 'arch' | 'appPath' | 'execPath'>,
  exists: (path: string) => boolean = existsSync,
): { path: string; installed: boolean } | null {
  const { platform, arch, appPath, execPath } = options;
  const name = platform === 'win32' ? 'wikistow-clip-host.exe' : 'wikistow-clip-host';
  // Beside the app in each package: /usr/lib/wikistow-desktop, the Windows
  // install folder, and WikiStow.app/Contents/MacOS.
  const folder = platform === 'linux' ? packagedFolder(appPath, platform) : dirname(execPath);
  if (folder && exists(join(folder, name))) return { path: join(folder, name), installed: true };
  // A development build's, from scripts/clip-host.sh.
  const goos = ({ linux: 'linux', win32: 'windows', darwin: 'darwin' } as Record<string, string>)[
    platform
  ];
  const goarch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[arch];
  if (!goos || !goarch) return null;
  const built = join(appPath, 'out', 'clip-host', `${goos}-${goarch}`, name);
  return exists(built) ? { path: built, installed: false } : null;
}

/** The switch's value, as `--name=value`, or null. */
const switchValue = (argv: readonly string[], name: string) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

export function desktopClipping(options: ClippingOptions) {
  const { platform, env, userData, which } = options;
  const hostName = HOST_NAMES[which];
  const registry = options.registry ?? windowsRegistry;
  const settingFile = join(userData, 'clipping.json');
  const helper = clipHelper(options);
  // A development build writes none unless asked, so it doesn't take the
  // installed app's host name; nor does one with no helper to name.
  const development = !helper || (!helper.installed && !options.argv.includes('--clip-manifests'));
  // A Mac app opened where it was unzipped runs from a random path macOS removes later.
  const translocated = platform === 'darwin' && options.appPath.includes('/AppTranslocation/');
  const allowed = withExtension(PUBLISHED_EXTENSIONS, switchValue(options.argv, 'clip-extension'));
  const xdgConfig = env['XDG_CONFIG_HOME'];
  const configHome = xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(options.home, '.config');
  const targets = manifestTargets({ platform, home: options.home, configHome, userData, hostName });
  const desk = clipDesk({
    session: options.session,
    show: options.show,
    fetcher: imageFetcher({
      userAgent: options.userAgent,
      ...(options.resolve && { resolve: options.resolve }),
    }),
  });
  const listener = clipListener({
    endpoint: endpoint(),
    hostFile: hostFile(),
    allowed: (caller) => isAllowed(allowed, caller),
    answer,
  });

  let on = true;
  let browsers: ClipBrowser[] = [];
  let unavailable = false;
  /** Changes to the setting, one at a time. */
  let changing: Promise<unknown> = Promise.resolve();

  function endpoint(): ClipEndpoint {
    if (platform === 'win32') return { kind: 'pipe' };
    // Named for the data folder, so two apps on two folders never share one.
    const name = `clip-${createHash('sha256').update(userData).digest('hex').slice(0, 12)}.sock`;
    const runtime = env['XDG_RUNTIME_DIR'];
    if (platform === 'linux' && runtime && isAbsolute(runtime)) {
      const folder = join(runtime, which === 'beta' ? 'wikistow-beta' : 'wikistow');
      return { kind: 'unix', folder, name };
    }
    // A Mac's per-user temporary folder loses old files, so the data folder.
    return { kind: 'unix', folder: join(userData, 'clip'), name };
  }

  // %LOCALAPPDATA% on Windows: only the person reads it, and it never roams
  // to a file server as %APPDATA% can. Where the helper looks (clip-host/).
  function hostFile() {
    const local = env['LOCALAPPDATA'];
    if (platform === 'win32' && !options.ownDataFolder && local && isAbsolute(local)) {
      return join(local, 'WikiStow Desktop', 'clip-host.json');
    }
    return join(userData, 'clip-host.json');
  }

  function problem(): ClippingState['problem'] {
    if (!on) return null;
    if (unavailable) return 'unavailable';
    if (translocated) return 'translocated';
    return development ? 'development' : null;
  }

  const state = (): ClippingState => ({
    on,
    problem: problem(),
    browsers: on ? browsers : [],
    recent: desk.recent(),
  });

  /** The manifests as the setting says, for the helper this copy ships. */
  /**
   * The manifests as the setting says, for the helper this copy ships. A
   * development build or a translocated Mac app leaves them alone, on or
   * off: they are the installed app's, and deleting them would leave the
   * extension unable to start it.
   */
  async function manifests() {
    if (translocated || development) return void (browsers = []);
    const named = on ? (helper?.path ?? null) : null;
    browsers = await syncManifests(targets, named, allowed, registry, hostName).catch(() => []);
  }

  async function apply() {
    if (on) {
      unavailable = !(await listener.start().then(
        () => true,
        () => false,
      ));
    } else {
      unavailable = false;
      await listener.stop();
    }
  }

  function status(id: string) {
    return {
      id,
      type: 'status',
      app: desk.state(),
      offline: desk.offline(),
      appVersion: options.version,
      protocols: PROTOCOLS,
    };
  }

  function answer(message: Message, connection: ClipConnection) {
    switch (message.type) {
      case 'hello':
        return connection.reply(status(message.id));
      case 'open':
        options.show();
        return watch(message.id, connection);
      default:
        return desk.answer(message, connection);
    }
  }

  /** Answer `open` with the state, then again each time it changes, until `ready`. */
  function watch(id: string, connection: ClipConnection) {
    let last = desk.state();
    connection.reply(status(id));
    if (last === 'ready') return;
    const timer = setInterval(() => {
      const now = desk.state();
      if (now === last) return;
      last = now;
      connection.reply(status(id));
      if (now === 'ready') stop();
    }, OPEN_POLL_MS);
    const ending = setTimeout(stop, OPEN_WATCH_MS);
    function stop() {
      clearInterval(timer);
      clearTimeout(ending);
    }
    connection.closed.addEventListener('abort', stop, { once: true });
  }

  return {
    /** Read the setting and act on it: before the window loads, as a helper may be waiting. */
    async start() {
      const kept = await readFile(settingFile, 'utf8').catch(() => null);
      on = kept === null ? true : (Setting.safeParse(parseOr(kept)).data?.on ?? true);
      await apply();
      // Off the launch's way: the browsers read them only when asked to clip.
      changing = manifests();
    },
    async state(): Promise<ClippingState> {
      await changing;
      return state();
    },
    set(next: boolean): Promise<ClippingState> {
      const run = changing.then(async () => {
        const file = `${settingFile}.next`;
        await writeFile(file, JSON.stringify({ on: next }), { mode: 0o600 });
        await rename(file, settingFile);
        on = next;
        await apply();
        await manifests();
        return state();
      });
      changing = run.catch(() => {});
      return run;
    },
    /** As the app quits: delete clip-host.json and the socket, so the helper finds it closed. */
    stopNow: () => listener.removeFiles(),
    /** The clips, folder searches and images the page deals with (desk.ts). */
    desk,
  };
}

function parseOr(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
