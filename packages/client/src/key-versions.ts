import type { ShareId, SpaceId } from '@wikistow/contracts';
import type { WritesOwner } from './owner-predicates.ts';
import { CryptoError } from './errors.ts';
import type { FolderKeyring, HeldKeyVersion } from './folder-keys.ts';

/**
 * Where a client keeps its No going back marks (section 6.8): for each
 * `(spaceId, shareId)`, the highest key version it has opened that counts for
 * writing. The CLI, the desktop app with a trusted keyring, and the browser
 * keep them between sessions, next to the contacts mark (`KeptMarks`); a
 * desktop app without one keeps them in memory, for one session.
 */
export interface KeyVersionMarks {
  /** The mark for one share, or 0 when there is none. */
  get(spaceId: SpaceId, shareId: ShareId): number;
  /** Raise the mark to `keyVersion`. A lower version leaves it where it is. */
  raise(spaceId: SpaceId, shareId: ShareId, keyVersion: number): void;
  /**
   * The changes of shares this app has sent and not yet seen answered
   * (section 6.8): while one of a share is there, nothing joins or sends in
   * that share's live sessions. Marks that keep none have none.
   */
  pending?(): readonly PendingChange[];
  /**
   * Record `changes` as pending, once that record has landed where every
   * tab and later launch reads it, and tell the other tabs.
   */
  begin?(changes: readonly NewChange[]): Promise<readonly PendingChange[]>;
  /**
   * A definite answer to pending changes: raise `raises` first, then clear
   * `ids`, for good, and tell the other tabs.
   */
  settle?(ids: readonly string[], raises: readonly MarkRaise[]): Promise<void>;
  /** The answer to pending changes was lost: they wait for the app to fetch the shares again. */
  lose?(ids: readonly string[]): Promise<void>;
  /** Pending changes are still being sent (`at` moves on). */
  renew?(ids: readonly string[]): Promise<void>;
  /** Take in what other tabs kept since: their higher marks, pending changes and clears. */
  refresh?(): Promise<void>;
}

/**
 * A change of a share that, once accepted, a live session of the share must
 * not outlast: a rotation, an owner's removal (which rotates), an ending,
 * or a move into or out of it (section 6.8).
 */
export type ShareChange = 'rotation' | 'ending' | 'move';

/** A change this app sent, from the key version it held (`fromKeyVersion`). */
export type NewChange = {
  spaceId: SpaceId;
  shareId: ShareId;
  change: ShareChange;
  fromKeyVersion: number;
};
export type PendingChange = Omit<NewChange, 'change'> & {
  /** A kind this app knows, or one a newer app recorded, which holds sessions all the same. */
  change: ShareChange | (string & {});
  id: string;
  /** When it was begun, or last renewed while it is sent, in milliseconds since the epoch. */
  at: number;
  /** Whether its answer was lost, so a fetch of the shares settles it. */
  lost: boolean;
  /** When its answer was lost. */
  lostAt: number | null;
};

/** How often a change being sent is renewed. */
export const RENEW_MS = 30_000;

/**
 * How long after a lost answer a fetch may settle a change: the server may
 * still be committing the request whose answer was lost.
 */
export const LOST_GRACE_MS = 30_000;

/**
 * How long a change may be sent for before a fetch of its shares settles it
 * as if its answer was lost, as when the tab sending it closed mid-send.
 */
export const SEND_LIMIT_MS = 120_000;

/** A mark to raise when a change is accepted: the new key version, or `ENDED`. */
export type MarkRaise = { spaceId: SpaceId; shareId: ShareId; keyVersion: number };

/** Whether a change of this share is pending, so its live sessions take nothing in or out. */
export const changePending = (marks: KeyVersionMarks, spaceId: SpaceId, shareId: ShareId) =>
  (marks.pending?.() ?? []).some((c) => c.spaceId === spaceId && c.shareId === shareId);

/**
 * The mark of a share this app ended (section 6.9): above every key
 * version, so nothing is written under it again, and stored as a plain
 * positive number, which older apps keep and compare like any other mark.
 */
export const ENDED = Number.MAX_SAFE_INTEGER;

/** Marks kept in memory, for one session: a desktop app's without a trusted keyring, and tests'. */
export class MemoryKeyVersionMarks implements KeyVersionMarks {
  readonly #marks = new Map<string, number>();
  #pending: PendingChange[] = [];
  #next = 0;

  get(spaceId: SpaceId, shareId: ShareId): number {
    return this.#marks.get(`${spaceId} ${shareId}`) ?? 0;
  }

  raise(spaceId: SpaceId, shareId: ShareId, keyVersion: number): void {
    const key = `${spaceId} ${shareId}`;
    this.#marks.set(key, Math.max(this.#marks.get(key) ?? 0, keyVersion));
  }

  pending(): readonly PendingChange[] {
    return this.#pending;
  }

  begin(changes: readonly NewChange[]): Promise<readonly PendingChange[]> {
    const begun = changes.map((change) => ({
      ...change,
      id: `change-${++this.#next}`,
      at: Date.now(),
      lost: false,
      lostAt: null,
    }));
    this.#pending = [...this.#pending, ...begun];
    return Promise.resolve(begun);
  }

  settle(ids: readonly string[], raises: readonly MarkRaise[]): Promise<void> {
    for (const { spaceId, shareId, keyVersion } of raises) this.raise(spaceId, shareId, keyVersion);
    this.#pending = this.#pending.filter((change) => !ids.includes(change.id));
    return Promise.resolve();
  }

  lose(ids: readonly string[]): Promise<void> {
    const now = Date.now();
    this.#pending = this.#pending.map((c) =>
      ids.includes(c.id) ? { ...c, lost: true, lostAt: now } : c,
    );
    return Promise.resolve();
  }

  renew(ids: readonly string[]): Promise<void> {
    const now = Date.now();
    this.#pending = this.#pending.map((c) => (ids.includes(c.id) ? { ...c, at: now } : c));
    return Promise.resolve();
  }

  refresh(): Promise<void> {
    return Promise.resolve();
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
  if (mark === ENDED) {
    throw new CryptoError(
      'key-version',
      `This app ended share ${shareId}, but the server still lists it`,
    );
  }
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
