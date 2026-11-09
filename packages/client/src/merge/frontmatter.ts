// The front matter merged by key (ADR 0013, decision 5). The merged block
// starts from theirs' exact text, and each of yours' changes replaces only
// its key's lines. A list of plain values changed on both sides merges by
// item. A block that isn't a map of keys on any side is one field.
import {
  readProperties,
  setProperty,
  type Property,
  type PropertyScalar,
} from '../markdown/index.ts';
import type { Choice } from './body.ts';

/** A front matter block as `splitFrontmatter` gives it, or null for none. */
type Block = string | null;

/** How one key merges. Its lines are null where that side has no such key. */
export type KeyMerge =
  /** Yours changed it alone: yours' lines in place of theirs', or out where null. */
  | { key: string; from: 'yours'; lines: string | null; after: readonly string[] }
  /** A list both changed, merged by item. */
  | { key: string; from: 'items'; items: readonly PropertyScalar[] }
  /** Both changed it differently. */
  | {
      key: string;
      from: 'overlap';
      base: string | null;
      yours: string | null;
      theirs: string | null;
      after: readonly string[];
    };

/** A front matter merge: by key, or, where some block isn't a map of keys, as one field. */
export type FrontmatterMerge =
  | {
      kind: 'keys';
      theirs: Block;
      /** Whether yours has no block, so one left with no keys goes. */
      yoursNone: boolean;
      /** Yours' changes and the overlaps, in yours' order, then the keys only theirs has. */
      keys: readonly KeyMerge[];
      /** Each side's changes taken on their own. */
      combined: { yours: number; theirs: number };
    }
  | {
      kind: 'whole';
      base: Block;
      yours: Block;
      theirs: Block;
      /** The block taken, or undefined where both changed it differently. */
      taken: Block | undefined;
      /** The changes of the side taken, by key where the blocks are keys. */
      combined: { yours: number; theirs: number };
    };

// A block's keys, each with its lines (from its key's line to the next
// key's, or the closing line) and its value as compared.
type Entry = {
  key: string;
  lines: string;
  start: number;
  end: number;
  value: string;
  list: PropertyScalar[] | null;
};
type Read = { entries: Entry[]; closeStart: number };

function readKeys(block: Block): Read | null {
  const read = readProperties(block);
  if (!read.ok) return null;
  if (block === null) return { entries: [], closeStart: 0 };
  const open = /^---\r?\n/.exec(block)?.[0].length ?? 0;
  const closeStart = open + block.slice(open).replace(/\n$/, '').lastIndexOf('\n') + 1;
  const starts = read.properties.map(
    ({ keySpan }) => block.lastIndexOf('\n', keySpan.start - 1) + 1,
  );
  const entries = read.properties.map((property, i) => {
    const start = starts[i] ?? 0;
    const end = starts[i + 1] ?? closeStart;
    return {
      key: property.key,
      lines: block.slice(start, end),
      start,
      end,
      value: valueOf(property),
      list: plainList(property),
    };
  });
  return { entries, closeStart };
}

const valueOf = ({ type, value }: Pick<Property, 'type' | 'value'>) =>
  JSON.stringify({ type, value });

// A list of plain values, such as tags, or null.
function plainList({ value }: Property): PropertyScalar[] | null {
  if (!Array.isArray(value)) return null;
  const items: PropertyScalar[] = [];
  for (const item of value) {
    if (Array.isArray(item)) return null;
    items.push(item as PropertyScalar);
  }
  return items;
}

const has = (items: readonly PropertyScalar[], item: PropertyScalar) =>
  items.some((other) => other === item);

// How many keys `side` changed, added or removed from `base`; 1 for any
// change where either isn't keys.
function changes(base: Block, side: Block): number {
  const [b, s] = [readKeys(base), readKeys(side)];
  if (!b || !s) return base === side ? 0 : 1;
  const values = (read: Read) => new Map(read.entries.map(({ key, value }) => [key, value]));
  const [was, now] = [values(b), values(s)];
  return [...new Set([...was.keys(), ...now.keys()])].filter((key) => was.get(key) !== now.get(key))
    .length;
}

/** The three-way merge of three front matter blocks, by key. */
export function mergeFrontmatter(base: Block, yours: Block, theirs: Block): FrontmatterMerge {
  const whole = (taken: Block | undefined, combined = { yours: 0, theirs: 0 }) => ({
    kind: 'whole' as const,
    base,
    yours,
    theirs,
    taken,
    combined,
  });
  if (yours === theirs) return whole(theirs);
  if (yours === base) return whole(theirs, { yours: 0, theirs: changes(base, theirs) });
  if (theirs === base) return whole(yours, { yours: changes(base, yours), theirs: 0 });
  const [b, y, t] = [readKeys(base), readKeys(yours), readKeys(theirs)];
  if (!b || !y || !t) return whole(undefined);
  const find = (read: Read, key: string) => read.entries.find((entry) => entry.key === key);
  const keys: KeyMerge[] = [];
  const combined = { yours: 0, theirs: 0 };
  const names = [...new Set([...y.entries, ...t.entries, ...b.entries].map(({ key }) => key))];
  for (const key of names) {
    const [be, ye, te] = [find(b, key), find(y, key), find(t, key)];
    const yoursChanged = ye?.value !== be?.value;
    const theirsChanged = te?.value !== be?.value;
    if (theirsChanged && !yoursChanged) combined.theirs++;
    if (!yoursChanged || ye?.value === te?.value) continue;
    // The keys before it in yours, nearest first, for where an added key goes.
    const index = y.entries.findIndex((entry) => entry.key === key);
    const after = y.entries
      .slice(0, Math.max(index, 0))
      .map((entry) => entry.key)
      .reverse();
    if (!theirsChanged) {
      combined.yours++;
      keys.push({ key, from: 'yours', lines: ye?.lines ?? null, after });
    } else if (ye?.list && te?.list && (!be || be.list)) {
      const removed = (be?.list ?? []).filter((item) => !has(ye.list ?? [], item));
      const added = ye.list.filter(
        (item) => !has(be?.list ?? [], item) && !has(te.list ?? [], item),
      );
      combined.yours++;
      combined.theirs++;
      keys.push({
        key,
        from: 'items',
        items: [...te.list.filter((item) => !has(removed, item)), ...added],
      });
    } else {
      keys.push({
        key,
        from: 'overlap',
        base: be?.lines ?? null,
        yours: ye?.lines ?? null,
        theirs: te?.lines ?? null,
        after,
      });
    }
  }
  return { kind: 'keys', theirs, yoursNone: yours === null, keys, combined };
}

/** The merged block, or why it couldn't be written as merged. */
export type WrittenFrontmatter = { ok: true; frontmatter: Block } | { ok: false };

/**
 * The merged block, with each overlap written as `choices` says (by key;
 * every overlap needs one), and read back: every key but those edited
 * must read as merged.
 */
export function writeFrontmatter(
  merge: Extract<FrontmatterMerge, { kind: 'keys' }>,
  choices: ReadonlyMap<string, Choice>,
): WrittenFrontmatter {
  const lineBreak = merge.theirs?.match(/\r?\n/)?.[0] ?? '\n';
  let block = merge.theirs ?? `---${lineBreak}---${lineBreak}`;
  const expected = new Map(
    (readKeys(merge.theirs)?.entries ?? []).map((entry) => [entry.key, entry.value]),
  );
  let edited = false;
  for (const change of merge.keys) {
    if (change.from === 'items') {
      const edit = setProperty(
        block,
        change.key,
        change.items,
        lineBreak === '\r\n' ? '\r\n' : '\n',
      );
      if (!edit.ok) return { ok: false };
      block = edit.frontmatter;
      expected.set(change.key, valueOf({ type: 'list', value: change.items }));
      continue;
    }
    const choice = change.from === 'yours' ? 'yours' : choices.get(change.key);
    if (choice === undefined || choice === 'both') throw new Error('Every overlap needs a choice.');
    if (choice === 'theirs') continue;
    if (typeof choice === 'object') {
      // Taken as it reads.
      edited = true;
      const typed =
        choice.edit === '' || /\r?\n$/.test(choice.edit) ? choice.edit : choice.edit + lineBreak;
      block = spliced(block, change.key, typed === '' ? null : typed, change.after);
      expected.delete(change.key);
      continue;
    }
    const lines = change.from === 'yours' ? change.lines : change.yours;
    block = spliced(block, change.key, lines, change.after);
    const value = lines === null ? undefined : readKeys(`---\n${lines}---\n`)?.entries[0]?.value;
    if (value === undefined) expected.delete(change.key);
    else expected.set(change.key, value);
  }
  const read = readKeys(block);
  if (!read) return edited ? { ok: true, frontmatter: block } : { ok: false };
  const values = new Map(read.entries.map((entry) => [entry.key, entry.value]));
  for (const [key, value] of expected) if (values.get(key) !== value) return { ok: false };
  if (!edited && values.size !== expected.size) return { ok: false };
  // A block that ends with no keys, where theirs or yours had none, is none.
  const none = (merge.theirs === null || merge.yoursNone) && read.entries.length === 0;
  return { ok: true, frontmatter: none ? null : block };
}

// `block` with `key`'s lines replaced by `lines`, taken out where null, or
// added after the nearest of the keys `after` it has, else before its first.
function spliced(
  block: string,
  key: string,
  lines: string | null,
  after: readonly string[],
): string {
  const read = readKeys(block);
  if (!read) return block;
  const entry = read.entries.find((other) => other.key === key);
  if (entry) return block.slice(0, entry.start) + (lines ?? '') + block.slice(entry.end);
  if (lines === null) return block;
  const before = after
    .map((name) => read.entries.find((other) => other.key === name))
    .find(Boolean);
  const at = before ? before.end : (read.entries[0]?.start ?? read.closeStart);
  return block.slice(0, at) + lines + block.slice(at);
}

/**
 * A front matter block cut as the review shows it: its opening lines, each
 * key's lines, and its closing line, each with what it reads as; one piece
 * where it isn't a map of keys.
 */
export function frontmatterPieces(block: Block): { text: string; key: string }[] {
  if (block === null) return [];
  const read = readKeys(block);
  if (!read) return [{ text: block, key: `frontmatter:${block}` }];
  const first = read.entries[0]?.start ?? read.closeStart;
  return [
    { text: block.slice(0, first), key: `open:${block.slice(0, first)}` },
    ...read.entries.map(({ key, lines, value }) => ({
      text: lines,
      key: `key:${JSON.stringify([key, value])}`,
    })),
    { text: block.slice(read.closeStart), key: 'close' },
  ];
}
