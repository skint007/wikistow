// Which release the desktop app's update notice offers (#12): the newest
// stable release, or on the beta channel the newest release of any kind,
// betas included (docs/releasing.md#beta-and-stable). Kept apart from
// updates.ts, which needs Electron, so it can be tested on its own.

/** A version's parts, or null if it isn't one. Build metadata (`+<commit>`) is ignored. */
export function parse(version: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    pre: prerelease ? prerelease.split('.') : [],
  };
}

/** Semantic version precedence, as sort() wants it: a prerelease comes before its release. Both must parse. */
export function compare(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) {
    const difference = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (difference !== 0) return difference;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  const numeric = /^\d+$/;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (numeric.test(p) && numeric.test(q)) return Number(p) - Number(q);
    if (numeric.test(p) !== numeric.test(q)) return numeric.test(p) ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export const isPrerelease = (version: string) => (parse(version)?.pre.length ?? 0) > 0;

/** Whether `latest` is newer than `installed`. Either one not a version means no. */
export function newer(latest: string, installed: string): boolean {
  if (!parse(latest) || !parse(installed)) return false;
  return compare(latest, installed) > 0;
}

export type Channel = 'stable' | 'beta';

/**
 * The channel a copy follows: beta if its package says so (the AUR's
 * `-beta-bin` packages write `channel`), or if it is a beta itself, as one
 * installed from a prerelease's downloads is. A beta channel copy that a
 * stable release updated stays on beta through its package.
 */
export function channelOf(installed: string, packaged: string | null): Channel {
  return packaged?.trim() === 'beta' || isPrerelease(installed) ? 'beta' : 'stable';
}

export type ListedRelease = {
  tag_name: string;
  draft?: boolean | undefined;
  prerelease?: boolean | undefined;
};

/**
 * The newest release `releases` (GitHub's list, newest first by date, not by
 * version) offers the channel, as `0.4.0`, or null if none. Stable takes
 * only releases GitHub doesn't mark as prereleases.
 */
export function newestFor(channel: Channel, releases: ListedRelease[]): string | null {
  let best: string | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    const version = release.tag_name.replace(/^v/, '');
    const parsed = parse(version);
    if (!parsed) continue;
    const pre = release.prerelease === true || parsed.pre.length > 0;
    if (channel === 'stable' && pre) continue;
    if (best === null || compare(version, best) > 0) best = version;
  }
  return best;
}
