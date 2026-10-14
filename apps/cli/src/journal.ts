// Idempotency keys (wikistow.md, Desktop and CLI). The server answers a
// retry with the first answer only if the request is byte-identical, but
// every run of a command seals its change afresh: new IDs, nonces and
// signatures. So the first time a change goes out with a key, its exact
// bytes are journaled, and a later run with that key sends those bytes
// again instead of its own. Once the server answers, the answer is kept,
// and a later run reports it without sending anything.
//
// Each entry is sealed under a key derived from the local state's key, so
// it can't be read, or planted for the agent to send, without the key file.
import {
  aeadDecrypt,
  aeadEncrypt,
  canonical,
  hash,
  hashBytes,
  parseJson,
  Sealed,
  utf8,
  type Fetch,
} from '@wikistow/client';
import {
  IDEMPOTENCY_KEY_KEPT_MS,
  pageRoutes,
  structureRoutes,
  type RouteDef,
} from '@wikistow/contracts';
import { z } from 'zod';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from './exit.ts';
import { ensurePrivateDir, readPrivateFile, removePrivateFile, writePrivateFile } from './files.ts';

/** The journal's directory, beside the key file. */
export const JOURNAL_DIR = 'journal';

/** What the server accepts as an `Idempotency-Key`. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

/** How long the server surely keeps a key after it went out, less an hour for clocks that differ. */
const KEY_SURELY_KEPT_MS = IDEMPOTENCY_KEY_KEPT_MS - 60 * 60 * 1000;

/** The changes that take a key: making a folder or page, saving a draft, publishing. */
const KEYED: readonly RouteDef[] = [
  structureRoutes.createFolder,
  pageRoutes.createPage,
  pageRoutes.saveDraft,
  pageRoutes.publish,
];

const pattern = (route: RouteDef) =>
  new RegExp(`^${route.path.replace(/:[A-Za-z]+/g, '[A-Za-z0-9_-]+')}$`);
const KEYED_PATHS = KEYED.map((route) => ({ method: route.method, path: pattern(route) }));

const EntryFile = z.strictObject({ format: z.literal(1), sealed: Sealed });

const Entry = z.strictObject({
  method: z.string(),
  path: z.string(),
  body: z.string(),
  /** A hash of what the command was asked to do: its IDs, title and content. */
  input: z.string(),
  /** What the command noted to report on a retry, such as a file it uploaded first. */
  note: z.string().optional(),
  /** When the change first went out; entries from before this was kept have none. */
  sentAt: z.iso.datetime().optional(),
  /** The server's answer, once one came back; until then the outcome is unknown. */
  answer: z
    .strictObject({ status: z.number().int(), body: z.string(), at: z.iso.datetime() })
    .nullable(),
});
type Entry = z.infer<typeof Entry>;

/** The change a command sent, and the server's answer to it. */
export type Sent = { path: string; answer: unknown };

const otherInput = () =>
  new CliError(
    'journal-mismatch',
    'That idempotency key was used for this change with other input (another file, ' +
      'title or revision). Run it again exactly as the first time, or use a new key',
  );

/** A hash of a change command's input, for `Journal`'s `input`. */
export const inputHash = (command: string, fields: readonly (string | Uint8Array | null)[]) =>
  hash(canonical('cli-journal-input/v1', [command, ...fields]));

/**
 * A `fetch` that sends the change with `key` the way the journal says to,
 * and remembers the answer, so a command can report from it. With no key,
 * nothing is journaled, but the answer is still kept in `sent`.
 */
export class Journal {
  readonly #dir: string;
  readonly #key: string | null;
  readonly #input: string;
  readonly #sealKey: Uint8Array;
  readonly #ad: (name: string) => Uint8Array;
  readonly #name: string;
  readonly #now: () => Date;
  #attempted = false;
  #sent: Sent | null = null;
  #note: string | undefined;
  #inconclusive = false;

  constructor({
    dir,
    agentId,
    server,
    stateKey,
    key,
    input = '',
    now = () => new Date(),
  }: {
    dir: string;
    agentId: string;
    server: string;
    stateKey: Uint8Array;
    key: string | null;
    /** What this run was asked to do (`inputHash`): a retry must ask the same. */
    input?: string;
    now?: () => Date;
  }) {
    if (key !== null && !IDEMPOTENCY_KEY.test(key)) {
      throw new CliError('usage', 'An idempotency key is 1 to 200 letters, digits or _.:-');
    }
    this.#dir = join(dir, JOURNAL_DIR);
    this.#key = key;
    this.#input = input;
    this.#now = now;
    this.#sealKey = hashBytes(canonical('cli-journal-key/v1', [stateKey]));
    this.#ad = (name) => canonical('cli-journal-entry/v1', [agentId, server, name]);
    // The key names the file only through a keyed hash: it may be `..`, and
    // nobody without the key file can tell which keys were used.
    this.#name =
      key === null ? '' : `${hash(canonical('cli-journal/v1', [this.#sealKey, key]))}.json`;
  }

  /** The answer to the change, once the server accepted it. */
  get sent(): Sent | null {
    return this.#sent;
  }

  /** Whether the change went out, whatever came back. */
  get attempted(): boolean {
    return this.#attempted;
  }

  /**
   * Whether this run's key already has a change journaled: then that
   * change, not this run's, is what goes out, so checks of this run's
   * own request against the page's heads don't apply.
   */
  get replaying(): boolean {
    return this.#key !== null && this.#read(this.#name) !== null;
  }

  /**
   * What the change journaled under this run's key noted when it first went
   * out (`setNote`), or null with none journaled. A retry reports from it
   * what it can't learn again, such as which file the first run uploaded.
   */
  get note(): string | null {
    if (this.#key === null) return null;
    const entry = this.#read(this.#name);
    if (!entry) return null;
    if (entry.input !== this.#input) throw otherInput();
    return entry.note ?? null;
  }

  /**
   * Whether the change was refused in a way that doesn't show it wasn't
   * made: resent after the server stopped keeping its key, and refused for
   * any reason. The first run's change may have landed and be what's in the
   * way (the draft moved on, access changed since), so its entry stays.
   */
  get inconclusive(): boolean {
    return this.#inconclusive;
  }

  /** Journal `note` with this run's change, for a retry to report; set before the change goes out. */
  setNote(note: string): void {
    this.#note = note;
  }

  #read(name: string): Entry | null {
    if (!existsSync(this.#dir)) return null;
    const bytes = readPrivateFile(join(this.#dir, name));
    if (!bytes) return null;
    try {
      const { sealed } = parseJson(EntryFile, bytes, 'Journal entry');
      const plain = aeadDecrypt({ key: this.#sealKey, sealed, ad: this.#ad(name) });
      return parseJson(Entry, plain, 'Journal entry', {
        integers: [['answer', 'status']],
      });
    } catch (cause) {
      throw new CliError(
        'state-unreadable',
        'A journal entry does not open; it may have been changed',
        {
          cause,
        },
      );
    }
  }

  #write(entry: Entry): void {
    ensurePrivateDir(this.#dir);
    const sealed = aeadEncrypt({
      key: this.#sealKey,
      plaintext: utf8(JSON.stringify(entry)),
      ad: this.#ad(this.#name),
    });
    writePrivateFile(join(this.#dir, this.#name), utf8(JSON.stringify({ format: 1, sealed })));
  }

  /**
   * Remove answers kept longer than the server keeps their keys. Entries
   * still waiting for an answer stay: each is the only record of a change
   * that may have been made, and holds only its own key.
   */
  #prune(): void {
    if (!existsSync(this.#dir)) return;
    const before = this.#now().getTime() - IDEMPOTENCY_KEY_KEPT_MS;
    for (const name of readdirSync(this.#dir)) {
      if (!/^[A-Za-z0-9_-]{43}\.json$/.test(name)) continue;
      let entry: Entry | null;
      try {
        entry = this.#read(name);
      } catch {
        continue; // Left alone; it is refused if its key is ever used.
      }
      if (entry?.answer && Date.parse(entry.answer.at) < before) {
        removePrivateFile(join(this.#dir, name));
      }
    }
  }

  /** Wrap `send` so changes that take a key go out through the journal. */
  fetch(send: Fetch): Fetch {
    return async (url, init) => {
      const method = init.method ?? 'GET';
      const path = new URL(url).pathname;
      const keyed = KEYED_PATHS.some((k) => k.method === method && k.path.test(path));
      if (!keyed) return send(url, init);
      // A refused change may be sealed again and resent (a new key version,
      // say), but once one is accepted, nothing else may follow it.
      if (this.#sent) {
        throw new CliError('failed', 'One command sends one change; this one tried a second');
      }
      if (this.#key === null) {
        this.#attempted = true;
        return this.#keep(path, await send(url, init));
      }
      const body = typeof init.body === 'string' ? init.body : null;
      if (body === null) throw new CliError('failed', 'A change must have a JSON body');
      this.#prune();
      let entry = this.#read(this.#name);
      if (entry && (entry.method !== method || entry.path !== path)) {
        throw new CliError(
          'journal-mismatch',
          'That idempotency key was used for another change; use a new key',
        );
      }
      if (entry && entry.input !== this.#input) throw otherInput();
      this.#attempted = true;
      if (entry?.answer) {
        // Answered already: that answer is the change's, and nothing is sent.
        const { status, body: answer } = entry.answer;
        const headers = { 'content-type': 'application/json' };
        return this.#keep(path, new Response(answer, { status, headers }));
      }
      // Journaled before it goes out, so a crash mid-request still resends these bytes.
      if (!entry) {
        const sentAt = this.#now().toISOString();
        entry = { method, path, body, input: this.#input, note: this.#note, sentAt, answer: null };
        this.#write(entry);
      }
      const headers = new Headers(init.headers);
      headers.set('idempotency-key', this.#key);
      const res = await send(url, { ...init, headers, body: entry.body });
      // A refusal means the change didn't happen, so the key is free for a
      // new attempt; an unknown outcome (5xx, busy, timeout) keeps the bytes.
      // Only while the server keeps the key, though: after that, a change
      // that landed is refused like any other.
      const refused = res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status);
      if (refused && !this.#keyKept(entry)) this.#inconclusive = true;
      else if (refused) removePrivateFile(join(this.#dir, this.#name));
      else if (res.ok) {
        const answer = {
          status: res.status,
          body: await res.clone().text(),
          at: this.#now().toISOString(),
        };
        this.#write({ ...entry, answer });
      }
      return this.#keep(path, res);
    };
  }

  /**
   * Whether the server still keeps the key of `entry`'s change. One that
   * doesn't say when it went out may be of any age.
   */
  #keyKept(entry: Entry): boolean {
    if (entry.sentAt === undefined) return false;
    return this.#now().getTime() - Date.parse(entry.sentAt) < KEY_SURELY_KEPT_MS;
  }

  async #keep(path: string, res: Response): Promise<Response> {
    if (res.ok) {
      try {
        this.#sent = { path, answer: JSON.parse(await res.clone().text()) };
      } catch {
        // The API client reports an unreadable answer itself.
      }
    }
    return res;
  }
}
