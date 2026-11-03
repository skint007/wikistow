import type { InstallationId, ShareId, SpaceId } from '@wikistow/contracts';
import { z } from 'zod';
import type { ContactsMark } from './contacts.ts';
import { openOnDevice, sealOnDevice } from './device-seal.ts';
import { canonical, parseJson, utf8 } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';
import type { KeyVersionMarks } from './key-versions.ts';

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
}

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
  ) {
    this.#file = file;
    this.#seal = seal;
    this.#open = open;
    this.#contents = contents;
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
    return new KeptMarks(file, { seal, open }, contents);
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
    const key = `${spaceId} ${shareId}`;
    if (keyVersion <= (this.#contents.marks[key] ?? 0)) return;
    this.#change({ ...this.#contents, marks: { ...this.#contents.marks, [key]: keyVersion } });
  }

  /**
   * Stop writing, when the session ends: the next session reads the file
   * afresh, and after a sign-out there must be nothing to write it back.
   */
  close(): void {
    this.#closed = true;
  }

  // Failing to keep a change only means the next launch doesn't know it.
  #change(contents: Contents): void {
    this.#contents = contents;
    const write = async () => {
      if (this.#closed) return;
      const file = this.#file;
      if (!file.exclusive) return file.write(this.#seal(this.#contents));
      await file.exclusive(async () => {
        const disk = this.#open(await file.read().catch(() => null));
        if (disk) this.#contents = merged(this.#contents, disk);
        if (!this.#closed) await file.write(this.#seal(this.#contents));
      });
    };
    this.#writing = this.#writing.then(write).catch(() => {});
  }
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
  return {
    contactsMark: contacts.contactsMark,
    contactsRecord: contacts.contactsRecord,
    marks,
    restoredAt: disk.restoredAt,
  };
}
