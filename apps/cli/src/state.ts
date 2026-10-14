// What the CLI keeps between runs (protocol section 9.3): its person's
// contacts mark, its No going back marks (section 6.8) and its own
// first-seen pins (section 8.3). The file sits beside the key file, mode
// 600, encrypted and authenticated under a key only the key file holds, so
// a changed file fails to open instead of lowering a mark.
import {
  aeadDecrypt,
  aeadEncrypt,
  canonical,
  CryptoError,
  parseJson,
  Sealed,
  utf8,
  type AgentPins,
  type ContactsChange,
  type ContactsMark,
  type KeyVersionMarks,
} from '@wikistow/client';
import { AgentId as AgentIdSchema, type ShareId, type SpaceId } from '@wikistow/contracts';
import { z } from 'zod';
import { CliError } from './exit.ts';
import { readPrivateFile, withFileLock, writePrivateFile } from './files.ts';

type AgentId = z.infer<typeof AgentIdSchema>;

const StateFile = z.strictObject({ format: z.literal(1), agentId: AgentIdSchema, sealed: Sealed });

const Contents = z.strictObject({
  contactsMark: z.strictObject({ version: z.number().int(), contactsHash: z.string() }).nullable(),
  marks: z.record(z.string(), z.number().int().positive()),
  // Changes this CLI made itself, written only after the library made them.
  pins: z.array(z.custom<ContactsChange>((value) => typeof value === 'object' && value !== null)),
});
type Contents = z.infer<typeof Contents>;

const stateAd = (agentId: string) => canonical('cli-state/v1', [agentId]);

/**
 * The local state, held in memory and written back whole on every change.
 * Raising a mark writes before `raise` returns, as `KeyVersionMarks`
 * requires: the library raises it synchronously and counts on it from
 * then on, and the process may exit at any moment after.
 */
export class LocalState implements KeyVersionMarks, AgentPins {
  readonly #path: string;
  readonly #key: Uint8Array;
  readonly #agentId: AgentId;
  #contents: Contents;

  private constructor(path: string, key: Uint8Array, agentId: AgentId, contents: Contents) {
    this.#path = path;
    this.#key = key;
    this.#agentId = agentId;
    this.#contents = contents;
  }

  /**
   * A fresh state for a newly enrolled agent, written at once over whatever
   * is at `path`: nothing there can be this new agent's.
   */
  static create(path: string, key: Uint8Array, agentId: AgentId): LocalState {
    const state = new LocalState(path, key, agentId, { contactsMark: null, marks: {}, pins: [] });
    state.#write({ fresh: true });
    return state;
  }

  /**
   * The state at `path`. A missing, changed or unreadable file is refused:
   * starting over would forget every mark, which is what a server hiding a
   * newer key version would want.
   */
  static open(path: string, key: Uint8Array, agentId: AgentId): LocalState {
    const contents = LocalState.#read(path, key, agentId);
    if (!contents) {
      throw new CliError('state-unreadable', `The local state file ${path} is missing`);
    }
    return new LocalState(path, key, agentId, contents);
  }

  static #read(path: string, key: Uint8Array, agentId: AgentId): Contents | null {
    const bytes = readPrivateFile(path);
    if (!bytes) return null;
    try {
      const file = parseJson(StateFile, bytes, 'Local state');
      if (file.agentId !== agentId) {
        throw new CryptoError('binding-mismatch', 'Another agent’s state');
      }
      const plain = aeadDecrypt({ key, sealed: file.sealed, ad: stateAd(agentId) });
      return parseJson(Contents, plain, 'Local state', {
        integers: [
          ['contactsMark', 'version'],
          ['marks', '*'],
        ],
      });
    } catch (cause) {
      throw new CliError(
        'state-unreadable',
        `The local state file ${path} does not open; it may have been changed`,
        { cause },
      );
    }
  }

  // Another run of the CLI may have written the file since this one read
  // it. Take in what it kept, so neither lowers the other's marks: the
  // higher of each mark, the later contacts mark, every pin once.
  #merge(disk: Contents): void {
    const marks = { ...disk.marks };
    for (const [share, version] of Object.entries(this.#contents.marks)) {
      marks[share] = Math.max(marks[share] ?? 0, version);
    }
    const mine = this.#contents.contactsMark;
    const theirs = disk.contactsMark;
    const contactsMark = !theirs || (mine && mine.version >= theirs.version) ? mine : theirs;
    const seen = new Set(disk.pins.map((pin) => JSON.stringify(pin)));
    const pins = [
      ...disk.pins,
      ...this.#contents.pins.filter((pin) => !seen.has(JSON.stringify(pin))),
    ];
    this.#contents = { contactsMark, marks, pins };
  }

  // Under the lock, so no run's write lands between this one's read and its rename.
  #write({ fresh = false } = {}): void {
    withFileLock(`${this.#path}.lock`, () => {
      const disk = fresh ? null : LocalState.#read(this.#path, this.#key, this.#agentId);
      if (disk) this.#merge(disk);
      const sealed = aeadEncrypt({
        key: this.#key,
        plaintext: utf8(JSON.stringify(this.#contents)),
        ad: stateAd(this.#agentId),
      });
      const file = { format: 1, agentId: this.#agentId, sealed } satisfies z.input<
        typeof StateFile
      >;
      writePrivateFile(this.#path, utf8(`${JSON.stringify(file)}\n`));
    });
  }

  get contactsMark(): ContactsMark | null {
    return this.#contents.contactsMark;
  }

  /** Keep the mark the session accepted, for the next run (`agentContactsMark`). */
  keepContactsMark(mark: ContactsMark | null): void {
    const before = this.#contents.contactsMark;
    if (
      mark === null ||
      (before?.version === mark.version && before.contactsHash === mark.contactsHash)
    ) {
      return;
    }
    this.#contents = { ...this.#contents, contactsMark: mark };
    this.#write();
  }

  get(spaceId: SpaceId, shareId: ShareId): number {
    return this.#contents.marks[`${spaceId} ${shareId}`] ?? 0;
  }

  raise(spaceId: SpaceId, shareId: ShareId, keyVersion: number): void {
    const key = `${spaceId} ${shareId}`;
    if (keyVersion <= (this.#contents.marks[key] ?? 0)) return;
    this.#contents = { ...this.#contents, marks: { ...this.#contents.marks, [key]: keyVersion } };
    this.#write();
  }

  load(): readonly ContactsChange[] {
    return [...this.#contents.pins];
  }

  save(changes: readonly ContactsChange[]): void {
    if (changes.length === 0) return;
    this.#contents = { ...this.#contents, pins: [...this.#contents.pins, ...changes] };
    this.#write();
  }
}
