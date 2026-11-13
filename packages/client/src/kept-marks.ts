import type { InstallationId, ShareId, SpaceId } from '@wikistow/contracts';
import { z } from 'zod';
import type { ContactsMark } from './contacts.ts';
import { openOnDevice, sealOnDevice } from './device-seal.ts';
import { canonical, parseJson, utf8 } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';
import { newId } from './ids.ts';
import type { KeyVersionMarks, MarkRaise, NewChange, PendingChange } from './key-versions.ts';

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

const Pending = z.strictObject({
  id: z.string().min(1).max(64),
  spaceId: z.string(),
  shareId: z.string(),
  change: z.enum(['rotation', 'ending', 'move']),
  fromKeyVersion: z.number().int().positive(),
  at: z.number().int().nonnegative(),
  lost: z.boolean(),
});

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
  /**
   * Changes of shares this app sent and hasn't seen answered (section 6.8),
   * and the IDs of those since cleared, newest last. None in files kept
   * before them.
   */
  pending: z.array(Pending).default([]),
  cleared: z.array(z.string()).default([]),
});
type Contents = z.infer<typeof Contents>;

const KEY = 'trust-marks-key/v1';
const marksAd = (installationId: InstallationId, identity: PrivateIdentity) =>
  canonical('trust-marks/v1', [installationId, identity.public.id]);

const NONE: Contents = {
  contactsMark: null,
  contactsRecord: null,
  marks: {},
  restoredAt: null,
  pending: [],
  cleared: [],
};

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
  ) {
    this.#file = file;
    this.#seal = seal;
    this.#open = open;
    this.#contents = contents;
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
            ['pending', '*', 'fromKeyVersion'],
            ['pending', '*', 'at'],
          ],
        });
      } catch {
        // As if nothing was kept.
        return null;
      }
    };
    const seal = (kept: Contents) => sealOnDevice(identity, KEY, ad, utf8(JSON.stringify(kept)));
    const contents = open(await file.read().catch(() => null)) ?? NONE;
    return new KeptMarks(file, { seal, open }, contents, file.channel ?? null);
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
    this.#change({ ...NONE, restoredAt });
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
    this.#change({ ...this.#contents, contactsMark: mark, contactsRecord: record });
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
    return this.#contents.pending as PendingChange[];
  }

  /**
   * Record `changes` as pending (section 6.8), and once the file holds
   * them, tell the other tabs, which read it again and stop sending in
   * those shares' live sessions. Only then is a change sent.
   */
  async begin(changes: readonly NewChange[]): Promise<readonly PendingChange[]> {
    const at = Date.now();
    const begun = changes.map((change) => ({ ...change, id: newId(z.string()), at, lost: false }));
    await this.#change({ ...this.#contents, pending: [...this.#contents.pending, ...begun] });
    return begun;
  }

  /**
   * A definite answer to pending changes: raise `raises`, the marks of
   * those the server accepted, then clear them all for good.
   */
  async settle(ids: readonly string[], raises: readonly MarkRaise[]): Promise<void> {
    const gone = new Set(ids);
    await this.#change({
      ...this.#contents,
      marks: raised(this.#contents.marks, raises),
      pending: this.#contents.pending.filter((change) => !gone.has(change.id)),
      cleared: [...this.#contents.cleared, ...ids].slice(-MAX_CLEARED),
    });
  }

  /** The answer to pending changes was lost: a fetch of their shares settles them. */
  async lose(ids: readonly string[]): Promise<void> {
    const lost = new Set(ids);
    await this.#change({
      ...this.#contents,
      pending: this.#contents.pending.map((c) => (lost.has(c.id) ? { ...c, lost: true } : c)),
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
      const before = JSON.stringify(this.#contents);
      this.#contents = merged(this.#contents, disk);
      if (JSON.stringify(this.#contents) !== before)
        for (const listener of this.#listeners) listener();
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
  // tab's other writes, then tell the other tabs. Failing to keep a change
  // only means the next launch doesn't know it, so the returned promise
  // never rejects.
  #change(contents: Contents): Promise<void> {
    this.#contents = contents;
    const write = async () => {
      if (this.#closed) return;
      const file = this.#file;
      if (!file.exclusive) await file.write(this.#seal(this.#contents));
      else {
        await file.exclusive(async () => {
          const disk = this.#open(await file.read().catch(() => null));
          if (disk) this.#contents = merged(this.#contents, disk);
          if (!this.#closed) await file.write(this.#seal(this.#contents));
        });
      }
      if (!this.#closed) this.#channel?.post();
    };
    this.#writing = this.#writing.then(write).catch(() => {});
    return this.#writing;
  }
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
  if (restored(disk) !== restored(mine)) return restored(disk) > restored(mine) ? disk : mine;
  const marks = { ...disk.marks };
  for (const [share, version] of Object.entries(mine.marks)) {
    marks[share] = Math.max(marks[share] ?? 0, version);
  }
  const theirs = disk.contactsMark;
  const later = !theirs || (mine.contactsMark && mine.contactsMark.version >= theirs.version);
  const contacts = later ? mine : disk;
  // A change either cleared stays cleared; one either recorded stays until then.
  const cleared = [...new Set([...disk.cleared, ...mine.cleared])].slice(-MAX_CLEARED);
  const gone = new Set([...disk.cleared, ...mine.cleared]);
  const pending = [...disk.pending];
  for (const change of mine.pending) {
    const at = pending.findIndex((other) => other.id === change.id);
    if (at < 0) pending.push(change);
    else if (change.lost) pending[at] = { ...change, lost: true };
  }
  return {
    contactsMark: contacts.contactsMark,
    contactsRecord: contacts.contactsRecord,
    marks,
    restoredAt: disk.restoredAt,
    pending: pending.filter((change) => !gone.has(change.id)),
    cleared,
  };
}
