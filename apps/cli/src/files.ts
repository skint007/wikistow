// The CLI's own directory and the files in it: the key file, the local
// state and the journal. Only the person running the CLI may read or write
// any of them, and each is replaced whole, never rewritten in place.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { CliError } from './exit.ts';

/**
 * Where the CLI keeps its files: `$XDG_CONFIG_HOME/wikistow`, or
 * `~/.config/wikistow` when that is unset or not an absolute path, as the
 * XDG spec says. Neither variable holds a secret: only where to look.
 */
export function configDir(env: Readonly<Record<string, string | undefined>>): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg?.startsWith('/')) return join(xdg, 'wikistow');
  const home = env.HOME;
  if (!home?.startsWith('/')) {
    throw new CliError('usage', 'Set HOME or XDG_CONFIG_HOME to an absolute path');
  }
  return join(home, '.config', 'wikistow');
}

const uid = () => process.getuid?.() ?? -1;

// Refuse anything a symlink, another user, or a group or world bit could
// let someone else read or swap: the key file's protection is only as good
// as the directory it sits in.
function requirePrivate(path: string, stats: Stats, kind: 'directory' | 'file'): void {
  const isKind = kind === 'directory' ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !isKind) {
    throw new CliError('locked', `${path} is not a plain ${kind}; refusing to use it`);
  }
  if (stats.uid !== uid()) {
    throw new CliError('locked', `${path} belongs to another user; refusing to use it`);
  }
  if ((stats.mode & 0o077) !== 0) {
    const want = kind === 'directory' ? '700' : '600';
    const mode = (stats.mode & 0o777).toString(8);
    throw new CliError(
      'locked',
      `${path} has mode ${mode}, which lets others in; run chmod ${want} on it`,
    );
  }
}

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** Make `dir` (mode 700) if it is missing, and refuse it if anyone else can get in. */
export function ensurePrivateDir(dir: string): void {
  if (!lstatOrNull(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkPrivateDir(dir);
}

/** Every directory above `path`, up to the root. */
function above(path: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === dirname(dir)) return dirs;
  }
}

/**
 * Refuse a directory above the CLI's own that someone else could change:
 * whoever can rename entries in one could put a directory of theirs in
 * place of the CLI's. As OpenSSH's StrictModes asks, each must be this
 * user's or root's, and not writable by group or others, both on the path
 * as given and where its links lead. A root-owned sticky directory such as
 * /tmp is allowed: there, only an entry's owner may rename it.
 */
function checkAncestors(dir: string): void {
  const sticky = (stats: Stats) => stats.uid === 0 && (stats.mode & 0o1000) !== 0;
  for (const path of new Set([...above(dir), ...above(realpathSync(dir))])) {
    const stats = lstatSync(path);
    if (stats.uid !== uid() && stats.uid !== 0) {
      throw new CliError('locked', `${path} belongs to another user; refusing to use ${dir}`);
    }
    if (!stats.isSymbolicLink() && (stats.mode & 0o022) !== 0 && !sticky(stats)) {
      const mode = (stats.mode & 0o777).toString(8);
      throw new CliError(
        'locked',
        `${path} has mode ${mode}, which lets others replace ${dir}; run chmod go-w on it`,
      );
    }
  }
}

/** Refuse `dir` unless it is a directory of this user's, with mode 700 or tighter. */
export function checkPrivateDir(dir: string): void {
  const stats = lstatOrNull(dir);
  if (!stats) {
    throw new CliError(
      'not-enrolled',
      `${dir} does not exist: this CLI is not enrolled; run wikistow agent enroll`,
    );
  }
  requirePrivate(dir, stats, 'directory');
  checkAncestors(dir);
}

/**
 * The bytes of a private file, or null when there is none. Its directory
 * and the file itself must be this user's alone (700 and 600, or tighter).
 * The file is checked as opened, and must be the one its path named, so
 * nothing swapped in between the check and the read is read.
 */
export function readPrivateFile(path: string): Uint8Array | null {
  checkPrivateDir(dirname(path));
  const named = lstatOrNull(path);
  if (!named) return null;
  requirePrivate(path, named, 'file');
  let fd: number;
  try {
    // Not following a link, and not waiting on a FIFO's writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause) {
    throw new CliError('locked', `${path} changed as it was opened; refusing to use it`, { cause });
  }
  try {
    const opened = fstatSync(fd);
    requirePrivate(path, opened, 'file');
    if (opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new CliError('locked', `${path} changed as it was opened; refusing to use it`);
    }
    return new Uint8Array(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

/**
 * Replace `path` with `bytes`, mode 600, all at once: a crash leaves the old
 * file or the new one, never part of either. The bytes reach the disk
 * before this returns, so a caller can count on them, as the No going back
 * marks do (section 6.8).
 */
export function writePrivateFile(path: string, bytes: Uint8Array): void {
  const dir = dirname(path);
  checkPrivateDir(dir);
  const temporary = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    let written = 0;
    while (written < bytes.length) written += writeSync(fd, bytes, written);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const dirFd = openSync(dir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** A lock older than this was left by a run that died: no run holds one for more than a write. */
const STALE_LOCK_MS = 30_000;

/** Whether `a` is the very file `b` was: inode numbers are reused, so its mtime must match too. */
const sameFile = (a: Stats | null, b: Stats) =>
  a !== null && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs;

/**
 * Run `fn` holding the lock file `path`, made with O_EXCL, so two runs of
 * the CLI can't both read a file, change it and write it back, each losing
 * what the other wrote. Waits up to `waitMs` for another run to finish,
 * and takes over a lock so old its run must have died.
 */
export function withFileLock<T>(path: string, fn: () => T, { waitMs = 10_000 } = {}): T {
  const until = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let mine: Stats;
  for (;;) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        mine = fstatSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = lstatOrNull(path);
    if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) takeOver(path, held);
    else if (Date.now() > until) {
      throw new CliError(
        'locked',
        `Another run of the CLI holds ${path}; if none is running, remove that file`,
      );
    } else Atomics.wait(pause, 0, 0, 10);
  }
  try {
    return fn();
  } finally {
    // Only this run's own lock: one taken over as stale is another run's now.
    if (sameFile(lstatOrNull(path), mine)) rmSync(path, { force: true });
  }
}

/**
 * Remove the lock `stale`, judged so old its run died. Another run may
 * have judged it so too, removed it and made its own since, so the lock
 * is first moved aside, which is atomic, and removed only if it is the
 * one judged; any other is put back.
 */
function takeOver(path: string, stale: Stats): void {
  const aside = `${path}.${randomBytes(8).toString('hex')}.stale`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // Taken over already.
    throw error;
  }
  if (!sameFile(lstatSync(aside), stale)) {
    // A link, unlike a rename, never replaces a lock yet another run made meanwhile.
    try {
      linkSync(aside, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  rmSync(aside, { force: true });
}

/** Remove a private file, if it is there. */
export function removePrivateFile(path: string): void {
  rmSync(path, { force: true });
}
