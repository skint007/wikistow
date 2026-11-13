// Strict decoding of what a live session sends (protocol section 5.10):
// Yjs updates in the pinned-down v1 form, decoded in full before any of it
// reaches Yjs, and states (`Y.encodeSnapshot`). Yjs accepts bytes after an
// update's end, and makes a root for any name a struct reads, so nothing
// goes to it that this module hasn't read first.
import { CryptoError } from '../errors.ts';

/** The eight root types of a session's document (section 5.10, **The document**). */
export const TEXT_ROOTS = ['title', 'frontmatter', 'body'] as const;
export const MAP_ROOTS = ['attachments', 'extensions', 'links', 'overlaps', 'fields'] as const;
export type TextRoot = (typeof TEXT_ROOTS)[number];
export type MapRoot = (typeof MAP_ROOTS)[number];
export type RootName = TextRoot | MapRoot;
export const ROOTS: readonly RootName[] = [...TEXT_ROOTS, ...MAP_ROOTS];
const isRoot = (name: string): name is RootName => (ROOTS as readonly string[]).includes(name);

/** A struct's ID: its client and clock. */
export type StructId = { client: number; clock: number };

/** What an item holds: only the three kinds section 5.10 allows. */
export type ItemContent =
  | { kind: 'deleted'; length: number }
  | { kind: 'string'; text: string }
  /** A `ContentAny` of strings; the last is the value Yjs reads. */
  | { kind: 'any'; values: string[] };

/**
 * One item of an update, as read. `parent` is the root it names, only when
 * it has neither origin, so it takes no parent from one; `parentSub` is its
 * map key in that case. An item with an origin takes both from it, as Yjs
 * does, whatever its parent-key flag says.
 */
export type DecodedItem = {
  id: StructId;
  length: number;
  origin: StructId | null;
  rightOrigin: StructId | null;
  parent: RootName | null;
  parentSub: string | null;
  content: ItemContent;
};

/** The structs of one client, at consecutive clocks from `start`. */
export type ClientStructs = { client: number; start: number; end: number; items: DecodedItem[] };

/** A range of one client's clocks, `[clock, clock + length)`. */
export type ClockRange = { clock: number; length: number };

/** An update, read in full: its structs by client, and its delete set by client. */
export type DecodedUpdate = {
  structs: ClientStructs[];
  deletes: Map<number, ClockRange[]>;
};

/** A state (section 5.10, **States**): a delete set and a state vector, decoded. */
export type LiveState = {
  /** Each client's clock: the clock its next struct would take. Never 0. */
  vector: Map<number, number>;
  /** What is deleted, by client. */
  deletes: Map<number, ClockRange[]>;
};

function refuse(why: string): never {
  throw new CryptoError('binding-mismatch', `Not a live update: ${why}`);
}

// The parts of a v1 struct's info byte.
const CONTENT = 0x1f;
const HAS_PARENT_SUB = 0x20;
const HAS_RIGHT_ORIGIN = 0x40;
const HAS_ORIGIN = 0x80;
const CONTENT_DELETED = 1;
const CONTENT_STRING = 4;
const CONTENT_ANY = 8;
const ANY_STRING = 119;

// lib0 reads strings as fatal UTF-8 and keeps a leading U+FEFF, which the
// session's text may hold; `decodeUtf8` would refuse one.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class Reader {
  #pos = 0;
  readonly #bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get done(): boolean {
    return this.#pos === this.#bytes.length;
  }

  byte(): number {
    const byte = this.#bytes[this.#pos++];
    if (byte === undefined) return refuse('it ends early');
    return byte;
  }

  /** A varuint as lib0 writes it: minimal, and a safe integer. */
  uint(): number {
    let value = 0;
    let scale = 1;
    for (let count = 0; ; count++) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if (!Number.isSafeInteger(value)) return refuse('a number is too large');
      if (byte < 0x80) {
        if (count > 0 && byte === 0) refuse('a number is not written minimally');
        return value;
      }
      scale *= 128;
    }
  }

  string(): string {
    const length = this.uint();
    const end = this.#pos + length;
    if (end > this.#bytes.length) refuse('a string runs past its end');
    try {
      return utf8.decode(this.#bytes.subarray(this.#pos, end));
    } catch (cause) {
      throw new CryptoError('binding-mismatch', 'Not a live update: a string is not UTF-8', {
        cause,
      });
    } finally {
      this.#pos = end;
    }
  }
}

const id = (reader: Reader): StructId => ({ client: reader.uint(), clock: reader.uint() });

const end = (start: number, length: number) => {
  const after = start + length;
  if (!Number.isSafeInteger(after)) refuse('a clock is too large');
  return after;
};

function readContent(reader: Reader, kind: number): ItemContent {
  if (kind === CONTENT_DELETED) {
    const length = reader.uint();
    if (length === 0) refuse('deleted content of length 0');
    return { kind: 'deleted', length };
  }
  if (kind === CONTENT_STRING) {
    const text = reader.string();
    if (text.length === 0) refuse('an empty string');
    return { kind: 'string', text };
  }
  if (kind === CONTENT_ANY) {
    const count = reader.uint();
    if (count === 0) refuse('an empty value list');
    const values: string[] = [];
    for (let i = 0; i < count; i++) {
      if (reader.byte() !== ANY_STRING) refuse('a value that is not a string');
      values.push(reader.string());
    }
    return { kind: 'any', values };
  }
  if (kind === 0) return refuse('a GC struct');
  if (kind === 10) return refuse('a skip struct');
  return refuse(`content of kind ${kind}`);
}

const contentLength = (content: ItemContent): number =>
  content.kind === 'deleted'
    ? content.length
    : content.kind === 'string'
      ? content.text.length
      : content.values.length;

function readItem(reader: Reader, client: number, clock: number): DecodedItem {
  const info = reader.byte();
  const origin = info & HAS_ORIGIN ? id(reader) : null;
  const rightOrigin = info & HAS_RIGHT_ORIGIN ? id(reader) : null;
  let parent: RootName | null = null;
  let parentSub: string | null = null;
  if (origin === null && rightOrigin === null) {
    // 1 names a root by name; anything else is a parent by ID, a nested type.
    if (reader.uint() !== 1) refuse('a parent named by ID');
    const name = reader.string();
    if (!isRoot(name)) refuse('a root the document doesn’t have');
    parent = name as RootName;
    if (info & HAS_PARENT_SUB) parentSub = reader.string();
  }
  const content = readContent(reader, info & CONTENT);
  for (const other of [origin, rightOrigin]) {
    if (other && other.client === client && other.clock >= clock) {
      refuse('an origin under its own client at or after its own clock');
    }
  }
  return {
    id: { client, clock },
    length: contentLength(content),
    origin,
    rightOrigin,
    parent,
    parentSub,
    content,
  };
}

function readDeletes(reader: Reader): Map<number, ClockRange[]> {
  const deletes = new Map<number, ClockRange[]>();
  const clients = reader.uint();
  for (let i = 0; i < clients; i++) {
    const client = reader.uint();
    if (deletes.has(client)) refuse('a client twice in the delete set');
    const count = reader.uint();
    if (count === 0) refuse('a client with no deleted ranges');
    const ranges: ClockRange[] = [];
    for (let j = 0; j < count; j++) {
      const clock = reader.uint();
      const length = reader.uint();
      if (length === 0) refuse('a deleted range of length 0');
      end(clock, length);
      ranges.push({ clock, length });
    }
    deletes.set(client, ranges);
  }
  return deletes;
}

/**
 * Read a Yjs update in the v1 form a session accepts (section 5.10,
 * **`update`**), in full, or refuse it (`binding-mismatch`): lib0's
 * encoding with minimal varuints and fatal UTF-8 strings, each client once
 * among the structs and once in the delete set, none with nothing in it,
 * no GC or skip struct, only deleted, string and string-valued `ContentAny`
 * content, nothing of length 0, parents only as roots of the document by
 * name, origins under a struct's own client only below its own clock, and
 * nothing after its end. Which root an item with an origin is in, and the
 * rest of section 5.10's checks, are known only as Yjs places it
 * (`LiveDocument`).
 */
export function decodeUpdate(bytes: Uint8Array): DecodedUpdate {
  const reader = new Reader(bytes);
  const structs: ClientStructs[] = [];
  const seen = new Set<number>();
  const sections = reader.uint();
  for (let i = 0; i < sections; i++) {
    const count = reader.uint();
    if (count === 0) refuse('a client with no structs');
    const client = reader.uint();
    if (seen.has(client)) refuse('a client twice among the structs');
    seen.add(client);
    const start = reader.uint();
    let clock = start;
    const items: DecodedItem[] = [];
    for (let j = 0; j < count; j++) {
      const item = readItem(reader, client, clock);
      items.push(item);
      clock = end(clock, item.length);
    }
    structs.push({ client, start, end: clock, items });
  }
  const deletes = readDeletes(reader);
  if (!reader.done) refuse('bytes after its end');
  return { structs, deletes };
}

/**
 * Read a state as `Y.encodeSnapshot` writes it, the delete set first and
 * the state vector after (section 5.10, **States**), or `null` for one that
 * doesn't decode strictly: minimal varuints, each client once in each part,
 * no state-vector entry of 0, no client without ranges, no range of length
 * 0, and nothing after its end. A draft whose state is `null` counts as one
 * from outside the session.
 */
export function decodeState(bytes: Uint8Array): LiveState | null {
  try {
    const reader = new Reader(bytes);
    const deletes = readDeletes(reader);
    const vector = new Map<number, number>();
    const clients = reader.uint();
    for (let i = 0; i < clients; i++) {
      const client = reader.uint();
      const clock = reader.uint();
      if (vector.has(client) || clock === 0) return null;
      vector.set(client, clock);
    }
    return reader.done ? { vector, deletes } : null;
  } catch (error) {
    if (error instanceof CryptoError) return null;
    throw error;
  }
}

/** `ranges` as sorted, merged ranges, so two delete sets compare by what they cover. */
export function coverage(ranges: readonly ClockRange[]): ClockRange[] {
  const sorted = [...ranges].sort((a, b) => a.clock - b.clock);
  const out: ClockRange[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.clock <= last.clock + last.length) {
      last.length = Math.max(last.length, range.clock + range.length - last.clock);
    } else {
      out.push({ ...range });
    }
  }
  return out;
}

// Whether `outer`'s merged ranges cover each of `inner`'s.
function covers(outer: readonly ClockRange[], inner: readonly ClockRange[]): boolean {
  const merged = coverage(outer);
  return coverage(inner).every((range) =>
    merged.some(
      (held) => held.clock <= range.clock && range.clock + range.length <= held.clock + held.length,
    ),
  );
}

/**
 * Whether state `a` holds state `b` (section 5.10, **States**): its state
 * vector is at least `b`'s for every client, and its delete set covers
 * `b`'s, by the clocks they cover, however Yjs cut or ordered them.
 */
export function holdsState(a: LiveState, b: LiveState): boolean {
  for (const [client, clock] of b.vector) {
    if ((a.vector.get(client) ?? 0) < clock) return false;
  }
  for (const [client, ranges] of b.deletes) {
    if (!covers(a.deletes.get(client) ?? [], ranges)) return false;
  }
  return true;
}

/** Whether two states have exactly what each other has. */
export const sameState = (a: LiveState, b: LiveState): boolean =>
  holdsState(a, b) && holdsState(b, a);
