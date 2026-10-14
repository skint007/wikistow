import type { ShareId, SpaceId } from '@wikistow/contracts';
import type { WritesOwner } from './owner-predicates.ts';
import { CryptoError } from './errors.ts';
import type { FolderKeyring, HeldKeyVersion } from './folder-keys.ts';

/**
 * Where a client keeps its No going back marks (section 6.8): for each
 * `(spaceId, shareId)`, the highest key version it has opened that counts for
 * writing. The desktop app and the CLI keep them in their local file, next to
 * the contacts mark; the browser keeps them in memory, for one session.
 */
export interface KeyVersionMarks {
  /** The mark for one share, or 0 when there is none. */
  get(spaceId: SpaceId, shareId: ShareId): number;
  /** Raise the mark to `keyVersion`. A lower version leaves it where it is. */
  raise(spaceId: SpaceId, shareId: ShareId, keyVersion: number): void;
}

/** Marks kept in memory: the browser's, for one session. */
export class MemoryKeyVersionMarks implements KeyVersionMarks {
  readonly #marks = new Map<string, number>();

  get(spaceId: SpaceId, shareId: ShareId): number {
    return this.#marks.get(`${spaceId} ${shareId}`) ?? 0;
  }

  raise(spaceId: SpaceId, shareId: ShareId, keyVersion: number): void {
    const key = `${spaceId} ${shareId}`;
    this.#marks.set(key, Math.max(this.#marks.get(key) ?? 0, keyVersion));
  }
}

/**
 * The highest key version held for a share whose envelope was sealed by an
 * owner `writes` accepts (section 6.5, **Writing**), or `null`. For a
 * person, `writes` is their accepted owners for writing; for an agent, its
 * own person.
 */
export function highestWritable({
  keyring,
  spaceId,
  shareId,
  writes,
}: {
  keyring: FolderKeyring;
  spaceId: SpaceId;
  shareId: ShareId;
  writes: WritesOwner;
}): HeldKeyVersion | null {
  return keyring.versions(spaceId, shareId).find((held) => writes(held.sealer)) ?? null;
}

/**
 * Raise the share's mark to the highest version opened that counts for
 * writing. Call it whenever new folder keys are opened, so the mark holds
 * even for versions this client never writes under.
 */
export function markOpened(args: {
  keyring: FolderKeyring;
  marks: KeyVersionMarks;
  spaceId: SpaceId;
  shareId: ShareId;
  writes: WritesOwner;
}): void {
  const held = highestWritable(args);
  if (held) args.marks.raise(args.spaceId, args.shareId, held.keyVersion);
}

/**
 * Refuse, as `key-version`, a version below the share's mark: the server's
 * current version, or one to write under, rotate from or move into. It
 * means the server is hiding a newer version, and is a possible attack.
 * Anything but a positive whole number is `malformed`, so a missing or
 * garbled version can't slip past the comparison.
 */
export function requireNotBehind({
  marks,
  spaceId,
  shareId,
  keyVersion,
}: {
  marks: KeyVersionMarks;
  spaceId: SpaceId;
  shareId: ShareId;
  keyVersion: number;
}): void {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new CryptoError('malformed', `${String(keyVersion)} is not a key version`);
  }
  const mark = marks.get(spaceId, shareId);
  if (keyVersion < mark) {
    throw new CryptoError(
      'key-version',
      `Version ${keyVersion} of share ${shareId} is older than version ${mark}, which this app has opened`,
    );
  }
}

/**
 * The key version to wrap a new record under in a share (section 6.8): the
 * highest one held whose envelope was sealed by an owner `writes` accepts.
 * Refuses as `key-version` when the server's `currentKeyVersion`, or that
 * version, is below the No going back mark, and as `missing-key` when no
 * version counts for writing. A server current version above it is not
 * refused here: the server answers the write with `key-version`, and the
 * client fetches its new envelopes and wraps the same content key again.
 */
export function writeKeyVersion(args: {
  keyring: FolderKeyring;
  marks: KeyVersionMarks;
  spaceId: SpaceId;
  shareId: ShareId;
  writes: WritesOwner;
  currentKeyVersion: number;
}): HeldKeyVersion {
  const { marks, spaceId, shareId, currentKeyVersion } = args;
  const held = highestWritable(args);
  if (!held) {
    throw new CryptoError('missing-key', `No key version of share ${shareId} counts for writing`);
  }
  marks.raise(spaceId, shareId, held.keyVersion);
  requireNotBehind({ marks, spaceId, shareId, keyVersion: currentKeyVersion });
  requireNotBehind({ marks, spaceId, shareId, keyVersion: held.keyVersion });
  return held;
}
