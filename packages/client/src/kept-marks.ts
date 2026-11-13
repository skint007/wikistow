import type { InstallationId, ShareId, SpaceId } from '@wikistow/contracts';
import { z } from 'zod';
import type { ContactsMark } from './contacts.ts';
import { openOnDevice, sealOnDevice } from './device-seal.ts';
import { canonical, parseJson, utf8 } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';
import { newId } from './ids.ts';
import {
  requireCurrentPlan,
  type KeyVersionMarks,
  type MarkRaise,
  type NewChange,
  type PendingChange,
} from './key-versions.ts';

/**
 * Where a device keeps sealed bytes between sessions: the desktop app's
 * bridge, which holds them in a file it can't read, or the browser's
 * IndexedDB, which its tabs share. With `exclusive`, each write reads the
 * file again and takes in what another user of it (a tab) kept meanwhile,
 * with no other write landing in between.
 */
export interface KeptFile {
  read(): Promise<Uint8Array | null>;
  write(sealed: Uint8Array): Promise<void>;
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
  /** For a file several tabs share: how each tells the others it wrote it. */
  channel?: MarksChannel;
}

/**
 * How the tabs of one browser tell each other that one of them changed the
 * kept marks, once its write has landed: a `BroadcastChannel` carrying no
 * text, only that something changed. The others read the file again.
 */
export interface MarksChannel {
  post(): void;
  /** Call `listener` on each other tab's post; returns a function that stops it. */
  listen(listener: () => void): () => void;
}

// Pending changes of shares (section 6.8) are kept among the marks, under
// keys no `spaceId shareId` pair can make (IDs never hold `~`), so an app
// from before them, which reads the file strictly and keeps every mark it
// finds, still opens it and carries them forward:
//
//   `~change <id> <spaceId> <shareId> <change> <fromKeyVersion>` → when begun or last renewed
//   `~lost <id>` → when its answer was lost
//   `~cleared <id>` → when it was cleared, for good
const CHANGE = '~change';
const LOST = '~lost';
const CLEARED = '~cleared';
// A change's kind: one this app knows, or one a newer app recorded, which
// holds the share's sessions all the same.
const KIND = /^[a-z][a-z-]{0,31}$/;

// The newest clears kept, so a tab that hasn't read a clear yet can't put
// its change back, and the file stays small.
const MAX_CLEARED = 256;

const Contents = z.strictObject({
  contactsMark: z.strictObject({ version: z.number().int(), contactsHash: z.string() }).nullable(),
  /**
   * The record the contacts mark was taken from, sealed, as JSON, for a
   * session opened offline (ADR 0009, decision 5). Null in files kept
   * before it, and when the person has no record yet.
   */
  contactsRecord: z.string().nullable().default(null),
  marks: z.record(z.string(), z.number().int().positive()),
  restoredAt: z.iso.datetime().nullable(),
});
type Contents = z.infer<typeof Contents>;

const KEY = 'trust-marks-key/v1';
const marksAd = (installationId: InstallationId, identity: PrivateIdentity) =>
  canonical('trust-marks/v1', [installationId, identity.public.id]);

const NONE: Contents = { contactsMark: null, contactsRecord: null, marks: {}, restoredAt: null };

/**
 * What a device keeps between sessions, as the CLI does in its local state:
 * the contacts mark with its record (section 8.5), the No going back marks
 * (section 6.8), and the `restoredAt` of the server's last restore it has
 * seen (`unseenRestore`). The desktop app keeps them with a trusted keyring
 * (#3), a browser in IndexedDB (ADR 0009, decision 2). Held in memory and
 * written back whole, sealed for this person on this server
 * (`sealOnDevice`), on every change. Writes go out in order but aren't
 * waited for, so a change made just before the app quits may not be kept.
 */
export class KeptMarks implements KeyVersionMarks {
  readonly #file: KeptFile;
  readonly #seal: (contents: Contents) => Uint8Array;
  readonly #open: (sealed: Uint8Array | null) => Contents | null;
  readonly #channel: MarksChannel | null;
  readonly #listeners = new Set<() => void>();
  readonly #unlisten: () => void;
  #contents: Contents;
  // This person on this server, for answers kept past a close.
  readonly #who: string;
  // The marks as this tab's listeners last heard of them.
  #announced = '';
  #writing: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    file: KeptFile,
    {
      seal,
      open,
    }: {
      seal: (contents: Contents) => Uint8Array;
      open: (sealed: Uint8Array | null) => Contents | null;
    },
    contents: Contents,
    channel: MarksChannel | null,
    who: string,
  ) {
    this.#who = who;
    this.#file = file;
    this.#seal = seal;
    this.#open = open;
    this.#contents = contents;
    this.#announced = JSON.stringify(contents.marks);
    this.#channel = channel;
    this.#unlisten = channel?.listen(() => void this.refresh()) ?? (() => {});
  }

  /**
   * The marks kept in `file` for this person on this server. A file that is
   * missing, or doesn't open (damaged, or sealed for another account or
   * server), starts with none, the same as a first launch. Refusing it, as
   * the CLI does, would leave the person no way back in short of signing
   * out, which deletes it anyway.
   */
  static async open(
    file: KeptFile,
    { identity, installationId }: { identity: PrivateIdentity; installationId: InstallationId },
  ): Promise<KeptMarks> {
    const ad = marksAd(installationId, identity);
    const open = (sealed: Uint8Array | null): Contents | null => {
      const plain = sealed && openOnDevice(identity, KEY, ad, sealed);
      if (!plain) return null;
      try {
        return parseJson(Contents, plain, 'Kept marks', {
          integers: [
            ['contactsMark', 'version'],
            ['marks', '*'],
          ],
        });
      } catch {
        // As if nothing was kept.
        return null;
      }
    };
    const seal = (kept: Contents) => sealOnDevice(identity, KEY, ad, utf8(JSON.stringify(kept)));
    const contents = open(await file.read().catch(() => null)) ?? NONE;
    const who = `${installationId} ${identity.public.id}`;
    const marks = new KeptMarks(file, { seal, open }, contents, file.channel ?? null, who);
    // Answers a closed session of this person heard after it closed. A
    // restore that session didn't know of drops its raises, as it drops
    // every mark (`startOver`); its clears and losses still hold. The
    // answer stays kept until it has landed in the file.
    const kept = late.get(who);
    if (kept) {
      const answers = kept.restoredAt === contents.restoredAt ? kept.marks : ownChanges(kept.marks);
      void marks.#change(
        { ...marks.#contents, marks: tidied(merge(marks.#contents.marks, answers)) },
        { strict: true },
      ).then(
        () => {
          if (late.get(who) === kept) late.delete(who);
        },
        () => {},
      );
    }
    return marks;
  }

  /** The `restoredAt` of the last restore these marks were taken after, or null. */
  get restoredAt(): string | null {
    return this.#contents.restoredAt;
  }

  /**
   * After a restore they hadn't seen (`unseenRestore`): forget the contacts
   * mark and the No going back marks, which describe the server before it.
   */
  startOver(restoredAt: string): void {
    // Changes still being sent stay pending: their answers are the server's now.
    void this.#change({ ...NONE, marks: ownChanges(this.#contents.marks), restoredAt });
  }

  get contactsMark(): ContactsMark | null {
    return this.#contents.contactsMark;
  }

  /** The sealed record the contacts mark was taken from, as kept, or null. */
  get contactsRecord(): unknown {
    const kept = this.#contents.contactsRecord;
    if (kept === null) return null;
    try {
      return JSON.parse(kept);
    } catch {
      return null;
    }
  }

  /** Keep the contacts mark the session accepted, with its record, for the next one. */
  keepContacts({ mark, sealed }: { mark: ContactsMark | null; sealed: unknown }): void {
    const before = this.#contents.contactsMark;
    if (mark === null || sealed === null) return;
    const record = JSON.stringify(sealed);
    if (
      before?.version === mark.version &&
      before.contactsHash === mark.contactsHash &&
      this.#contents.contactsRecord === record
    )
      return;
    void this.#change({ ...this.#contents, contactsMark: mark, contactsRecord: record });
  }

  get(spaceId: SpaceId, shareId: ShareId): number {
    return this.#contents.marks[`${spaceId} ${shareId}`] ?? 0;
  }

  raise(spaceId: SpaceId, shareId: ShareId, keyVersion: number): void {
    const marks = raised(this.#contents.marks, [{ spaceId, shareId, keyVersion }]);
    if (marks === this.#contents.marks) return;
    void this.#change({ ...this.#contents, marks });
  }

  pending(): readonly PendingChange[] {
    // Once closed, as at sign-out, nothing is pending for this session.
    return this.#closed ? [] : pendingIn(this.#contents.marks);
  }

  /**
   * Record `changes` as pending (section 6.8), and once the file holds
   * them, tell the other tabs, which read it again and stop sending in
   * those shares' live sessions. Only then may a change be sent: if the
   * file can't be written, this throws, and nothing is sent.
   */
  async begin(changes: readonly NewChange[]): Promise<readonly PendingChange[]> {
    if (changes.length === 0) return [];
    if (this.#closed) throw new Error('The session has ended; its marks are closed');
    // Let writes queued before land first, so none of them carries this
    // change to the file before its own write, which may fail.
    await this.#writing;
    if (this.#closed) throw new Error('The session has ended; its marks are closed');
    const at = Date.now();
    const begun = changes.map((change): PendingChange => ({
      ...change,
      id: newId(z.string()),
      at,
      lost: false,
      lostAt: null,
    }));
    try {
      // Taken in only as its own write runs, so no write queued before it
      // carries it; and checked again against what other tabs kept, under
      // the file's lock: never record a change from a version behind a mark.
      await this.#change(this.#contents, {
        strict: true,
        apply: (contents) => {
          const marks = { ...contents.marks };
          for (const change of begun) marks[changeKey(change)] = at;
          return { ...contents, marks };
        },
        check: () => this.#notBehind(changes),
      });
    } catch (error) {
      // Never sent, so never pending: no later write may keep it.
      const unsent = new Set(begun.map(changeKey));
      const kept: Contents['marks'] = {};
      for (const [key, value] of Object.entries(this.#contents.marks)) {
        if (!unsent.has(key)) {
          Object.defineProperty(kept, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      this.#contents = { ...this.#contents, marks: kept };
      this.#notify();
      throw error;
    }
    return begun;
  }

  /** Renew pending changes still being sent, so no fetch settles them as gone silent. */
  async renew(ids: readonly string[]): Promise<void> {
    const now = Date.now();
    const marks = { ...this.#contents.marks };
    for (const change of pendingIn(marks))
      if (ids.includes(change.id)) marks[changeKey(change)] = now;
    await this.#change({ ...this.#contents, marks });
  }

  /**
   * A definite answer to pending changes: raise `raises`, the marks of
   * those the server accepted, then clear them all for good.
   */
  async settle(ids: readonly string[], raises: readonly MarkRaise[]): Promise<void> {
    const now = Date.now();
    const answer: Contents['marks'] = raised({}, raises);
    for (const id of ids) answer[`${CLEARED} ${id}`] = now;
    if (this.#keepForLater(answer)) return;
    await this.#change(
      { ...this.#contents, marks: tidied(merge(this.#contents.marks, answer)) },
      { answer },
    );
  }

  /** The answer to pending changes was lost: a fetch of their shares settles them. */
  async lose(ids: readonly string[]): Promise<void> {
    const now = Date.now();
    const marks = { ...this.#contents.marks };
    for (const id of ids) marks[`${LOST} ${id}`] = now;
    const answer: Contents['marks'] = {};
    for (const id of ids) answer[`${LOST} ${id}`] = now;
    if (this.#keepForLater(answer)) return;
    await this.#change({ ...this.#contents, marks }, { answer });
  }

  // An answer to a change sent before the session closed, as when the app
  // locked meanwhile: nothing more is written from a closed session, so
  // the next session of this person on this server, in this window, takes
  // it in as it opens. Whether the closed session was signed out of or
  // locked, the answer is the server's, so it holds either way.
  #keepForLater(answer: Contents['marks']): boolean {
    if (!this.#closed) return false;
    this.#keep(answer);
    return true;
  }

  #keep(answer: Contents['marks']): void {
    const before = late.get(this.#who);
    const restoredAt = this.#contents.restoredAt;
    late.set(this.#who, {
      restoredAt,
      marks: tidied(
        merge(
          before?.restoredAt === restoredAt ? before.marks : ownChanges(before?.marks ?? {}),
          answer,
        ),
      ),
    });
  }

  /**
   * Read the file again, under its lock, and take in what other tabs kept:
   * their higher marks, pending changes and clears. A tab does this before
   * it writes under, rotates from or moves content into a share, when it
   * joins a live session, and when another tab says it changed the file.
   */
  async refresh(): Promise<void> {
    const file = this.#file;
    const read = async () => {
      const disk = this.#open(await file.read().catch(() => null));
      if (!disk) return;
      this.#contents = merged(this.#contents, disk);
      this.#notify();
    };
    await (file.exclusive ? file.exclusive(read) : read()).catch(() => {});
  }

  /** Call `listener` whenever what another tab kept changes these marks; returns a function that stops it. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Stop writing, when the session ends: the next session reads the file
   * afresh, and after a sign-out there must be nothing to write it back.
   */
  close(): void {
    this.#closed = true;
    this.#unlisten();
    this.#listeners.clear();
  }

  // Write `contents`, merged with what other tabs kept, in turn with this
  // tab's other writes, then tell the other tabs. Failing to keep a mark
  // only means the next launch doesn't know it, so the returned promise
  // rejects only when `strict`: a pending change must land before it is
  // sent.
  // Refuse changes from a version behind this share's mark, or of a share
  // this app ended (`key-version`).
  #notBehind(changes: readonly NewChange[]): void {
    for (const change of changes) requireCurrentPlan(this, change);
  }

  // Tell this tab's listeners when what it holds changed since they last
  // heard, whether a tab of its own changed it or another's write was
  // taken in, a refused or failed write of its own included.
  #notify(): void {
    const now = JSON.stringify(this.#contents.marks);
    if (now === this.#announced) return;
    this.#announced = now;
    for (const listener of this.#listeners) listener();
  }

  #change(
    contents: Contents,
    {
      strict = false,
      check,
      answer,
      apply,
    }: {
      strict?: boolean;
      check?: () => void;
      /** A change to make to the contents only when this write's turn comes. */
      apply?: (contents: Contents) => Contents;
      /** A server's answer this write carries, kept for the next session if it closed first. */
      answer?: Contents['marks'];
    } = {},
  ): Promise<void> {
    this.#contents = contents;
    const write = async () => {
      const closed = () => {
        if (answer) this.#keep(answer);
        if (strict) throw new Error('The session has ended; its marks are closed');
      };
      if (this.#closed) return closed();
      if (apply) this.#contents = apply(this.#contents);
      const file = this.#file;
      if (!file.exclusive) {
        check?.();
        await file.write(this.#seal(this.#contents));
      } else {
        await file.exclusive(async () => {
          const disk = this.#open(await file.read().catch(() => null));
          if (disk) this.#contents = merged(this.#contents, disk);
          // What it took in counts, even if this write is refused or fails.
          this.#notify();
          if (this.#closed) return closed();
          check?.();
          await file.write(this.#seal(this.#contents));
        });
      }
      // A pending change that landed is told to the other tabs before it
      // goes, even if this session closed meanwhile.
      if (!this.#closed || strict) this.#channel?.post();
      // This tab's own sessions hear of its changes as other tabs' do.
      if (!this.#closed) this.#notify();
    };
    const written = this.#writing.then(write);
    this.#writing = written.catch(() => {});
    return strict ? written : this.#writing;
  }
}

const changeKey = (
  c: Pick<PendingChange, 'id' | 'spaceId' | 'shareId' | 'change' | 'fromKeyVersion'>,
) => `${CHANGE} ${c.id} ${c.spaceId} ${c.shareId} ${c.change} ${c.fromKeyVersion}`;

// The pending changes `marks` holds, but those cleared.
function pendingIn(marks: Contents['marks']): PendingChange[] {
  const out: PendingChange[] = [];
  for (const [key, at] of Object.entries(marks)) {
    const [kind, id, spaceId, shareId, change, from, ...rest] = key.split(' ');
    if (kind !== CHANGE || rest.length > 0 || !id || !spaceId || !shareId || !change || !from)
      continue;
    const fromKeyVersion = Number(from);
    if (!KIND.test(change) || !Number.isSafeInteger(fromKeyVersion) || fromKeyVersion < 1) continue;
    if (marks[`${CLEARED} ${id}`] !== undefined) continue;
    const lostAt = marks[`${LOST} ${id}`] ?? null;
    out.push({
      id,
      spaceId: spaceId as SpaceId,
      shareId: shareId as ShareId,
      change: change as PendingChange['change'],
      fromKeyVersion,
      at,
      lost: lostAt !== null,
      lostAt,
    });
  }
  return out;
}

// Only the pending changes, losses and clears `marks` holds.
function ownChanges(marks: Contents['marks']): Contents['marks'] {
  const out: Contents['marks'] = {};
  for (const [key, value] of Object.entries(marks)) {
    if (key.startsWith('~')) {
      Object.defineProperty(out, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}

// `marks` without what cleared changes left, keeping the newest clears.
function tidied(marks: Contents['marks']): Contents['marks'] {
  const clears = Object.entries(marks)
    .filter(([key]) => key.startsWith(`${CLEARED} `))
    .sort(([, a], [, b]) => b - a);
  const kept = new Set(clears.slice(0, MAX_CLEARED).map(([key]) => key));
  const gone = new Set(clears.map(([key]) => key.slice(CLEARED.length + 1)));
  const out: Contents['marks'] = {};
  for (const [key, value] of Object.entries(marks)) {
    const [kind, id] = key.split(' ');
    if (kind === CLEARED && !kept.has(key)) continue;
    if ((kind === CHANGE || kind === LOST) && id !== undefined && gone.has(id)) continue;
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

// Answers closed sessions heard, by person and server, for their next session.
const late = new Map<string, { restoredAt: string | null; marks: Contents['marks'] }>();

// Two sets of marks taken together, the higher of each, as tabs merge them.
function merge(a: Contents['marks'], b: Contents['marks']): Contents['marks'] {
  const out: Contents['marks'] = {};
  for (const source of [a, b]) {
    for (const [key, value] of Object.entries(source)) {
      Object.defineProperty(out, key, {
        value: Math.max(out[key] ?? 0, value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}

// `marks` with each of `raises` taken in, or `marks` itself if none raises one.
function raised(marks: Contents['marks'], raises: readonly MarkRaise[]): Contents['marks'] {
  let out = marks;
  for (const { spaceId, shareId, keyVersion } of raises) {
    const key = `${spaceId} ${shareId}`;
    if (keyVersion > (out[key] ?? 0)) out = { ...out, [key]: keyVersion };
  }
  return out;
}

/**
 * What two users of one file kept, taken together, as the CLI's local state
 * does, so neither lowers the other's marks: the higher of each mark, and
 * the later contacts mark with its record. Marks from before a restore the
 * other has seen no longer count: the later restore's marks win whole.
 */
function merged(mine: Contents, disk: Contents): Contents {
  const restored = (contents: Contents) => Date.parse(contents.restoredAt ?? '') || 0;
  if (restored(disk) !== restored(mine)) {
    // The later restore's marks win whole, but for pending changes, which
    // are about the server now, and their clears.
    const [winner, loser] = restored(disk) > restored(mine) ? [disk, mine] : [mine, disk];
    return {
      ...winner,
      marks: tidied({ ...ownChanges(loser.marks), ...winner.marks }),
    };
  }
  const marks = { ...disk.marks };
  for (const [share, version] of Object.entries(mine.marks)) {
    marks[share] = Math.max(marks[share] ?? 0, version);
  }
  const theirs = disk.contactsMark;
  const later = !theirs || (mine.contactsMark && mine.contactsMark.version >= theirs.version);
  const contacts = later ? mine : disk;
  // Pending changes, losses and clears are marks too: each kept from
  // either side, and a change either cleared stays cleared.
  return {
    contactsMark: contacts.contactsMark,
    contactsRecord: contacts.contactsRecord,
    marks: tidied(marks),
    restoredAt: disk.restoredAt,
  };
}
