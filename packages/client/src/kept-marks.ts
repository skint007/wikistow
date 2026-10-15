import type { InstallationId, ShareId, SpaceId } from '@wikistow/contracts';
import { z } from 'zod';
import type { ContactsMark } from './contacts.ts';
import { openOnDevice, sealOnDevice } from './device-seal.ts';
import { canonical, parseJson, utf8 } from './encoding.ts';
import type { PrivateIdentity } from './identity.ts';
import type { KeyVersionMarks } from './key-versions.ts';

/**
 * Where a device keeps sealed bytes between sessions: the desktop app's
 * bridge, which holds them in a file it can't read.
 */
export interface KeptFile {
  read(): Promise<Uint8Array | null>;
  write(sealed: Uint8Array): Promise<void>;
}

const Contents = z.strictObject({
  contactsMark: z.strictObject({ version: z.number().int(), contactsHash: z.string() }).nullable(),
  marks: z.record(z.string(), z.number().int().positive()),
  restoredAt: z.iso.datetime().nullable(),
});
type Contents = z.infer<typeof Contents>;

const KEY = 'trust-marks-key/v1';
const marksAd = (installationId: InstallationId, identity: PrivateIdentity) =>
  canonical('trust-marks/v1', [installationId, identity.public.id]);

/**
 * What the desktop app keeps between launches with a trusted keyring (#3),
 * as the CLI does in its local state: the contacts mark (section 8.5), the No going back marks
 * (section 6.8), and the `restoredAt` of the server's last restore it has
 * seen (`unseenRestore`). Held in memory and written back whole, sealed for
 * this person on this server (`sealOnDevice`), on every change. Writes go
 * out in order but aren't waited for, so a change made just before the app
 * quits may not be kept.
 */
export class KeptMarks implements KeyVersionMarks {
  readonly #file: KeptFile;
  readonly #seal: (contents: Contents) => Uint8Array;
  #contents: Contents;
  #closed = false;

  private constructor(
    file: KeptFile,
    seal: (contents: Contents) => Uint8Array,
    contents: Contents,
  ) {
    this.#file = file;
    this.#seal = seal;
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
    const sealed = await file.read().catch(() => null);
    const plain = sealed && openOnDevice(identity, KEY, ad, sealed);
    let contents: Contents = { contactsMark: null, marks: {}, restoredAt: null };
    if (plain) {
      try {
        contents = parseJson(Contents, plain, 'Kept marks', {
          integers: [
            ['contactsMark', 'version'],
            ['marks', '*'],
          ],
        });
      } catch {
        // As if nothing was kept.
      }
    }
    const seal = (kept: Contents) => sealOnDevice(identity, KEY, ad, utf8(JSON.stringify(kept)));
    return new KeptMarks(file, seal, contents);
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
    this.#change({ contactsMark: null, marks: {}, restoredAt });
  }

  get contactsMark(): ContactsMark | null {
    return this.#contents.contactsMark;
  }

  /** Keep the contacts mark the session accepted, for the next one. */
  keepContactsMark(mark: ContactsMark | null): void {
    const before = this.#contents.contactsMark;
    if (mark === null) return;
    if (before?.version === mark.version && before.contactsHash === mark.contactsHash) return;
    this.#change({ ...this.#contents, contactsMark: mark });
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
    if (!this.#closed) void this.#file.write(this.#seal(contents)).catch(() => {});
  }
}
