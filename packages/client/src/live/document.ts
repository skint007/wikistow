// A live session's shared document (protocol section 5.10, **The
// document**): a `Y.Doc` with eight root types, whose maps hold JSON text.
// `LiveDocument` checks each struct as Yjs places it, before any editor
// binding sees the change, reads the document entry by entry, and writes
// and compares the page payload a save makes of it.
import {
  OVERLAPS_NAMESPACE,
  OverlapEntry,
  OverlapsExtension,
  PageId,
  RevisionId,
} from '@wikistow/contracts';
import * as Y from 'yjs';
import { CryptoError } from '../errors.ts';
import { matchesPath, parseJsonText, repairText, type JsonPathPattern } from '../json.ts';
import { splitFrontmatter } from '../markdown/frontmatter.ts';
import { AttachmentRef, PAYLOAD_FORMAT, PAYLOAD_INTEGERS, type PagePayload } from '../payload.ts';
import {
  MAP_ROOTS,
  TEXT_ROOTS,
  decodeState,
  type LiveState,
  type MapRoot,
  type RootName,
} from './decode.ts';

/** Top-level payload fields the first five roots hold, which `fields` never names. */
const OWN_FIELDS = new Set(['format', 'title', 'markdown', 'attachments', 'extensions']);

/** Extensions a save works out or drops, which the document never holds. */
export const UNHELD_EXTENSIONS = new Set([
  'wikistow.live',
  'wikistow.links',
  'wikistow.change',
  OVERLAPS_NAMESPACE,
]);

/** What comparing two payloads leaves aside, beside `format` (section 5.10, **Saving**). */
const COMPARED_ASIDE = new Set(['wikistow.links', 'wikistow.live', 'wikistow.change']);

/**
 * A struct that doesn't fit the document, found as Yjs placed it. Its
 * sender has shown itself dishonest: the app can't catch up, and reports it.
 */
export type Misplaced = { client: number; clock: number; why: string };

/** The document's content, read entry by entry. Map values are JSON text. */
export type DocumentContent = {
  title: string;
  frontmatter: string;
  body: string;
  attachments: Map<string, string>;
  extensions: Map<string, string>;
  links: Map<string, string>;
  overlaps: Map<string, string>;
  fields: Map<string, string>;
};

/**
 * A page's Markdown from its front matter and body (section 5.10): the body
 * alone when the front matter is empty; otherwise the front matter, then one
 * line break when the body isn't empty and the front matter doesn't end
 * with U+000A (CRLF if more of its line breaks are CRLF than lone LF), then
 * the body, as the app joins them (`joinPage`).
 */
export function joinMarkdown(frontmatter: string, body: string): string {
  if (frontmatter === '') return body;
  if (body === '' || frontmatter.endsWith('\n')) return frontmatter + body;
  const crlf = frontmatter.split('\r\n').length - 1;
  const lf = frontmatter.split('\n').length - 1 - crlf;
  return `${frontmatter}${crlf > lf ? '\r\n' : '\n'}${body}`;
}

/**
 * A map value's JSON text, parsed by section 3.2's rules for a decrypted
 * payload at the depth it will have in the payload, with the integer rules
 * of the field it fills, or `undefined` if it isn't such text.
 */
function parseValue(text: string, depth: number, integers: readonly JsonPathPattern[]): unknown {
  let parsed: ReturnType<typeof parseJsonText>;
  try {
    parsed = parseJsonText(`${'['.repeat(depth)}${text}${']'.repeat(depth)}`);
  } catch {
    return undefined;
  }
  const own = (path: readonly (string | number)[]) => path.slice(depth);
  const bad = parsed.defects.some(({ path, problem }) =>
    problem === 'number-token' ? integers.some((pattern) => matchesPath(own(path), pattern)) : true,
  );
  if (bad) return undefined;
  let value: unknown = parsed.value;
  for (let i = 0; i < depth; i++) value = (value as unknown[])[0];
  return value;
}

/** The integer rules of one extension namespace's value, from the page payload's. */
const extensionIntegers = (namespace: string): JsonPathPattern[] =>
  PAYLOAD_INTEGERS.flatMap((pattern) =>
    pattern[0] === 'extensions' && (pattern[1] === namespace || pattern[1] === '*')
      ? [pattern.slice(2)]
      : [],
  );

/** A field's integer rules: those of the page payload at that top-level name. */
const fieldIntegers = (name: string): JsonPathPattern[] =>
  PAYLOAD_INTEGERS.flatMap((pattern) =>
    pattern[0] === name || pattern[0] === '*' ? [pattern.slice(1)] : [],
  );

/**
 * Why a map entry, placed, doesn't fit the document, or `null` (section
 * 5.10, **The document**): a value that isn't JSON text of its kind; a
 * `fields` key naming one of the first five; an `extensions` key the
 * document never holds; an `attachments` key other than its ref's `id`; a
 * `links` value that isn't a page ID; or an `overlaps` key that isn't a
 * revision ID or isn't its entry's `revision`.
 */
export function entryProblem(root: MapRoot, key: string, text: string): string | null {
  if (!key.isWellFormed() || !text.isWellFormed()) return 'an ill-formed key or value';
  switch (root) {
    case 'attachments': {
      const value = parseValue(text, 2, [['size']]);
      if (!AttachmentRef.safeParse(value).success) return 'an attachment that isn’t a ref';
      return (value as AttachmentRef).id === key ? null : 'an attachment under another ID';
    }
    case 'extensions':
      if (UNHELD_EXTENSIONS.has(key)) return `an extension the document never holds (${key})`;
      return parseValue(text, 2, extensionIntegers(key)) === undefined
        ? 'an extension value that isn’t JSON'
        : null;
    case 'links':
      return PageId.safeParse(parseValue(text, 3, [])).success ? null : 'a link to no page ID';
    case 'overlaps': {
      const value = parseValue(text, 4, []);
      if (!RevisionId.safeParse(key).success) return 'an overlap under no revision ID';
      const entry = OverlapEntry.safeParse(value);
      return entry.success && entry.data.revision === key
        ? null
        : 'an overlap that isn’t its entry';
    }
    case 'fields':
      if (OWN_FIELDS.has(key)) return `a field the document holds elsewhere (${key})`;
      return parseValue(text, 1, fieldIntegers(key)) === undefined
        ? 'a field value that isn’t JSON'
        : null;
  }
}

const isText = (root: RootName) => (TEXT_ROOTS as readonly string[]).includes(root);

/**
 * A session's document, with section 5.10's checks as Yjs places each
 * struct: run in `beforeObserverCalls`, before an editor binding sees the
 * change, for every struct a transaction added, held ones too. Only an
 * update that passed `decodeUpdate` and `LiveJoins.check` goes to `apply`.
 */
export class LiveDocument {
  readonly doc: Y.Doc;
  /** The derived client ID this app's join writes under. */
  readonly clientId: number;
  readonly #roots = new Map<unknown, RootName>();
  #misplaced: Misplaced[] = [];

  constructor(clientId: number) {
    this.clientId = clientId;
    this.doc = new Y.Doc({ gc: true });
    this.doc.clientID = clientId;
    for (const name of TEXT_ROOTS) this.#roots.set(this.doc.getText(name), name);
    for (const name of MAP_ROOTS) this.#roots.set(this.doc.getMap(name), name);
    this.doc.on('beforeObserverCalls', (transaction) => this.#check(transaction));
  }

  text(name: (typeof TEXT_ROOTS)[number]): Y.Text {
    return this.doc.getText(name);
  }

  map(name: MapRoot): Y.Map<string> {
    return this.doc.getMap<string>(name);
  }

  /**
   * Apply an update, and what didn't fit as Yjs placed it: anything means
   * the session is out of step. Also says so when Yjs gave the document a
   * new random client ID, as it does when an update adds structs under its
   * own; the app leaves the session then.
   */
  apply(update: Uint8Array, origin: unknown = 'remote'): Misplaced[] {
    this.#misplaced = [];
    Y.applyUpdate(this.doc, update, origin);
    const found = this.#misplaced;
    this.#misplaced = [];
    if (this.doc.clientID !== this.clientId) {
      found.push({ client: this.clientId, clock: 0, why: 'Yjs changed this join’s client ID' });
    }
    return found;
  }

  /**
   * Make a change of this app's own in one transaction, and what didn't fit
   * as Yjs placed it, which means a bug in the writer.
   */
  edit(change: () => void, origin: unknown = 'local'): Misplaced[] {
    this.#misplaced = [];
    this.doc.transact(change, origin);
    const found = this.#misplaced;
    this.#misplaced = [];
    return found;
  }

  /** Whether Yjs holds anything back, waiting for structs it hasn't got. */
  get pending(): boolean {
    return this.doc.store.pendingStructs !== null || this.doc.store.pendingDs !== null;
  }

  /** The document's state (section 5.10, **States**), as `Y.encodeSnapshot` writes it. */
  stateBytes(): Uint8Array {
    return Y.encodeSnapshot(Y.snapshot(this.doc));
  }

  /** The document's state, decoded. */
  state(): LiveState {
    const state = decodeState(this.stateBytes());
    if (!state) throw new CryptoError('malformed', 'Yjs wrote a state that doesn’t decode');
    return state;
  }

  /** What the document holds, read entry by entry, never with `toJSON`, which drops `__proto__`. */
  content(): DocumentContent {
    const entries = (name: MapRoot) => new Map([...this.map(name).entries()]);
    // A text's `toJSON` is its string; only a map's drops `__proto__`.
    return {
      title: this.text('title').toJSON(),
      frontmatter: this.text('frontmatter').toJSON(),
      body: this.text('body').toJSON(),
      attachments: entries('attachments'),
      extensions: entries('extensions'),
      links: entries('links'),
      overlaps: entries('overlaps'),
      fields: entries('fields'),
    };
  }

  /**
   * The page payload a save writes from the document (section 5.10, **The
   * document**), but for `wikistow.links` and `wikistow.live`, which the
   * saver works out: its attachments in the order `base` had them, then
   * new ones; `wikistow.overlaps` from `overlaps`, in code-unit order of
   * their IDs, only when it isn't empty; and every other field from
   * `fields`. Each value is written as parsed, as own data properties.
   * Throws `malformed` if a value isn't JSON text of its kind.
   */
  payload(base: PagePayload | null = null): PagePayload {
    const content = this.content();
    const value = (root: MapRoot, key: string, text: string, depth: number) => {
      const problem = entryProblem(root, key, text);
      if (problem) throw new CryptoError('malformed', `The document holds ${problem}`);
      return parseValue(text, depth, []);
    };
    const refs = new Map(
      [...content.attachments].map(([id, text]) => [id, value('attachments', id, text, 2)]),
    );
    const order = (base?.attachments ?? []).map((ref) => ref.id).filter((id) => refs.has(id));
    const attachments = [...new Set([...order, ...refs.keys()])].map(
      (id) => refs.get(id) as AttachmentRef,
    );
    const extensions: Record<string, unknown> = {};
    for (const [namespace, text] of content.extensions) {
      define(extensions, namespace, value('extensions', namespace, text, 2));
    }
    const overlaps = [...content.overlaps]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([revision, text]) => value('overlaps', revision, text, 4));
    if (overlaps.length > 0) {
      define(extensions, OVERLAPS_NAMESPACE, { format: 1, revisions: overlaps });
    }
    const payload: Record<string, unknown> = {};
    for (const [name, text] of content.fields)
      define(payload, name, value('fields', name, text, 1));
    const format = base?.format ?? PAYLOAD_FORMAT;
    define(payload, 'format', {
      ...format,
      major: PAYLOAD_FORMAT.major,
      minor: Math.max(format.minor, PAYLOAD_FORMAT.minor),
    });
    define(payload, 'title', content.title);
    define(payload, 'markdown', joinMarkdown(content.frontmatter, content.body));
    define(payload, 'attachments', attachments);
    define(payload, 'extensions', extensions);
    return payload as PagePayload;
  }

  #check(transaction: Y.Transaction): void {
    const store = this.doc.store;
    for (const [client, after] of transaction.afterState) {
      const before = transaction.beforeState.get(client) ?? 0;
      if (after <= before) continue;
      const structs = store.clients.get(client) ?? [];
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        if (!struct || struct.id.clock >= after) break;
        const why = this.#problem(struct);
        if (why) this.#misplaced.push({ client, clock: struct.id.clock, why });
      }
    }
  }

  #problem(struct: Y.Item | Y.GC): string | null {
    if (!(struct instanceof Y.Item)) return 'Yjs made it a GC struct as it placed it';
    const root = this.#roots.get(struct.parent);
    if (!root) return 'it is in no root of the document';
    const { content } = struct;
    if (isText(root)) {
      if (struct.parentSub !== null) return 'text under a map key';
      if (!(content instanceof Y.ContentString) && !(content instanceof Y.ContentDeleted)) {
        return 'something other than text in a text part';
      }
    } else {
      if (struct.parentSub === null) return 'a map value with no key';
      if (content instanceof Y.ContentAny) {
        const values = content.getContent();
        if (!values.every((v) => typeof v === 'string')) return 'a map value that isn’t a string';
        const text = values.at(-1) as string;
        const problem = struct.deleted
          ? null
          : entryProblem(root as MapRoot, struct.parentSub, text);
        if (problem) return problem;
      } else if (!(content instanceof Y.ContentDeleted)) {
        return 'something other than a string in a map';
      }
    }
    if (struct.origin && struct.rightOrigin) {
      if (Y.compareIDs(struct.origin, struct.rightOrigin)) return 'its two origins are one struct';
      const left = Y.getItem(this.doc.store, struct.origin);
      const right = Y.getItem(this.doc.store, struct.rightOrigin);
      if (left.parent !== right.parent || left.parentSub !== right.parentSub) {
        return 'its origins are under different parents or keys';
      }
    }
    return null;
  }
}

// Define a member, so one named `__proto__` stays a member.
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * The document a session starts from (section 5.10, **`snapshot`**): the
 * draft's text, repaired as a save repairs it, under the starter's client
 * alone, with its attachments, its extensions but those the document never
 * holds, its overlaps notes and its other fields. A draft with two refs of
 * one ID, or two notes for one revision, or whose member names collide once
 * repaired, starts no session (`malformed`). A `wikistow.overlaps` of a
 * newer format stays out of the document; saves carry it from the head.
 */
export function documentFromPayload(payload: PagePayload, clientId: number): LiveDocument {
  const { value: repaired } = repairText(payload);
  const document = new LiveDocument(clientId);
  const { frontmatter, body } = splitFrontmatter(repaired.markdown);
  const ids = repaired.attachments.map((ref) => ref.id);
  if (new Set(ids).size !== ids.length) {
    throw new CryptoError('malformed', 'The draft lists two attachments under one ID');
  }
  const notes = OverlapsExtension.safeParse(repaired.extensions[OVERLAPS_NAMESPACE]);
  const noted = notes.success ? notes.data.revisions.map((entry) => entry.revision) : [];
  if (new Set(noted).size !== noted.length) {
    throw new CryptoError('malformed', 'The draft has two notes for one revision');
  }
  const misplaced = document.edit(() => {
    const put = (name: (typeof TEXT_ROOTS)[number], text: string) => {
      if (text !== '') document.text(name).insert(0, text);
    };
    put('title', repaired.title);
    put('frontmatter', frontmatter ?? '');
    put('body', body);
    for (const ref of repaired.attachments)
      document.map('attachments').set(ref.id, JSON.stringify(ref));
    for (const [namespace, value] of Object.entries(repaired.extensions)) {
      if (!UNHELD_EXTENSIONS.has(namespace)) {
        document.map('extensions').set(namespace, JSON.stringify(value));
      }
    }
    for (const entry of notes.success
      ? (repaired.extensions[OVERLAPS_NAMESPACE] as OverlapsExtension).revisions
      : []) {
      document.map('overlaps').set(entry.revision, JSON.stringify(entry));
    }
    for (const [name, value] of Object.entries(repaired)) {
      if (!OWN_FIELDS.has(name)) document.map('fields').set(name, JSON.stringify(value));
    }
  }, 'start');
  if (misplaced.length > 0) {
    throw new CryptoError('malformed', `The draft can’t be a document: ${misplaced[0]?.why}`);
  }
  return document;
}

/**
 * Whether two JSON values are equal (section 5.10, **Equal payloads**): an
 * object's members as a set, whatever their order, arrays in order, and
 * numbers by value, -0 equal to 0.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  const left = Object.keys(a);
  const right = new Set(Object.keys(b));
  return (
    left.length === right.size &&
    left.every(
      (key) =>
        right.has(key) &&
        jsonEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

// A payload's attachments by ID, or null when two share one, which equals no document.
function attachmentSet(payload: PagePayload): Map<string, unknown> | null {
  const refs = new Map<string, unknown>();
  for (const ref of payload.attachments) {
    if (refs.has(ref.id)) return null;
    refs.set(ref.id, ref);
  }
  return refs;
}

// `wikistow.overlaps` as it compares: absent when it counts as none or its
// list is empty, null when two entries name one revision, `newer` for a
// newer format, carried unchanged by saves, and otherwise its entries by
// revision.
function overlapsOf(payload: PagePayload): Map<string, unknown> | 'newer' | null | undefined {
  const raw = payload.extensions[OVERLAPS_NAMESPACE];
  if (raw === undefined) return undefined;
  const format = (raw as { format?: unknown } | null)?.format;
  if (typeof format === 'number' && Number.isSafeInteger(format) && format > 1) return 'newer';
  const parsed = OverlapsExtension.safeParse(raw);
  if (!parsed.success || parsed.data.revisions.length === 0) return undefined;
  const entries = new Map<string, unknown>();
  for (const entry of (raw as OverlapsExtension).revisions) {
    if (entries.has(entry.revision)) return null;
    entries.set(entry.revision, entry);
  }
  return entries;
}

/**
 * Whether the payload a save writes from a session's document equals a
 * draft's (section 5.10, **Saving** and **Equal payloads**), `format`,
 * `wikistow.links`, `wikistow.live` and `wikistow.change` aside: title,
 * Markdown, attachments as a set of whole refs matched by ID, the other
 * extensions and fields as JSON values, and `wikistow.overlaps` by its
 * entries as a set. The draft is repaired first, as a save repairs it; one
 * whose names collide once repaired, or with two refs of one ID or two
 * notes for one revision, equals no document. A `wikistow.overlaps` of a
 * newer format on the draft is carried by saves unchanged, so it counts as
 * equal while the document holds no notes of its own.
 */
export function samePayload(document: PagePayload, draft: PagePayload): boolean {
  let repaired: PagePayload;
  try {
    repaired = repairText(draft).value;
  } catch {
    return false;
  }
  if (document.title !== repaired.title || document.markdown !== repaired.markdown) return false;
  const [ours, theirs] = [attachmentSet(document), attachmentSet(repaired)];
  if (!ours || !theirs || ours.size !== theirs.size) return false;
  for (const [id, ref] of ours) if (!jsonEqual(ref, theirs.get(id))) return false;
  const [mine, other] = [overlapsOf(document), overlapsOf(repaired)];
  if (mine === null || other === null || mine === 'newer') return false;
  if (other === 'newer') {
    if (mine !== undefined) return false;
  } else if ((mine === undefined) !== (other === undefined)) {
    return false;
  } else if (mine && other) {
    if (mine.size !== other.size) return false;
    for (const [revision, entry] of mine) if (!jsonEqual(entry, other.get(revision))) return false;
  }
  const rest = (payload: PagePayload) => {
    const extensions: Record<string, unknown> = {};
    for (const [namespace, value] of Object.entries(payload.extensions)) {
      if (!COMPARED_ASIDE.has(namespace) && namespace !== OVERLAPS_NAMESPACE) {
        define(extensions, namespace, value);
      }
    }
    const fields: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(payload)) {
      if (!OWN_FIELDS.has(name)) define(fields, name, value);
    }
    return { extensions, fields };
  };
  const [a, b] = [rest(document), rest(repaired)];
  return jsonEqual(a.extensions, b.extensions) && jsonEqual(a.fields, b.fields);
}
