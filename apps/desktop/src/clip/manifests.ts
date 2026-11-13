// The native messaging host manifests that let the WikiStow extension start
// wikistow-clip-host (docs/adr/0017-web-clipper.md, decision 2). The app
// writes them for the person alone at each launch, for each browser whose
// profile folder it finds, or on Windows in the registry for all five, and
// deletes them when Browser clipping is turned off. Each names only the
// published extensions, by exact origin or ID.
import type { ClipBrowser } from '@wikistow/contracts';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

/** Each app's host name, after the Mac app's bundle ID. Only lowercase, digits, `_` and `.`. */
export const HOST_NAMES = {
  stable: 'io.github.skint007.wikistow',
  beta: 'io.github.skint007.wikistow_beta',
} as const;

/**
 * The published extensions. The Chrome Web Store fixes the Chrome ID at the
 * first upload (ADR 0017, step 7), so until then no Chromium browser gets a
 * manifest unless a launch adds an extension (`--clip-extension`). Edge
 * and Brave install from the Chrome Web Store too.
 */
export const PUBLISHED_EXTENSIONS: Allowed = {
  chromium: [],
  firefox: ['web-clipper@wikistow.skint007.github.io'],
};

/** The extensions a manifest names: Chrome's exact origins, and Firefox's IDs. */
export type Allowed = { chromium: string[]; firefox: string[] };

const CHROME_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;
const FIREFOX_ID = /^(?:[\w.+-]{1,64}@[\w.-]{1,64}|\{[0-9a-fA-F-]{36}\})$/;

/** `extra` added to `allowed`, if it's a Chrome origin or a Firefox ID; else unchanged. */
export function withExtension(allowed: Allowed, extra: string | null): Allowed {
  if (extra && CHROME_ORIGIN.test(extra)) {
    return { ...allowed, chromium: [...allowed.chromium, extra] };
  }
  if (extra && FIREFOX_ID.test(extra)) return { ...allowed, firefox: [...allowed.firefox, extra] };
  return allowed;
}

export const isAllowed = (allowed: Allowed, caller: string) =>
  allowed.chromium.includes(caller) || allowed.firefox.includes(caller);

/** One browser's manifest: where it goes, and, on Windows, the key naming it. */
export type ManifestTarget = {
  browser: ClipBrowser;
  family: 'chromium' | 'firefox';
  /** Folders of which any one shows the browser is used here; none on Windows, which writes every key. */
  profiles: string[];
  file: string;
  registryKey: string | null;
};

export type ManifestPlaces = {
  platform: NodeJS.Platform;
  home: string;
  /** `$XDG_CONFIG_HOME`, or `~/.config`, on Linux. */
  configHome: string;
  /** The app's data folder, which keeps the Windows manifests. */
  userData: string;
  hostName: string;
};

/** Where each browser looks for this host's manifest, per user, on this system. */
export function manifestTargets(places: ManifestPlaces): ManifestTarget[] {
  const { platform, home, configHome, userData, hostName } = places;
  const file = `${hostName}.json`;
  const chromium = (browser: ClipBrowser, profile: string): ManifestTarget => ({
    browser,
    family: 'chromium',
    profiles: [profile],
    file: join(profile, 'NativeMessagingHosts', file),
    registryKey: null,
  });
  if (platform === 'linux') {
    return [
      chromium('chrome', join(configHome, 'google-chrome')),
      chromium('chromium', join(configHome, 'chromium')),
      chromium('edge', join(configHome, 'microsoft-edge')),
      chromium('brave', join(configHome, 'BraveSoftware', 'Brave-Browser')),
      // Newer profiles are in ~/.config/mozilla, but Firefox still reads
      // ~/.mozilla/native-messaging-hosts, which the app makes, as Bitwarden does.
      {
        browser: 'firefox',
        family: 'firefox',
        profiles: [join(home, '.mozilla'), join(configHome, 'mozilla')],
        file: join(home, '.mozilla', 'native-messaging-hosts', file),
        registryKey: null,
      },
    ];
  }
  if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    return [
      chromium('chrome', join(support, 'Google', 'Chrome')),
      chromium('chromium', join(support, 'Chromium')),
      chromium('edge', join(support, 'Microsoft Edge')),
      chromium('brave', join(support, 'BraveSoftware', 'Brave-Browser')),
      // Firefox keeps its profiles in …/Firefox and reads manifests from …/Mozilla.
      {
        browser: 'firefox',
        family: 'firefox',
        profiles: [join(support, 'Firefox')],
        file: join(support, 'Mozilla', 'NativeMessagingHosts', file),
        registryKey: null,
      },
    ];
  }
  if (platform === 'win32') {
    // One file for each family, which the keys name. HKCU\Software is one
    // key in both registry views, so one write serves every browser.
    const folder = join(userData, 'native-messaging');
    const key = (path: string) => `HKCU\\Software\\${path}\\NativeMessagingHosts\\${hostName}`;
    const windows = (browser: ClipBrowser, path: string): ManifestTarget => ({
      browser,
      family: browser === 'firefox' ? 'firefox' : 'chromium',
      profiles: [],
      file: join(folder, `${hostName}.${browser === 'firefox' ? 'firefox' : 'chromium'}.json`),
      registryKey: key(path),
    });
    return [
      windows('chrome', 'Google\\Chrome'),
      windows('chromium', 'Chromium'),
      windows('edge', 'Microsoft\\Edge'),
      windows('brave', 'BraveSoftware\\Brave-Browser'),
      windows('firefox', 'Mozilla'),
    ];
  }
  return [];
}

/** A manifest's text: the host, the helper's absolute path, and the extensions allowed. */
export function manifestText(
  family: 'chromium' | 'firefox',
  hostName: string,
  helper: string,
  allowed: Allowed,
) {
  const manifest = {
    name: hostName,
    description: 'WikiStow web clipper',
    path: helper,
    type: 'stdio',
    ...(family === 'chromium'
      ? { allowed_origins: allowed.chromium }
      : { allowed_extensions: allowed.firefox }),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The registry, which the app reaches through `reg.exe`, having no native modules. */
export type Registry = {
  /** Set the key's default value. */
  set(key: string, value: string): Promise<void>;
  /** Delete the key, if it's there. */
  remove(key: string): Promise<void>;
};

const run = promisify(execFile);
export const windowsRegistry: Registry = {
  set: async (key, value) => {
    await run('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true });
  },
  remove: async (key) => {
    await run('reg', ['delete', key, '/f'], { windowsHide: true }).catch(() => {});
  },
};

/**
 * Write each manifest a browser here would read, naming `helper`, and
 * delete the rest; with `helper` null, delete them all. A manifest is
 * written only when its text differs, whole and then moved into place. A
 * family with no extension allowed gets none. Answers the browsers set up.
 */
export async function syncManifests(
  targets: ManifestTarget[],
  helper: string | null,
  allowed: Allowed,
  registry: Registry,
  hostName: string,
): Promise<ClipBrowser[]> {
  const set: ClipBrowser[] = [];
  const written = new Map<string, Promise<void>>();
  for (const target of targets) {
    const ids = allowed[target.family];
    const used =
      target.profiles.length === 0 || target.profiles.some((profile) => existsSync(profile));
    if (helper && ids.length > 0 && used) {
      const text = manifestText(target.family, hostName, helper, allowed);
      // Windows' Chromium browsers share one file.
      const writing = written.get(target.file) ?? writeIfChanged(target.file, text);
      written.set(target.file, writing);
      await writing;
      if (target.registryKey) await registry.set(target.registryKey, target.file);
      set.push(target.browser);
    } else {
      if (!written.has(target.file)) await rm(target.file, { force: true });
      if (target.registryKey) await registry.remove(target.registryKey);
    }
  }
  return set;
}

async function writeIfChanged(file: string, text: string) {
  if ((await readFile(file, 'utf8').catch(() => null)) === text) return;
  await mkdir(dirname(file), { recursive: true });
  const next = `${file}.next`;
  await writeFile(next, text, { mode: 0o644 });
  await rename(next, file);
}
