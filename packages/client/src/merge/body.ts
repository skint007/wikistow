// The three-way merge of a page body by block (ADR 0013, decision 4), and
// the writing of the merged body with its check.
import { diffArrays } from 'diff';
import { blankBlock, blocksOf, linesOf, type Block, type Container } from './blocks.ts';

/** What the person chose at an overlap. `both` is theirs, then yours. */
export type Choice = 'yours' | 'theirs' | 'both' | { edit: string };

/**
 * A stretch of the merged body: the blocks each version has there, and
 * what the merge takes. `taken` is null where both sides changed the same
 * base blocks differently: an overlap for the person to choose at.
 */
export type Segment = {
  readonly base: readonly Block[];
  readonly yours: readonly Block[];
  readonly theirs: readonly Block[];
  readonly taken: readonly Block[] | null;
  /**
   * Who changed it: nobody, one side, both the same way, or both adding
   * at the same place (`union`, both kept, theirs first).
   */
  readonly from: 'none' | 'yours' | 'theirs' | 'both' | 'union' | 'overlap';
};

/** A body merge: its segments in page order. */
export type BlockMerge = {
  readonly segments: readonly Segment[];
  /** Whether theirs ends with a line ending (or is empty), as the merged body will. */
  readonly ends: boolean;
  /** Each side's blocks, for where a block sat on its own side. */
  readonly sides: { readonly yours: readonly Block[]; readonly theirs: readonly Block[] };
};

// A run of base blocks, `os` to `oe`, that a side replaced with its blocks `xs` to `xe`.
type Hunk = { os: number; oe: number; xs: number; xe: number };

const sameKey = (a: Block, b: Block) => a.key === b.key;

// The blocks `a` and `b` have in common, in order, as index pairs.
function common(a: readonly Block[], b: readonly Block[]): [number, number][] {
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  for (const change of diffArrays([...a], [...b], { comparator: sameKey })) {
    if (change.removed) i += change.count;
    else if (change.added) j += change.count;
    else for (let k = 0; k < change.count; k++) pairs.push([i++, j++]);
  }
  return pairs;
}

// In a gap between blocks that line up, the blank lines both start with,
// and those both end with, as index pairs. The blank lines between stay
// with the change: pairing them would cut it into pieces that pair blocks
// by where they sit, not by what they are.
function edgeBlanks(a: readonly Block[], b: readonly Block[]): [number, number][] {
  const blank = (block: Block | undefined) => block?.kind === 'blank';
  const pairs: [number, number][] = [];
  let start = 0;
  while (blank(a[start]) && blank(b[start]) && a[start]?.key === b[start]?.key) {
    pairs.push([start, start]);
    start++;
  }
  const ends: [number, number][] = [];
  for (let i = a.length - 1, j = b.length - 1; i >= start && j >= start; i--, j--) {
    if (!blank(a[i]) || !blank(b[j]) || a[i]?.key !== b[j]?.key) break;
    ends.unshift([i, j]);
  }
  return [...pairs, ...ends];
}

// A side's changes from base, and for each base block the side's block it
// stayed as, or -1. Blocks that hold text line up first, then blank lines
// in the gaps between them, so a blank line kept never pairs two other
// blocks wrongly: every blank line reads the same.
function align(base: readonly Block[], side: readonly Block[]) {
  const real = (blocks: readonly Block[]) => blocks.filter((block) => block.kind !== 'blank');
  const at = (blocks: readonly Block[]) => {
    const index = new Map(blocks.map((block, i) => [block, i]));
    return (block: Block | undefined) => (block && index.get(block)) ?? 0;
  };
  const [inBase, inSide] = [real(base), real(side)];
  const [baseAt, sideAt] = [at(base), at(side)];
  const anchors = common(inBase, inSide).map(([i, j]): [number, number] => [
    baseAt(inBase[i]),
    sideAt(inSide[j]),
  ]);
  const end: [number, number] = [base.length, side.length];
  const pairs: [number, number][] = [];
  let [o, x] = [0, 0];
  for (const [b, s] of [...anchors, end]) {
    for (const [i, j] of edgeBlanks(base.slice(o, b), side.slice(x, s))) pairs.push([o + i, x + j]);
    if (b < base.length) pairs.push([b, s]);
    [o, x] = [b + 1, s + 1];
  }
  const hunks: Hunk[] = [];
  const match: number[] = Array.from({ length: base.length }, () => -1);
  [o, x] = [0, 0];
  for (const [b, s] of [...pairs, end]) {
    if (b > o || s > x) hunks.push({ os: o, oe: b, xs: x, xe: s });
    if (b < base.length) match[b] = s;
    [o, x] = [b + 1, s + 1];
  }
  // A run that replaced its base blocks one for one, each with a block of
  // its kind at its depth, is one change per block; a run that also added
  // or removed some, or paired unlike blocks, stays one change.
  const alike = (h: Hunk) =>
    Array.from({ length: h.oe - h.os }, (_, k) => [base[h.os + k], side[h.xs + k]]).every(
      ([a, b]) =>
        a && b && a.kind === b.kind && depthOf(a.place).join() === depthOf(b.place).join(),
    );
  const split = hunks.flatMap((h) =>
    h.oe - h.os > 1 && h.oe - h.os === h.xe - h.xs && alike(h)
      ? Array.from({ length: h.oe - h.os }, (_, k) => ({
          os: h.os + k,
          oe: h.os + k + 1,
          xs: h.xs + k,
          xe: h.xs + k + 1,
        }))
      : [h],
  );
  return { hunks: split, match };
}

type Aligned = ReturnType<typeof align>;

/**
 * An addition inside the other side's change, past only blank lines,
 * moves out of it over them. Where a change from each side meets the
 * other's only in blank lines both took out, the one that only took blocks
 * out moves by those blank lines,
 * if it can, so neighbouring removals don't overlap. Two notes at the end
 * of a page, each removed by one side, would otherwise both claim the blank
 * line between them.
 */
function keepApart(
  base: readonly Block[],
  [yours, yoursBlocks]: [Aligned, readonly Block[]],
  [theirs, theirsBlocks]: [Aligned, readonly Block[]],
) {
  // Blank lines are alike for this, quoted or not: either way one stays.
  const same = (i: number, j: number) =>
    base[i]?.key === base[j]?.key || (base[i]?.kind === 'blank' && base[j]?.kind === 'blank');
  const stayed = (side: Aligned, from: number, to: number) =>
    from >= 0 && to <= base.length && side.match.slice(from, to).every((x) => x >= 0);
  // Move a removal `by` blocks, down when positive, keeping its side's matches.
  const move = (side: Aligned, h: Hunk, by: number) => {
    const n = Math.abs(by);
    for (let j = 0; j < n; j++) {
      const [kept, gone] = by < 0 ? [h.oe - n + j, h.os - n + j] : [h.os + j, h.oe + j];
      side.match[kept] = side.match[gone] ?? -1;
      side.match[gone] = -1;
    }
    h.os += by;
    h.oe += by;
  };
  // Move an addition `by` blocks over blank lines, down when positive, if
  // it can go all the way: each blank line it passes is one it also has,
  // quoted the same, at its other end.
  const shift = (side: Aligned, blocks: readonly Block[], h: Hunk, by: number) => {
    const step = by > 0 ? 1 : -1;
    const at = (k: number) => {
      const [os, xs, xe] = [h.os + k * step, h.xs + k * step, h.xe + k * step];
      return step > 0
        ? { blank: os, from: xe, to: xs }
        : { blank: os - 1, from: xs - 1, to: xe - 1 };
    };
    const steps = Array.from({ length: Math.abs(by) }, (_, k) => at(k));
    const can = steps.every(
      ({ blank, from, to }) =>
        base[blank]?.kind === 'blank' &&
        blocks[to]?.key === base[blank]?.key &&
        side.match[blank] === from,
    );
    if (!can) return false;
    for (const { blank, to } of steps) side.match[blank] = to;
    h.os += by;
    h.oe += by;
    h.xs += by;
    h.xe += by;
    return true;
  };
  // An addition inside the other side's change, past only blank lines,
  // moves out of it over them, if it can.
  const outside = (side: Aligned, blocks: readonly Block[], h: Hunk, other: Aligned) => {
    if (h.os !== h.oe) return;
    const around = other.hunks.find((g) => g.os < h.os && h.os < g.oe);
    if (!around) return;
    const blankTo = (from: number, to: number) =>
      base.slice(from, to).every((block) => block.kind === 'blank');
    const [before, after] = [blankTo(around.os, h.os), blankTo(h.os, around.oe)];
    if (before && shift(side, blocks, h, around.os - h.os)) return;
    if (after && shift(side, blocks, h, around.oe - h.os)) return;
    // Else a removal splits there: what it took out on each side stays out.
    if ((before || after) && around.xs === around.xe) {
      const rest = { ...around, os: h.os };
      around.oe = h.os;
      other.hunks.splice(other.hunks.indexOf(around) + 1, 0, rest);
    }
  };
  for (const h of yours.hunks) outside(yours, yoursBlocks, h, theirs);
  for (const h of theirs.hunks) outside(theirs, theirsBlocks, h, yours);
  for (const y of yours.hunks) {
    for (const t of theirs.hunks) {
      const [from, to] = [Math.max(y.os, t.os), Math.min(y.oe, t.oe)];
      if (from >= to || !base.slice(from, to).every((block) => block.kind === 'blank')) continue;
      const n = to - from;
      const [first, second] =
        y.os <= t.os
          ? ([
              [yours, y],
              [theirs, t],
            ] as const)
          : ([
              [theirs, t],
              [yours, y],
            ] as const);
      const [firstSide, a] = first;
      const [secondSide, b] = second;
      const removal = (h: Hunk) => h.xs === h.xe;
      const upward = (k: number) => same(a.os - k, a.oe - k);
      const downward = (k: number) => same(b.os + k - 1, b.oe + k - 1);
      const steps = Array.from({ length: n }, (_, k) => k + 1);
      if (removal(a) && a.oe === to && stayed(firstSide, a.os - n, a.os) && steps.every(upward))
        move(firstSide, a, -n);
      else if (
        removal(b) &&
        b.os === from &&
        stayed(secondSide, b.oe, b.oe + n) &&
        steps.every(downward)
      )
        move(secondSide, b, n);
    }
  }
}

/** `body` with a line ending at its end, if it has any text. */
const ended = (body: string) =>
  body === '' || body.endsWith('\n') ? body : `${body}${body.includes('\r\n') ? '\r\n' : '\n'}`;

const keysOf = (blocks: readonly Block[]) => blocks.map((block) => block.key).join('\u0000');

/**
 * The three-way merge of three bodies (front matter split off) by block.
 * A change from one side is taken, the same change on both once, two
 * additions at the same place both, theirs first, and changes on both
 * sides to the same base blocks are an overlap.
 */
export function mergeBlocks(base: string, yours: string, theirs: string): BlockMerge {
  const o = blocksOf(ended(base));
  const sides = { yours: blocksOf(ended(yours)), theirs: blocksOf(ended(theirs)) };
  const aligned = { yours: align(o, sides.yours), theirs: align(o, sides.theirs) };
  keepApart(o, [aligned.yours, sides.yours], [aligned.theirs, sides.theirs]);
  type Side = keyof typeof sides;
  const all = (['yours', 'theirs'] as const)
    .flatMap((side) => aligned[side].hunks.map((h) => ({ ...h, side })))
    .sort((p, q) => p.os - q.os || p.oe - q.oe);
  // Changes that touch the same base blocks, or add at the same place, go together.
  const groups: { os: number; oe: number; hunks: (Hunk & { side: Side })[] }[] = [];
  for (const h of all) {
    const g = groups.at(-1);
    const sameInsert = g && g.os === g.oe && h.os === h.oe && h.os === g.os;
    if (g && (h.os < g.oe || sameInsert)) {
      g.hunks.push(h);
      g.oe = Math.max(g.oe, h.oe);
    } else groups.push({ os: h.os, oe: h.oe, hunks: [h] });
  }
  // A side's blocks for base blocks `os` to `oe`, its changes there applied.
  const region = (side: Side, hunks: readonly Hunk[], os: number, oe: number) => {
    const { match } = aligned[side];
    const blocks = sides[side];
    const out: Block[] = [];
    let k = os;
    const stayed = (to: number) => {
      for (; k < to; k++) {
        const block = blocks[match[k] ?? -1];
        if (block) out.push(block);
      }
    };
    for (const h of hunks) {
      stayed(h.os);
      out.push(...blocks.slice(h.xs, h.xe));
      k = h.oe;
    }
    stayed(oe);
    return out;
  };
  const segments: Segment[] = [];
  let i = 0;
  const unchanged = (to: number) => {
    if (to <= i) return;
    const theirsThere = region('theirs', [], i, to);
    segments.push({
      base: o.slice(i, to),
      yours: region('yours', [], i, to),
      theirs: theirsThere,
      taken: theirsThere,
      from: 'none',
    });
  };
  for (const g of groups) {
    unchanged(g.os);
    const of = (side: Side) => g.hunks.filter((h) => h.side === side);
    const y = region('yours', of('yours'), g.os, g.oe);
    const t = region('theirs', of('theirs'), g.os, g.oe);
    const at = { base: o.slice(g.os, g.oe), yours: y, theirs: t };
    if (of('theirs').length === 0) segments.push({ ...at, taken: y, from: 'yours' });
    else if (of('yours').length === 0) segments.push({ ...at, taken: t, from: 'theirs' });
    else if (keysOf(y) === keysOf(t)) segments.push({ ...at, taken: t, from: 'both' });
    else if (g.os === g.oe) segments.push({ ...at, taken: union(t, y), from: 'union' });
    else segments.push({ ...at, taken: null, from: 'overlap' });
    i = g.oe;
  }
  unchanged(o.length);
  return { segments, ends: ended(theirs) === theirs, sides };
}

const isReal = (blocks: readonly Block[]) => blocks.some((block) => block.kind !== 'blank');

/**
 * Two additions at one place, theirs first. Blocks both start with, or
 * both end with, appear once, if they hold more than blank lines.
 */
function union(theirs: readonly Block[], yours: readonly Block[]): Block[] {
  let p = 0;
  while (p < theirs.length && p < yours.length && theirs[p]?.key === yours[p]?.key) p++;
  if (!isReal(theirs.slice(0, p))) p = 0;
  let q = 0;
  while (
    q < theirs.length - p &&
    q < yours.length - p &&
    theirs[theirs.length - 1 - q]?.key === yours[yours.length - 1 - q]?.key
  ) {
    q++;
  }
  if (!isReal(theirs.slice(theirs.length - q))) q = 0;
  return [
    ...joined(theirs.slice(0, theirs.length - q), yours.slice(p, yours.length - q)),
    ...theirs.slice(theirs.length - q),
  ];
}

const TIGHT = new Set(['item', 'row']);

/**
 * `left` then `right`, with a blank line between unless one ends or the
 * other starts with one, or both are list items or table rows, so two
 * paragraphs never run into one.
 */
export function joined(left: readonly Block[], right: readonly Block[]): Block[] {
  const last = left.at(-1);
  const first = right[0];
  if (!last || !first || last.kind === 'blank' || first.kind === 'blank')
    return [...left, ...right];
  if (TIGHT.has(last.kind) && last.kind === first.kind) return [...left, ...right];
  // Inside the block quotes both are in, the blank line is a quote's too.
  const depth = Math.min(quoteDepth(last.text), quoteDepth(first.text));
  const quote = Array.from({ length: depth }, () => '>').join(' ');
  return [...left, blankBlock(`${quote}${last.text.endsWith('\r\n') ? '\r\n' : '\n'}`), ...right];
}

// How many block quotes a block's first line starts with.
const quoteDepth = (text: string) =>
  (/^(?:[ \t]*>[ \t]?)*/.exec(text)?.[0] ?? '').split('>').length - 1;

/**
 * How a segment is written: an overlap's choice, and whether it is a pick
 * at a block that didn't fit, which is written exactly as that side has
 * it and taken as it then reads.
 */
export type SegmentPick = { choice: Choice; fit: boolean };

/** A merged body as written, and the segments whose blocks didn't read as chosen. */
export type WrittenBody = {
  body: string;
  /** The indexes of segments with a block that reads differently where it went. */
  unfit: number[];
  /** Each segment's text as written, by index. */
  segments: string[];
};

// A block to write: as chosen, whether its list marker may be adjusted,
// and whether it must read as its key says once written.
type Entry = { block: Block; segment: number; adjust: boolean; check: boolean };

/**
 * The merged body, with overlaps written as `picks` says (by segment
 * index; every overlap needs one), and checked: each block must read as
 * it was chosen, in its place.
 */
export function writeBody(merge: BlockMerge, picks: ReadonlyMap<number, SegmentPick>): WrittenBody {
  const entries: Entry[] = [];
  merge.segments.forEach((segment, index) => {
    const pick = picks.get(index);
    const add = (blocks: readonly Block[], adjust: boolean, check: boolean) => {
      for (const block of blocks) entries.push({ block, segment: index, adjust, check });
    };
    if (!pick) {
      if (!segment.taken) throw new Error('Every overlap needs a choice.');
      // Theirs' own text is in theirs' lists already.
      add(segment.taken, segment.from !== 'none', true);
      return;
    }
    const { choice, fit } = pick;
    if (typeof choice === 'object') {
      // Typed text goes between the blank lines the stretch starts and ends with.
      const around = isReal(segment.yours) ? segment.yours : segment.theirs;
      const [lead, trail] = edges(around);
      add(
        [...lead, ...editBlocks(choice.edit), ...(choice.edit === '' ? [] : trail)],
        false,
        false,
      );
    } else if (choice === 'both') add(joined(segment.theirs, segment.yours), fit, fit);
    else add(segment[choice], fit, fit);
  });
  // Where each block sat on its own side.
  const homes = new Map<Block, { blocks: readonly Block[]; index: number }>();
  for (const blocks of [merge.sides.yours, merge.sides.theirs])
    blocks.forEach((block, index) => homes.set(block, { blocks, index }));
  const written: { text: string; start: number; entry: Entry }[] = [];
  const from = (entry: Entry) => merge.segments[entry.segment]?.from;
  // A block as `side` has it: itself, or the block of `side` it stands for,
  // unchanged or changed one for one.
  const counterpart = (entry: Entry, side: readonly Block[]) => {
    if (homes.get(entry.block)?.blocks === side) return entry.block;
    const segment = merge.segments[entry.segment];
    // Two additions, or two sides' changes at an overlap, stand for nothing of each other.
    if (!segment || segment.from === 'union' || segment.from === 'overlap') return undefined;
    if (segment.yours.length !== segment.theirs.length) return undefined;
    const [mine, other] =
      side === merge.sides.yours
        ? [segment.theirs, segment.yours]
        : [segment.yours, segment.theirs];
    const there = other[mine.indexOf(entry.block)];
    // Only a block of its kind at its depth, as one for one runs pair them.
    const alike =
      there?.kind === entry.block.kind &&
      depthOf(there.place).join() === depthOf(entry.block.place).join();
    return alike ? there : undefined;
  };
  // Whether a later item, as chosen, shows the style of the list `of` lands
  // in: one nobody changed, in its list on its own side, does; to a pick at
  // an overlap, so does the other side's change, which the pick fits
  // itself to. Other changes are passed over, as each is fitted itself;
  // anything else ends the search.
  const ahead =
    (of: Entry) =>
    (later: Entry): 'shows' | 'past' | 'end' => {
      if (!later.check) return 'end';
      const home = homes.get(of.block);
      if (from(later) === 'none') {
        const there = home && counterpart(later, home.blocks);
        return !home || there?.list === of.block.list ? 'shows' : 'end';
      }
      const otherSide = homes.get(later.block)?.blocks !== home?.blocks;
      if (from(of) === 'overlap' && from(later) !== 'overlap' && otherSide) return 'shows';
      return 'past';
    };
  // Whether an earlier item, as written, is in the list `of` lands in:
  // not if, on `of`'s own side, it is in another list.
  const behind = (of: Entry) => (earlier: Entry) => {
    const home = homes.get(of.block);
    const there = home && counterpart(earlier, home.blocks);
    return !there || there.list === of.block.list;
  };
  // An item that now starts its numbered list but didn't start it on its
  // own side starts it at the other side's number, where that side made it
  // the first, as the visual editor renumbers; else at its own list's first
  // number. Where a numbered list starts is read; the other numbers aren't.
  const firstNumbered = (entry: Entry, text: string) => {
    const segment = merge.segments[entry.segment];
    const home = homes.get(entry.block);
    const own = markerOf(text);
    if (!segment || !home || !own || entry.block.kind !== 'item' || !/^\d/.test(own.marker))
      return text;
    const depth = depthOf(entry.block.place);
    // Whether a block is first in its list on its side.
    const first = (block: Block, at: { blocks: readonly Block[]; index: number }) => {
      const before = at.blocks.slice(0, at.index).reverse();
      const near = itemNear(depth, before, (other) => ({ block: other, text: other.text }));
      return near?.block.list !== block.list;
    };
    // Right after text taken as it reads, it keeps its number: what is
    // before it is that text's.
    const before = [...written].reverse().find((w) => w.entry.block.kind !== 'blank');
    if (before && !before.entry.check) return text;
    const earlier = itemNear(depth, [...written].reverse(), (w) => ({
      block: w.entry.block,
      text: w.text,
      entry: w.entry,
    }));
    if ((earlier && behind(entry)(earlier.entry)) || first(entry.block, home)) return text;
    const numberOf = (block: Block | undefined) =>
      /^\d+/.exec(markerOf(block?.text ?? '')?.marker ?? '')?.[0];
    // Its version on the other side: the same block, or the one it changed one for one.
    const [mine, other] =
      home.blocks === merge.sides.yours
        ? [segment.yours, segment.theirs]
        : [segment.theirs, segment.yours];
    const there = mine.length === other.length ? other[mine.indexOf(entry.block)] : undefined;
    const away = there && homes.get(there);
    const number =
      (there?.kind === 'item' && away && first(there, away) ? numberOf(there) : undefined) ??
      numberOf(home.blocks.find((block) => block.list === entry.block.list));
    if (number === undefined) return text;
    // That number, in its own list's delimiter.
    const head = own.quote + own.indent + own.marker;
    return own.quote + own.indent + number + own.marker.slice(-1) + text.slice(head.length);
  };
  entries.forEach((entry, i) => {
    const text = entry.adjust
      ? adjusted(entry.block, written, entries.slice(i + 1), {
          ahead: ahead(entry),
          behind: behind(entry),
          home: homes.get(entry.block),
        })
      : entry.block.text;
    written.push({ text: entry.check ? firstNumbered(entry, text) : text, start: 0, entry });
  });
  realignTables(merge, written);
  let at = 0;
  for (const w of written) {
    w.start = at;
    at += w.text.length;
  }
  const body = written.map(({ text }) => text).join('');
  // Read it again: each block at its place must read as it was chosen.
  const read = new Map<number, Block>();
  let offset = 0;
  for (const block of blocksOf(body)) {
    read.set(offset, block);
    offset += block.text.length;
  }
  const unfit = new Set<number>();
  const order = written.map((w) => w.entry);
  for (const { start, entry } of written) {
    if (!entry.check || entry.block.kind === 'blank') continue;
    if (read.get(start)?.key === entry.block.key) continue;
    const segment = blamed(merge, order, entry);
    if (segment !== null) unfit.add(segment);
  }
  // And each item with the item before it in one list, or in two, as on
  // the sides they came from: block keys don't say which list it is.
  // How the sides that have both group them: one change can join two
  // lists or split one, so either side's grouping is right.
  const groupings = (x: Entry, y: Entry) => {
    const found = [merge.sides.yours, merge.sides.theirs].flatMap((side) => {
      const [cx, cy] = [counterpart(x, side), counterpart(y, side)];
      return cx && cy ? [cx.list === cy.list] : [];
    });
    // Neither side has both: items of one kind make one list, of two kinds two.
    const kind = (entry: Entry) => entry.block.place.at(-1);
    return found.length > 0 ? found : [JSON.stringify(kind(x)) === JSON.stringify(kind(y))];
  };
  written.forEach(({ start, entry }, i) => {
    if (!entry.check || entry.block.kind !== 'item') return;
    const back = written.slice(0, i).reverse();
    const near = itemNear(depthOf(entry.block.place), back, (w) =>
      w.entry.check ? { block: w.entry.block, text: w.text, w } : null,
    );
    if (!near) return;
    const [was, now] = [read.get(near.w.start), read.get(start)];
    if (!was || !now || groupings(near.w.entry, entry).includes(was.list === now.list)) return;
    const changed = [entry, near.w.entry].find((e) => from(e) !== 'none');
    const segment = changed ? changed.segment : blamed(merge, order, entry);
    if (segment !== null) unfit.add(segment);
  });
  // And each nested item under the item it is under on a side that has
  // it, which block keys don't say either.
  written.forEach(({ entry }, i) => {
    if (!entry.check || entry.block.kind !== 'item') return;
    const depth = depthOf(entry.block.place);
    const lists = depth.flatMap((part, k) => (part === 'list' ? [k] : []));
    const outer = lists.at(-2);
    if (outer === undefined) return;
    const parentDepth = depth.slice(0, outer + 1);
    const parent = itemNear(parentDepth, written.slice(0, i).reverse(), (w) =>
      w.entry.check ? { block: w.entry.block, text: w.text, entry: w.entry } : null,
    );
    if (!parent) return;
    const sides = [merge.sides.yours, merge.sides.theirs].flatMap((side) => {
      const version = counterpart(entry, side);
      const at = version ? homes.get(version)?.index : undefined;
      if (at === undefined) return [];
      const before = side.slice(0, at).reverse();
      const there = itemNear(parentDepth, before, (block) => ({ block, text: block.text }));
      if (!there) return [];
      // A parent changed with blocks added or taken out beside it stands for
      // nothing one for one: it is the item's parent if that is in its stretch.
      const stands = counterpart(parent.entry, side);
      const segment = merge.segments[parent.entry.segment];
      const stretch = side === merge.sides.yours ? segment?.yours : segment?.theirs;
      return [stands ? stands === there.block : (stretch?.includes(there.block) ?? false)];
    });
    if (sides.length === 0 || sides.includes(true)) return;
    const changed = [entry, parent.entry].find((e) => from(e) !== 'none');
    const segment = changed ? changed.segment : blamed(merge, order, entry);
    if (segment !== null) unfit.add(segment);
  });
  const segments = merge.segments.map(() => '');
  for (const { text, entry } of written) segments[entry.segment] += text;
  return { body: merge.ends ? body : body.replace(/\r?\n$/, ''), unfit: [...unfit], segments };
}

// An unchanged block that reads differently was changed by a change near
// it: the nearest changed block as written, after it first. Next to text
// taken as it reads (an edit, or a pick where a block didn't fit), it is
// taken as it reads too: null.
function blamed(merge: BlockMerge, entries: readonly Entry[], entry: Entry): number | null {
  const changed = (other: Entry | undefined) =>
    other !== undefined && merge.segments[other.segment]?.from !== 'none';
  if (changed(entry)) return entry.segment;
  const at = entries.indexOf(entry);
  for (let d = 1; d < entries.length; d++) {
    for (const other of [entries[at + d], entries[at - d]])
      if (other && changed(other)) return other.check ? other.segment : null;
  }
  return null;
}

/** The blank lines `blocks` start with, and those they end with after. */
export function edges(blocks: readonly Block[]): [Block[], Block[]] {
  const first = blocks.findIndex((block) => block.kind !== 'blank');
  if (first < 0) return [[...blocks], []];
  let last = blocks.length;
  while (blocks[last - 1]?.kind === 'blank') last--;
  return [blocks.slice(0, first), blocks.slice(last)];
}

// Tables

/**
 * Each table that took rows from both sides written aligned again, if
 * theirs' rows of it were, only so it reads well in the source editor.
 */
function realignTables(merge: BlockMerge, written: { text: string; entry: Entry }[]) {
  const theirs = (entry: Entry) =>
    merge.segments[entry.segment]?.theirs.includes(entry.block) ?? false;
  for (let start = 0; start < written.length; start++) {
    if (written[start]?.entry.block.kind !== 'table') continue;
    let end = start + 1;
    while (written[end]?.entry.block.kind === 'row') end++;
    const table = written.slice(start, end);
    start = end - 1;
    if (!table.every(({ entry }) => entry.check)) continue;
    const ours = table.filter(({ entry }) => theirs(entry));
    if (ours.length === table.length || !aligned(ours.flatMap(({ text }) => linesOf(text))))
      continue;
    const lines = realigned(table.flatMap(({ text }) => linesOf(text)));
    if (!lines) continue;
    // The header block's two lines, then a line for each row.
    let line = 0;
    for (const w of table) {
      const count = linesOf(w.text).length;
      w.text = lines.slice(line, (line += count)).join('');
    }
  }
}

// A row's line: its quote markers and indentation, its cells, its line ending.
const ROW = /^((?:[ \t]*>[ \t]?)*[ \t]*)(.*?)(\r?\n?)$/;
const cellsOf = (row: string) =>
  row
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
// Characters as a person counts them, so an emoji is one.
const graphemes = new Intl.Segmenter();
const widthOf = (text: string) => [...graphemes.segment(text)].length;

// Whether a table's lines, at least two, are all as wide, as an aligned table's are.
function aligned(lines: readonly string[]): boolean {
  const widths = new Set(lines.map((line) => widthOf(line.replace(/\r?\n$/, ''))));
  return lines.length >= 2 && widths.size === 1;
}

// A table's lines, header and delimiter rows first, with every column as
// wide as its widest cell; null if one isn't a row.
function realigned(lines: readonly string[]): string[] | null {
  const rows = lines.map((line) => ROW.exec(line));
  if (rows.some((row) => !row || !row[2]?.includes('|'))) return null;
  const cells = rows.map((row) => cellsOf(row?.[2] ?? ''));
  const widths: number[] = [];
  cells.forEach((row, r) => {
    if (r === 1) return;
    row.forEach((cell, c) => (widths[c] = Math.max(widths[c] ?? 3, widthOf(cell))));
  });
  return cells.map((row, r) => {
    const written = row.map((cell, c) => {
      const width = widths[c] ?? 3;
      if (r !== 1) return cell + ' '.repeat(width - widthOf(cell));
      const [left, right] = [cell.startsWith(':'), cell.endsWith(':') && cell.length > 1];
      return `${left ? ':' : ''}${'-'.repeat(width - (left ? 1 : 0) - (right ? 1 : 0))}${right ? ':' : ''}`;
    });
    return `${rows[r]?.[1] ?? ''}| ${written.join(' | ')} |${rows[r]?.[3] ?? ''}`;
  });
}

// Text typed at an overlap, as blocks to write as typed.
function editBlocks(text: string): Block[] {
  if (text === '') return [];
  return [{ ...blankBlock(ended(text)), key: 'edit', kind: 'other' }];
}

// Lists

// An item's first line: the block quote markers before it, its
// indentation, its marker, and the spaces after the marker.
const ITEM = /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-+*]|\d{1,9}[.)])([ \t]*)/;

type Marker = { quote: string; indent: string; marker: string; gap: string };

function markerOf(text: string): Marker | null {
  const match = ITEM.exec(text);
  if (!match) return null;
  const [, quote = '', indent = '', marker = '', gap = ''] = match;
  return { quote, indent, marker, gap };
}

// How many columns an indentation takes, tabs to the next multiple of 4.
const columns = (indent: string) =>
  indent.split('').reduce((at, char) => (char === '\t' ? at + 4 - (at % 4) : at + 1), 0);

// Where an item's content starts, after its quote markers.
const contentColumn = ({ indent, marker, gap }: Marker) =>
  columns(indent) + marker.length + (gap.length > 4 ? 1 : gap.length);

// A place with whether each list is bulleted or numbered left out: lists
// at the same depth match whatever their kind.
const depthOf = (place: readonly Container[]) =>
  place.map((container) => (container.kind === 'list' ? 'list' : JSON.stringify(container)));

const startsWith = (long: readonly string[], short: readonly string[]) =>
  short.every((part, i) => long[i] === part);

/**
 * The nearest item of the list `block` lands in, among `blocks` in the
 * order to look at them: past blank lines, and the blocks inside items of
 * that list, up to anything else.
 */
function itemNear<T, Found extends { block: Block; text: string }>(
  depth: readonly string[],
  blocks: Iterable<T>,
  blockOf: (t: T) => Found | null,
): Found | null {
  for (const t of blocks) {
    const found = blockOf(t);
    if (!found) return null;
    const { block } = found;
    if (block.kind === 'blank') continue;
    const there = depthOf(block.place);
    if (block.kind === 'item' && there.length === depth.length && startsWith(there, depth))
      return found;
    if (there.length >= depth.length && startsWith(there, depth)) continue;
    return null;
  }
  return null;
}

/**
 * A list item written with the bullet or number style (`-`, `*` or `+`;
 * `.` or `)`), and the indentation for its depth, of the list it lands
 * in: that of its nearest item at that depth, before it as written or else
 * after it as chosen. An item that, on its own side, started or ended its
 * list, or sat beside a list of the other kind, doesn't join a list that
 * way. A nested item's indentation must also put it under its parent as
 * written: else its own, or else its parent's content column.
 */
function adjusted(
  block: Block,
  before: readonly { text: string; entry: Entry }[],
  after: readonly Entry[],
  {
    ahead,
    behind,
    home,
  }: {
    ahead: (later: Entry) => 'shows' | 'past' | 'end';
    behind: (earlier: Entry) => boolean;
    home: { blocks: readonly Block[]; index: number } | undefined;
  },
): string {
  if (block.kind !== 'item') return block.text;
  const own = markerOf(block.text);
  if (!own) return block.text;
  const depth = depthOf(block.place);
  const back = [...before].reverse();
  const asWritten = (w: { text: string; entry: Entry }) =>
    w.entry.check ? { block: w.entry.block, text: w.text } : null;
  const asChosen = (e: Entry) => (e.check ? { block: e.block, text: e.block.text } : null);
  // The later blocks, past changed items, up to one that shows the list's style.
  const shown = function* () {
    for (const later of after) {
      const item =
        later.block.kind === 'item' && depthOf(later.block.place).join() === depth.join();
      const verdict = item ? ahead(later) : 'shows';
      if (verdict === 'end') return;
      if (verdict === 'shows') yield later;
    }
  };
  // On its own side, whether its list goes on that way.
  const joins = (blocks: readonly Block[]) => {
    if (!home) return true;
    const found = itemNear(depth, blocks, (other) => ({ block: other, text: other.text }));
    const theirs = found && markerOf(found.text);
    // A new bullet character, or number delimiter, starts a new list.
    return (
      !!theirs &&
      JSON.stringify(found.block.place) === JSON.stringify(block.place) &&
      theirs.marker.slice(-1) === own.marker.slice(-1)
    );
  };
  const earlier =
    home && !joins(home.blocks.slice(0, home.index).reverse())
      ? null
      : itemNear(depth, back, (w) => (w.entry.check ? { ...w, block: w.entry.block } : null));
  const previous = earlier && behind(earlier.entry) ? earlier : null;
  const next =
    previous || (home && !joins(home.blocks.slice(home.index + 1)))
      ? null
      : itemNear(depth, shown(), asChosen);
  const parent = depth.length > 1 ? itemNear(depth.slice(0, -1), back, asWritten) : null;
  const under = parent && markerOf(parent.text);
  const nests = (indent: string) =>
    !under ||
    (columns(indent) >= contentColumn(under) && columns(indent) < contentColumn(under) + 4);
  const near = markerOf((previous ?? next)?.text ?? '');
  let marker = own.marker;
  if (near) {
    // A numbered item keeps its number, which only the first one's is read
    // for; a bullet in a numbered list takes the one after the item before
    // it, or the one before the item after it.
    const theirs = /^\d+/.exec(near.marker)?.[0];
    const mine = /^\d+/.exec(own.marker)?.[0];
    const number = mine ?? String(previous ? Number(theirs) + 1 : Math.max(1, Number(theirs) - 1));
    marker = theirs === undefined ? near.marker : `${number}${near.marker.slice(-1)}`;
  }
  const indent =
    [near?.indent ?? own.indent, own.indent].find(nests) ??
    (under ? ' '.repeat(contentColumn(under)) : own.indent);
  if (indent === own.indent && marker === own.marker) return block.text;
  const fresh = { ...own, indent, marker };
  const [first = '', ...rest] = linesOf(block.text);
  const shift = contentColumn(fresh) - contentColumn(own);
  const head =
    own.quote +
    indent +
    marker +
    own.gap +
    first.slice((own.quote + own.indent + own.marker + own.gap).length);
  return head + rest.map((line) => shifted(line, own, shift)).join('');
}

// A continuation line of an item, moved with its item's content.
function shifted(line: string, own: Marker, shift: number): string {
  if (shift === 0 || !line.startsWith(own.quote)) return line;
  const after = line.slice(own.quote.length);
  const spaces = /^ */.exec(after)?.[0].length ?? 0;
  if (spaces < contentColumn(own) || after.trim() === '') return line;
  return own.quote + ' '.repeat(spaces + shift) + after.slice(spaces);
}
