import type { Node } from '@milkdown/kit/prose/model';
import { Transform } from '@milkdown/kit/prose/transform';
import { normalizeIdentifier } from 'micromark-util-normalize-identifier';
import { writingLiterals, type Transformer } from './config';
import { ending, endsInLine, shownOf, withLf, writesAsShown } from './fidelity';
import type { Run } from './blocks';
import { rawPlace, type Source, type Span } from './sources';

/** A document as Markdown, and whether that reads back as the document. */
export type Written = { markdown: string; faithful: boolean };

/**
 * Where a unit is in the source (`Source`): the source's top-level blocks
 * it is, unedited, by index, and their text there, from the first's start
 * to the last's end, line breaks as the page has them.
 */
type Sourced = { readonly first: number; readonly last: number; readonly raw: string };

/**
 * Top-level blocks written and checked together: one, or lists next to
 * each other, which remark writes with different bullets so Markdown
 * doesn't read them as one; with the empty paragraphs after it, which
 * write as nothing.
 */
type Unit = {
  readonly nodes: readonly Node[];
  /** As written alone, with no final line break, empty if it writes as nothing; null if it can't be. */
  readonly markdown: string | null;
  /** Whether its autolinks are written as their literals. */
  readonly literals: boolean;
  /** What each of its blocks shows, as `writesAsShown` compares them, empty paragraphs left out. */
  readonly shown: readonly string[];
  /** The footnotes it names but doesn't define, by label as matched, as written. */
  readonly names: ReadonlyMap<string, string>;
  readonly defines: ReadonlySet<string>;
  /** Whether it reads as it shows, alone or beside others. */
  readonly faithful: boolean;
  /** Where it is in the source, if it's blocks of it unedited, written as they are there. */
  readonly sourced: Sourced | null;
};

type Draft = Omit<Unit, 'faithful' | 'sourced'>;

/** The source a writer writes blocks of as they are there, with what's known of it. */
type Base = {
  readonly source: Source;
  readonly nodes: readonly Node[];
  readonly index: WeakMap<Node, number>;
  /** Whether its text ends in a line break. */
  readonly final: boolean;
  /** Units made of its blocks, by the first. */
  readonly units: WeakMap<Node, Unit[]>;
};

/** A writing laid out: where each run that writes as something is in it. */
type Laid = {
  readonly run: number;
  /** In the page's text (`page`). */
  readonly from: number;
  readonly to: number;
  /** In the Markdown, with LF line breaks. */
  readonly at: number;
};

type Composed = Written & {
  /** As the page holds it: the source's text where it's kept, its line break elsewhere. */
  readonly page: string;
  readonly laid: readonly Laid[];
};

/**
 * A document's units as far as they're made, and its writing once they
 * all are, with a final line break or without; and for each run, the
 * blocks of the source it is, if it is.
 */
type Progress = {
  base: Base | null;
  runs: Node[][];
  places: (readonly [number, number] | null)[];
  /** For each run, the block of the source it starts in place of: the one after the last before it. */
  slots: number[];
  units: (Unit | undefined)[];
  done: boolean;
  written: Map<boolean, Composed>;
};

const LISTS = new Set(['bullet_list', 'ordered_list']);

const blank = (node: Node) => node.type.name === 'paragraph' && node.content.size === 0;

// `doc`'s top-level blocks, as units are made of them. Empty paragraphs
// starting the document go with the block after them.
function groups(doc: Node): Node[][] {
  const found: Node[][] = [];
  doc.forEach((node) => {
    const run = found.at(-1);
    const last = run?.findLast((block) => !blank(block));
    const lists = !!last && LISTS.has(last.type.name) && LISTS.has(node.type.name);
    if (run && (blank(node) || !last || lists)) run.push(node);
    else found.push([node]);
  });
  return found;
}

// Units that write as something, which are the ones next to each other in a writing.
const writing = (units: readonly Unit[]) => units.filter((unit) => unit.markdown !== '');

const sizeOf = (nodes: readonly Node[]) => nodes.reduce((sum, node) => sum + node.nodeSize, 0);

// A paragraph of a private-use character written before each unit and
// after the last, so each is written as it is alone, with no final line
// break added, and they can be told apart, even one written as nothing.
const MARK = '';
const AROUND = /^\n\n([^]*)\n\n$/;

// Where `caret` puts the cursor, written: another private-use character,
// which no writing escapes.
const CARET = '';

// Units kept for each block they start with.
const KEPT = 4;

// Units new together are written and read in batches about this big, a
// few to a slice of idle time.
const BATCH = 300;

// What each of `nodes` shows, empty paragraphs left out.
function shownIn(nodes: readonly Node[]): string[] {
  return nodes.flatMap((node) => {
    const shown = shownOf(node);
    return shown ? [JSON.stringify(shown)] : [];
  });
}

// The footnotes `nodes` define, and those they name but don't.
function footnotesOf(nodes: readonly Node[]) {
  const named = new Map<string, string>();
  const defines = new Set<string>();
  const note = (node: Node) => {
    const label = String(node.attrs['label']);
    if (node.type.name === 'footnote_reference') named.set(normalizeIdentifier(label), label);
    if (node.type.name === 'footnote_definition') defines.add(normalizeIdentifier(label));
  };
  for (const node of nodes) {
    note(node);
    node.descendants(note);
  }
  return { names: new Map([...named].filter(([label]) => !defines.has(label))), defines };
}

// Text between blocks that parts them as the editor's blank line does:
// blank lines, the next block starting its line.
const BLANK_LINES = /^[ \t]*\n(?:[ \t]*\n)+$/;

// `page`, with a final line break `lineBreak` if `final`, else with none.
function pageEnding(page: string, final: boolean, lineBreak: string): string {
  if (!final) return page.replace(/\r?\n$/, '');
  return page && !/\n$/.test(page) ? `${page}${lineBreak}` : page;
}

/**
 * The visual editor's writing of documents as Markdown, checked as it goes
 * (`writesAsShown`) a top-level block at a time, so an edit costs the
 * blocks it changed, not the page. ProseMirror keeps each block an edit
 * left alone, so what's known of it is kept for as long as it is.
 *
 * Given the text a document was read from and where its blocks are in it
 * (`source`), the blocks nobody has edited since are written as they are
 * there, byte for byte, and the text between two that were next to each
 * other there too: only what was edited is written in the editor's style.
 * What was read from the text reads back as it, so it needn't be read
 * again but beside a block written anew.
 *
 * Blank lines part the blocks, so Markdown reads each as it reads it alone,
 * except where one reaches into the next: HTML left open (`<!--`) takes
 * what follows, a list takes another, an indented line joins an item; and
 * a footnote reference reads as one only if the page defines it. So blocks
 * are read with those next to them, with stubs for the footnotes they name,
 * until each pair next to each other has been read together; and every
 * footnote named must be defined. The last is read as the writing ends,
 * with its final line break or without, which HTML left open (`<pre>`)
 * takes in. A document that doesn't pass is read whole, which decides; and
 * if it doesn't read as it shows with its blocks as their source, written
 * whole in the editor's style, which may.
 *
 * An autolink is written as the literal it was typed as, `www.x.org`, if
 * its block then reads as it shows; otherwise as `<…>` or `[…](…)`.
 *
 * Blocks a document doesn't share with another, as those a paste changed,
 * can be read back alone (`check`).
 */
export class Writer {
  readonly #parse: Transformer['parse'];
  readonly #serialize: Transformer['serialize'];
  // The last units made starting with each block, the units after each
  // that it was read with, and each document's progress. A block can be in
  // a document twice, as a copy dragged is, each time in a unit of its own,
  // and a unit can be before more than one.
  readonly #units = new WeakMap<Node, Unit[]>();
  readonly #pairs = new WeakMap<Unit, WeakMap<Unit, boolean>>();
  // Whether each unit read last, with a final line break or without, reads as it shows.
  readonly #endings = new WeakMap<Unit, Map<boolean, boolean>>();
  readonly #progress = new WeakMap<Node, Progress>();
  #base: Base | null = null;

  constructor({ parse, serialize }: Transformer) {
    this.#parse = parse;
    this.#serialize = serialize;
  }

  /**
   * Write the blocks of documents that `source` has, unedited, as they are
   * in its text, from now on: the text a document was last given as. With
   * none, every block is written in the editor's style.
   */
  source(source: Source | null) {
    if (!source) return void (this.#base = null);
    const nodes = [...source.doc.content.content];
    const index = new WeakMap<Node, number>();
    for (const [i, node] of nodes.entries()) if (!index.has(node)) index.set(node, i);
    this.#base = {
      source,
      nodes,
      index,
      final: endsInLine(source.text),
      units: new WeakMap(),
    };
  }

  /**
   * Work towards writing `doc`, a batch of blocks at a time, while `more`
   * says there's time, at least once; true once there's nothing left.
   */
  prepare(doc: Node, more: () => boolean): boolean {
    let worked = false;
    const step = () => {
      const go = !worked || more();
      worked = true;
      return go;
    };
    const progress = this.#progressOf(doc);
    if (progress.done) return true;
    const { runs, units } = progress;
    const known = (i: number) => this.#known(progress, i);
    for (let i = 0; i < runs.length;) {
      if (known(i)) {
        i++;
        continue;
      }
      let j = i;
      for (let size = 0; j < runs.length && !known(j) && (j === i || size < BATCH); j++)
        size += sizeOf(runs[j] ?? []);
      if (!step()) return false;
      units.splice(i, j - i, ...this.#batch(runs.slice(i, j), units[i - 1], units[j]));
      i = j;
    }
    // Pairs no batch read together, as two a deleted block parted.
    const written = writing(units.filter((unit) => unit !== undefined));
    for (let i = 1; i < written.length; i++) {
      const [a, b] = [written[i - 1], written[i]];
      if (!a?.faithful || !b?.faithful || this.#together(a, b) !== undefined) continue;
      if (!step()) return false;
      this.#reads([a, b]);
    }
    progress.done = true;
    return true;
  }

  /** Whether `prepare` is done with `doc`. */
  ready(doc: Node): boolean {
    return this.#progressOf(doc).done;
  }

  /**
   * Whether the blocks of `doc` that `base` doesn't have read back as they
   * show, with those beside them, reading only those, the last as a
   * writing with a final line break ends; true if there are none. What it
   * reads, `prepare` needn't.
   */
  check(doc: Node, base: Node): boolean {
    const progress = this.#progressOf(doc);
    const { runs, units } = progress;
    const given = new Set<Node>();
    base.forEach((node) => given.add(node));
    // A unit of each run that's to be read, made now if need be.
    const unit = (i: number) =>
      (units[i] ??= this.#known(progress, i) ?? this.#make(runs[i] ?? []));
    // The nearest run on each side of `i` that writes as something.
    const beside = (i: number, step: -1 | 1) => {
      for (let j = i + step; j >= 0 && j < runs.length; j += step)
        if (unit(j).markdown !== '') return j;
      return null;
    };
    const names = new Map<string, string>();
    let faithful = true;
    let end: number | null | undefined;
    for (const [i, nodes] of runs.entries()) {
      if (nodes.every((node) => given.has(node))) continue;
      const near = [beside(i, -1), i, beside(i, 1)].filter((j) => j !== null);
      end ??= beside(runs.length, -1);
      if (end !== null && near.includes(end)) faithful &&= this.#endsAs(unit(end), true);
      const read = writing(near.map(unit));
      for (const [label, written] of unit(i).names) names.set(label, written);
      faithful &&= read.every((u) => u.faithful) && unit(i).faithful;
      for (let k = 1; k < read.length && faithful; k++) {
        const [a, b] = [read[k - 1], read[k]];
        if (a && b) faithful = this.#together(a, b) ?? this.#reads([a, b]);
      }
      if (!faithful) return false;
    }
    if (names.size === 0) return true;
    const { defines } = footnotesOf([...doc.content.content]);
    return [...names.keys()].every((label) => defines.has(label));
  }

  /**
   * `doc` as Markdown, with a final line break if `final`, and whether
   * exactly that reads back as it, doing now whatever `prepare` hasn't.
   * Its line breaks are LF; the page holds it as `page` gives it.
   */
  write(doc: Node, final = true): Written {
    const { markdown, faithful } = this.#composed(doc, final);
    return { markdown, faithful };
  }

  /**
   * `doc` as the page holds it, written as `write` writes it: blocks kept
   * from the source as they are there, the rest in the source's line break.
   */
  page(doc: Node, final = true): string {
    return this.#composed(doc, final).page;
  }

  /**
   * `doc`'s `page`, with where each run of its top-level blocks that
   * writes as something is in it, and each block: null for one that
   * writes as nothing, or is written with others, as lists next to each
   * other are, which can't be told apart there.
   */
  layout(doc: Node, final = true): { page: string; runs: Run[]; spans: (Span | null)[] } {
    const { laid, page } = this.#composed(doc, final);
    const { runs, units } = this.#progressOf(doc);
    const there = this.#base?.source.spans ?? [];
    const spans: (Span | null)[] = [];
    const placed: Run[] = [];
    let next = 0;
    for (const [i, nodes] of runs.entries()) {
      const place = laid[next]?.run === i ? laid[next++] : undefined;
      if (place)
        placed.push({ first: spans.length, count: nodes.length, from: place.from, to: place.to });
      const shown = nodes.filter((node) => !blank(node));
      // Each block of a unit as its source is where it was there, as far
      // from the unit's start.
      const kept = units[i]?.sourced;
      const start = kept ? there[kept.first]?.from : undefined;
      for (const node of nodes) {
        const span = kept && start !== undefined ? there[kept.first + shown.indexOf(node)] : null;
        if (!place || blank(node)) spans.push(null);
        else if (shown.length === 1) spans.push({ from: place.from, to: place.to });
        else if (span && start !== undefined)
          spans.push({ from: place.from + span.from - start, to: place.from + span.to - start });
        else spans.push(null);
      }
    }
    return { page, runs: placed, spans };
  }

  /**
   * Where `pos` in `doc` is in its `page`, or null if that can't be told,
   * as before `prepare` is done with it.
   */
  caret(doc: Node, pos: number, final = true): number | null {
    if (!this.ready(doc)) return null;
    const { laid, page } = this.#composed(doc, final);
    // Written whole, as no block alone would read as it shows.
    if (laid.length === 0 && page !== '') return null;
    const { runs, units } = this.#progressOf(doc);
    const lineBreak = this.#base?.source.lineBreak ?? '\n';
    let start = 0;
    let at = 0;
    let next = 0;
    for (const [i, nodes] of runs.entries()) {
      const unit = units[i];
      const place = laid[next]?.run === i ? laid[next++] : undefined;
      if (typeof unit?.markdown !== 'string') return null;
      if (place) at = place.from;
      const size = sizeOf(nodes);
      if (pos <= start + size) {
        if (!place) return at;
        const within = this.#within(unit, nodes, pos - start);
        if (within === null) return place.from;
        const raw = unit.sourced
          ? rawPlace(unit.sourced.raw, within)
          : within +
            (lineBreak.length - 1) * (unit.markdown.slice(0, within).split('\n').length - 1);
        return Math.min(place.from + raw, place.to);
      }
      if (place) at = place.to;
      start += size;
    }
    return Math.min(at, page.length);
  }

  // Where `pos`, in `nodes` as a document of their own, is in `unit`'s
  // Markdown: as written again with the cursor in it; for a unit as its
  // source, just after the text before it there, found in turn.
  #within(unit: Unit, nodes: readonly Node[], pos: number): number | null {
    const markdown = unit.markdown ?? '';
    const marked = new Transform(this.#doc([nodes]));
    const at = pos + (marked.doc.firstChild?.nodeSize ?? 0);
    if (unit.sourced) {
      const before = marked.doc.textBetween(marked.doc.firstChild?.nodeSize ?? 0, at, '\n', ' ');
      let found = 0;
      for (const char of before) {
        if (/\s/.test(char)) continue;
        const next = markdown.indexOf(char, found);
        if (next < 0) break;
        found = next + char.length;
      }
      return found;
    }
    try {
      marked.replaceWith(at, at, marked.doc.type.schema.text(CARET));
    } catch {
      return null;
    }
    // Without the paragraphs around it, written again with the cursor in it.
    const blocks = marked.doc.content.content.slice(1, -1);
    const [written] = this.#alone([blocks], unit.literals) ?? [];
    const caret = written?.indexOf(CARET) ?? 0;
    return Math.max(0, Math.min(caret, markdown.length));
  }

  #composed(doc: Node, final: boolean): Composed {
    const progress = this.#progressOf(doc);
    const known = progress.written.get(final);
    if (known) return known;
    this.prepare(doc, () => true);
    const base = progress.base;
    const { units } = progress;
    let composed: Composed;
    if (units.some((unit) => typeof unit?.markdown !== 'string')) {
      composed = this.#whole(doc, final, false);
    } else {
      composed = this.#joined(doc, progress, base, final);
      // With its blocks as their source, it may not read as it shows where
      // the editor's own writing of them all would.
      if (!composed.faithful && units.some((unit) => unit?.sourced))
        composed = this.#whole(doc, final, true) ?? composed;
    }
    progress.written.set(final, composed);
    return composed;
  }

  // `doc` written whole in the editor's style, and whether that reads as it
  // shows; if `only`, null unless it does.
  #whole(doc: Node, final: boolean, only: true): Composed | null;
  #whole(doc: Node, final: boolean, only: false): Composed;
  #whole(doc: Node, final: boolean, only: boolean): Composed | null {
    const markdown = ending(
      only ? writingLiterals(() => this.#serialize(doc)).written : this.#serialize(doc),
      final,
    );
    const faithful = writesAsShown(doc, markdown, this.#parse);
    if (only && !faithful) return null;
    const lineBreak = this.#base?.source.lineBreak ?? '\n';
    const page = lineBreak === '\n' ? markdown : markdown.replaceAll('\n', lineBreak);
    return { markdown, faithful, page, laid: [] };
  }

  // The units of `progress` one after another, those as their source with
  // the text that was between them there, if they were next to each other.
  #joined(doc: Node, progress: Progress, base: Base | null, final: boolean): Composed {
    const { units } = progress;
    const lineBreak = base?.source.lineBreak ?? '\n';
    const anew = (markdown: string) =>
      lineBreak === '\n' ? markdown : markdown.replaceAll('\n', lineBreak);
    const laid: Laid[] = [];
    let markdown = '';
    let page = '';
    let before: Unit | undefined;
    let place = -1;
    let last: Unit | undefined;
    const text = base?.source.text ?? '';
    const spans = base?.source.spans ?? [];
    for (const [run, unit] of units.entries()) {
      if (!unit || unit.markdown === '' || unit.markdown === null) continue;
      // The page's own text before it: what was before its first block, or
      // between it and the one before.
      let between: string | null = null;
      if (!before) {
        const first = spans[0];
        between = unit.sourced?.first === 0 && first ? text.slice(0, first.from) : '';
      } else {
        // Where it was there, as two blocks next to each other there, or
        // one in place of a block next to the other: written anew, only
        // where that's blank lines, which read as the editor's would.
        const was = before.sourced?.last ?? progress.slots[place] ?? -1;
        const now = unit.sourced?.first ?? progress.slots[run] ?? -1;
        const [a, b] = [spans[was], spans[was + 1]];
        const gap = a && b && was + 1 === now ? text.slice(a.to, b.from) : null;
        if (gap !== null && ((before.sourced && unit.sourced) || BLANK_LINES.test(withLf(gap))))
          between = gap;
      }
      markdown += between === null ? '\n\n' : withLf(between);
      page += between ?? `${lineBreak}${lineBreak}`;
      const from = page.length;
      laid.push({
        run,
        from,
        to: from + (unit.sourced?.raw ?? anew(unit.markdown)).length,
        at: markdown.length,
      });
      markdown += unit.markdown;
      page += unit.sourced?.raw ?? anew(unit.markdown);
      before = unit;
      place = run;
      last = unit;
    }
    // The page's own ending, if it ends with the source's last block.
    const lastSpan = spans.at(-1);
    const ends =
      !!base && !!last?.sourced && last.sourced.last === spans.length - 1 && final === base.final;
    if (ends && lastSpan) {
      const after = text.slice(lastSpan.to);
      markdown += withLf(after);
      page += after;
    } else {
      markdown = ending(markdown, final);
      page = pageEnding(page, final, lineBreak);
    }
    const parts = writing(units.filter((unit) => unit !== undefined));
    const defined = new Set(units.flatMap((unit) => [...(unit?.defines ?? [])]));
    const named = units.every((unit) =>
      [...(unit?.names.keys() ?? [])].every((label) => defined.has(label)),
    );
    const end = parts.at(-1);
    let faithful =
      named &&
      (!end || ends || this.#ends(end, final)) &&
      units.every((unit) => unit?.faithful) &&
      parts.every((unit, i) => {
        const before = parts[i - 1];
        return !before || this.#together(before, unit) === true;
      });
    // What its parts can't vouch for, the whole may still: reading it decides.
    faithful ||= writesAsShown(doc, markdown, this.#parse);
    return { markdown, faithful, page, laid };
  }

  #progressOf(doc: Node): Progress {
    let progress = this.#progress.get(doc);
    if (!progress || progress.base !== this.#base) {
      const runs = groups(doc);
      const base = this.#base;
      const { places, slots } = base
        ? placesOf(base, runs)
        : { places: runs.map(() => null), slots: runs.map(() => -1) };
      progress = { base, runs, places, slots, units: [], done: false, written: new Map() };
      for (const i of runs.keys()) this.#known(progress, i);
      this.#progress.set(doc, progress);
    }
    return progress;
  }

  // The unit of `progress`'s run at `i` as its source, if it is blocks of
  // it unedited, which are next to each other there.
  #sourced({ base, runs, places }: Progress, i: number): Unit | undefined {
    const place = places[i];
    const nodes = runs[i];
    if (!base || !place || !nodes) return undefined;
    const [first, last] = place;
    const [node] = nodes;
    const kept = node && base.units.get(node);
    const known = kept?.find(
      (unit) =>
        unit.sourced?.first === first &&
        unit.nodes.length === nodes.length &&
        unit.nodes.every((n, k) => n === nodes[k]),
    );
    if (known) return known;
    const { text, spans } = base.source;
    const [a, b] = [spans[first], spans[last]];
    if (!a || !b || !node) return undefined;
    const raw = text.slice(a.from, b.to);
    let shown: readonly string[] | undefined;
    let notes: ReturnType<typeof footnotesOf> | undefined;
    const unit: Unit = {
      nodes,
      markdown: withLf(raw),
      literals: false,
      faithful: true,
      sourced: { first, last, raw },
      get shown() {
        return (shown ??= shownIn(nodes));
      },
      get names() {
        return (notes ??= footnotesOf(nodes)).names;
      },
      get defines() {
        return (notes ??= footnotesOf(nodes)).defines;
      },
    };
    base.units.set(node, [unit, ...(kept ?? [])].slice(0, KEPT));
    return unit;
  }

  // Whether units `a` and `b`, one after the other, read as they show, if
  // known: as blocks next to each other in the source, they do.
  #together(a: Unit, b: Unit): boolean | undefined {
    if (this.#adjacent(a, b)) return true;
    return this.#pairs.get(a)?.get(b);
  }

  #adjacent(a: Unit, b: Unit): boolean {
    return !!a.sourced && !!b.sourced && a.sourced.last + 1 === b.sourced.first;
  }

  // Whether `unit`, read last as `#ends` reads it, reads as it shows: one
  // ending as the source ends does.
  #endsAs(unit: Unit, final: boolean): boolean {
    const base = this.#base;
    const last = base ? base.nodes.length - 1 : -1;
    if (unit.sourced?.last === last && base?.final === final) return true;
    return this.#ends(unit, final);
  }

  // The unit kept of just `nodes`.
  #unit(nodes: readonly Node[]): Unit | undefined {
    const [first] = nodes;
    return (first && this.#units.get(first))?.find(
      (unit) => unit.nodes.length === nodes.length && unit.nodes.every((n, i) => n === nodes[i]),
    );
  }

  // The unit of `progress`'s run at `i`, as its source, or as made since
  // for another document, as the one shown once this was edited.
  #known(progress: Progress, i: number): Unit | undefined {
    const { runs, units } = progress;
    return (units[i] ??= this.#sourced(progress, i) ?? this.#unit(runs[i] ?? []));
  }

  // Units of `runs` as one document, with `MARK`'s paragraph around each.
  #doc(runs: readonly (readonly Node[])[]): Node {
    const [first] = runs[0] ?? [];
    if (!first) throw new Error('No blocks to write');
    const { schema } = first.type;
    const mark = () => schema.node('paragraph', null, schema.text(MARK));
    return schema.topNodeType.create(null, [
      ...runs.flatMap((nodes) => [mark(), ...nodes]),
      mark(),
    ]);
  }

  // Each of `runs` written alone, their autolinks as literals if
  // `literals`; null if they can't be told apart.
  #alone(runs: readonly (readonly Node[])[], literals: boolean): string[] | null {
    const doc = this.#doc(runs);
    const written = literals
      ? writingLiterals(() => this.#serialize(doc)).written
      : this.#serialize(doc);
    // Between marks, a unit's writing with a blank line each side, or just
    // one blank line for one written as nothing.
    const [head, ...between] = written.split(MARK);
    if (head !== '' || between.pop() !== '\n' || between.length !== runs.length) return null;
    const parts = between.map((part) => (part === '\n\n' ? '' : AROUND.exec(part)?.[1]));
    return parts.every((part) => part !== undefined) ? parts : null;
  }

  #draft(nodes: readonly Node[], markdown: string | null, literals: boolean): Draft {
    return { nodes, markdown, literals, shown: shownIn(nodes), ...footnotesOf(nodes) };
  }

  // A unit of `draft`, or the one its blocks have, as they may twice in a batch.
  #keep(draft: Draft, faithful: boolean): Unit {
    const known = this.#unit(draft.nodes);
    if (known) return known;
    const unit = { ...draft, faithful, sourced: null };
    const [first] = draft.nodes;
    if (first) this.#units.set(first, [unit, ...(this.#units.get(first) ?? [])].slice(0, KEPT));
    return unit;
  }

  // Units of `runs`, written together and read with the units `before` and
  // `after` them; each alone if they don't read as they show.
  #batch(runs: readonly Node[][], before?: Unit, after?: Unit): Unit[] {
    const parts = this.#alone(runs, true);
    const context = (unit?: Unit) => (unit?.faithful ? [unit] : []);
    const drafts = parts && runs.map((nodes, i) => this.#draft(nodes, parts[i] ?? null, true));
    if (drafts && this.#reads([...context(before), ...drafts, ...context(after)])) {
      const units = drafts.map((draft) => this.#keep(draft, true));
      const read = writing([...context(before), ...units, ...context(after)]);
      for (let i = 1; i < read.length; i++) {
        const [a, b] = [read[i - 1], read[i]];
        if (a && b) this.#pair(a, b, true);
      }
      return units;
    }
    return runs.map((nodes) => this.#make(nodes));
  }

  // A unit of `nodes`, read alone: its autolinks written as their literals,
  // unless it reads as it shows only without.
  #make(nodes: readonly Node[]): Unit {
    const known = this.#unit(nodes);
    if (known) return known;
    const bare = this.#draft(nodes, this.#alone([nodes], true)?.[0] ?? null, true);
    if (this.#reads([bare])) return this.#keep(bare, true);
    const plain = this.#draft(nodes, this.#alone([nodes], false)?.[0] ?? null, false);
    return this.#keep(plain, this.#reads([plain]));
  }

  // Whether `units`, written one after another with stubs defining the
  // footnotes they name, read as what they show. Two units kept are noted
  // as a pair.
  #reads(units: readonly (Draft | Unit)[]): boolean {
    const names = new Map(units.flatMap((unit) => [...unit.names]));
    for (const unit of units) for (const label of unit.defines) names.delete(label);
    const stubs = [...names.values()].map((label) => `[^${label}]: x`);
    const shown = units.flatMap((unit) => unit.shown);
    let faithful = units.every((unit) => unit.markdown !== null);
    if (faithful)
      try {
        const read: string[] = [];
        const written = units.flatMap((unit) => (unit.markdown ? [unit.markdown] : []));
        const markdown = [...written, ...stubs].join('\n\n');
        this.#parse(markdown).forEach((node) => read.push(...shownIn([node])));
        faithful =
          read.length === shown.length + stubs.length && shown.every((s, i) => read[i] === s);
      } catch {
        faithful = false;
      }
    const [a, b] = units;
    if (units.length === 2 && a && b && 'faithful' in a && 'faithful' in b)
      this.#pair(a, b, faithful);
    return faithful;
  }

  // Whether `unit`, read last, as a writing with a final line break if
  // `final` ends, reads as it shows, as reading the whole writing would
  // find: HTML left open there (`<pre>`) takes in the line break.
  #ends(unit: Unit, final: boolean): boolean {
    const endings = this.#endings.get(unit) ?? new Map<boolean, boolean>();
    this.#endings.set(unit, endings);
    let ends = endings.get(final);
    if (ends === undefined) {
      // Footnotes it names, defined before it, as nothing can follow it.
      const stubs = [...unit.names.values()].map((label) => `[^${label}]: x`);
      try {
        const read: string[] = [];
        const markdown = [...stubs, ending(unit.markdown ?? '', final)].join('\n\n');
        this.#parse(markdown).forEach((node) => read.push(...shownIn([node])));
        const shown = read.slice(stubs.length);
        ends =
          read.length === stubs.length + unit.shown.length &&
          unit.shown.every((s, i) => shown[i] === s);
      } catch {
        ends = false;
      }
      endings.set(final, ends);
    }
    return ends;
  }

  #pair(a: Unit, b: Unit, faithful: boolean) {
    const after = this.#pairs.get(a) ?? new WeakMap<Unit, boolean>();
    this.#pairs.set(a, after.set(b, faithful));
  }
}

/**
 * For each of `runs`, the blocks of `base` it is, unedited and next to
 * each other there, by index: each block the very one there, or one the
 * same as the block after the last found, as undoing an edit gives back.
 * And the block each starts in place of, the one after the last found.
 */
function placesOf(base: Base, runs: readonly Node[][]) {
  let expect = 0;
  const slots: number[] = [];
  const places = runs.map((nodes) => {
    slots.push(expect);
    let first: number | null = null;
    let last: number | null = null;
    let kept = true;
    for (const node of nodes) {
      if (blank(node)) continue;
      const there = base.nodes[expect];
      const at = base.index.get(node) ?? (there && there.eq(node) ? expect : undefined);
      if (at === undefined || !base.source.spans[at] || (last !== null && at !== last + 1)) {
        kept = false;
        continue;
      }
      first ??= at;
      last = at;
      expect = at + 1;
    }
    return kept && first !== null && last !== null ? ([first, last] as const) : null;
  });
  return { places, slots };
}
