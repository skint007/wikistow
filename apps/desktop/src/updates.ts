// Whether a newer release of the desktop app is out (#12): the newest stable
// release, or on the beta channel the newest release, betas included
// (versions.ts). Main asks GitHub for its releases, with no token and nothing
// about the person or their wiki, when the app starts and every few hours. It
// keeps the last answer, so a launch offline still knows; a failed check
// changes nothing and shows nothing. The app never installs anything itself.
import type { DesktopUpdate } from '@wikistow/contracts';
import { net } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { packagedFolder } from './install.ts';
import { channelOf, isPrerelease, newer, newestFor, parse, type Channel } from './versions.ts';

/** The newest releases by date, enough to hold the newest of each channel. */
const RELEASES = 'https://api.github.com/repos/skint007/wikistow/releases?per_page=30';
const RELEASE_PAGE = 'https://github.com/skint007/wikistow/releases/tag/';
const DOWNLOAD = 'https://github.com/skint007/wikistow/releases/download/';
const CHECK_MS = 6 * 60 * 60_000;
/** How long one check may take, so the first answer never keeps the menu waiting long. */
const ANSWER_MS = 10_000;

const Releases = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
  }),
);
const Kept = z.object({ version: z.string() });
const Source = z.enum(['aur', 'deb', 'rpm', 'windows', 'mac']);

/**
 * How this copy was installed, from its `install-source`. On Linux, trusted
 * only when it runs from where the packages put it. The Windows installer
 * and the Mac app keep it in `resources`, beside `app.asar`.
 */
async function installSource(appPath: string): Promise<DesktopUpdate['source']> {
  const linux = process.platform === 'linux';
  const packaged = packagedFolder(appPath);
  if (linux && !packaged) return null;
  const file = join(packaged ?? dirname(appPath), 'install-source');
  const word = await readFile(file, 'utf8').catch(() => '');
  const source = Source.safeParse(word.trim());
  return source.success ? source.data : null;
}

/** The channel the Linux package says, from its `channel` beside `install-source`, or null. */
async function packagedChannel(appPath: string): Promise<string | null> {
  const packaged = packagedFolder(appPath);
  if (!packaged) return null;
  return readFile(join(packaged, 'channel'), 'utf8').catch(() => null);
}

/** Where the notice sends the person: the installer for this computer on Windows, else the release page. */
function releaseLink(version: string, source: DesktopUpdate['source']) {
  if (source === 'windows') {
    return `${DOWNLOAD}v${version}/wikistow-desktop-${version}-${process.arch}-setup.exe`;
  }
  return `${RELEASE_PAGE}v${version}`;
}

/** The update check for the app at `appPath`, running version `installed`, keeping its answer in `userData`. */
export function desktopUpdates(userData: string, installed: string, appPath: string) {
  const file = join(userData, 'update.json');
  /** The newest release on this copy's channel last seen, as `0.4.0`. */
  let latest: string | null = null;
  let source: DesktopUpdate['source'] = null;
  let channel: Channel = channelOf(installed, null);
  let started: Promise<void> = Promise.resolve();

  async function check() {
    try {
      const response = await net.fetch(RELEASES, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WikiStow-desktop' },
        signal: AbortSignal.timeout(ANSWER_MS),
      });
      if (!response.ok) return;
      const version = newestFor(channel, Releases.parse(await response.json()));
      if (!version || version === latest) return;
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
        channel = channelOf(installed, await packagedChannel(appPath));
        const kept = await readFile(file, 'utf8')
          .then((text) => Kept.parse(JSON.parse(text)).version)
          .catch(() => null);
        // A beta kept from before this copy left the beta channel isn't offered.
        if (kept && parse(kept) && (channel === 'beta' || !isPrerelease(kept))) latest = kept;
        await check();
      })();
      setInterval(() => void check(), CHECK_MS);
    },
    /** A newer release than the one running, once the first check settled; null otherwise. */
    async state(): Promise<DesktopUpdate | null> {
      await started;
      if (!latest || !newer(latest, installed)) return null;
      return { installed, version: latest, url: releaseLink(latest, source), source };
    },
  };
}
