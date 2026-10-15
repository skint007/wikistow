// Whether a newer stable release of the desktop app is out (#12). Main asks
// GitHub for the latest release, with no token and nothing about the person
// or their wiki, when the app starts and every few hours. It keeps the last
// answer, so a launch offline still knows; a failed check changes nothing
// and shows nothing. The app never installs anything itself.
import type { DesktopUpdate } from '@wikistow/contracts';
import { net } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/** GitHub's latest release is never a draft or a prerelease. */
const LATEST = 'https://api.github.com/repos/skint007/wikistow/releases/latest';
const RELEASE_PAGE = 'https://github.com/skint007/wikistow/releases/tag/';
const CHECK_MS = 6 * 60 * 60_000;
/** How long one check may take, so the first answer never keeps the menu waiting long. */
const ANSWER_MS = 10_000;
/** Where every package installs the app, with its `install-source` (docs/desktop.md). */
const PACKAGED = '/usr/lib/wikistow-desktop';

const Latest = z.object({ tag_name: z.string() });
const Kept = z.object({ version: z.string() });
const Source = z.enum(['aur', 'deb', 'rpm']);

/** A version's numbers and whether it is a prerelease, or null if it isn't one. Build metadata (`+<commit>`) is ignored. */
function parse(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: !!prerelease,
  };
}

/** Whether `latest`, a stable release, is newer than `installed`. A prerelease comes before its release. */
export function newer(latest: string, installed: string): boolean {
  const next = parse(latest);
  const now = parse(installed);
  if (!next || !now) return false;
  const order = next.major - now.major || next.minor - now.minor || next.patch - now.patch;
  return order > 0 || (order === 0 && now.prerelease);
}

/** How this copy was installed, trusted only when it runs from where the packages put it. */
async function installSource(appPath: string): Promise<DesktopUpdate['source']> {
  if (!appPath.startsWith(`${PACKAGED}/`)) return null;
  const word = await readFile(join(PACKAGED, 'install-source'), 'utf8').catch(() => '');
  const source = Source.safeParse(word.trim());
  return source.success ? source.data : null;
}

/** The update check for the app at `appPath`, running version `installed`, keeping its answer in `userData`. */
export function desktopUpdates(userData: string, installed: string, appPath: string) {
  const file = join(userData, 'update.json');
  /** The newest stable release last seen, as `0.4.0`. */
  let latest: string | null = null;
  let source: DesktopUpdate['source'] = null;
  let started: Promise<void> = Promise.resolve();

  async function check() {
    try {
      const response = await net.fetch(LATEST, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WikiStow-desktop' },
        signal: AbortSignal.timeout(ANSWER_MS),
      });
      if (!response.ok) return;
      const version = Latest.parse(await response.json()).tag_name.replace(/^v/, '');
      const release = parse(version);
      if (!release || release.prerelease || version === latest) return;
      latest = version;
      // Written whole, then moved into place, as the config is.
      await writeFile(`${file}.next`, JSON.stringify({ version }));
      await rename(`${file}.next`, file);
    } catch {
      // Offline, or GitHub didn't answer: the last answer stands.
    }
  }

  return {
    /** Read the kept answer and how the app was installed, then check now and every `CHECK_MS`. */
    start() {
      started = (async () => {
        source = await installSource(appPath);
        const kept = await readFile(file, 'utf8')
          .then((text) => Kept.parse(JSON.parse(text)).version)
          .catch(() => null);
        if (kept && parse(kept)) latest = kept;
        await check();
      })();
      setInterval(() => void check(), CHECK_MS);
    },
    /** A newer release than the one running, once the first check settled; null otherwise. */
    async state(): Promise<DesktopUpdate | null> {
      await started;
      if (!latest || !newer(latest, installed)) return null;
      return { installed, version: latest, url: `${RELEASE_PAGE}v${latest}`, source };
    },
  };
}
