import type { Node } from '@milkdown/kit/prose/model';
import { Transform } from '@milkdown/kit/prose/transform';
import { normalizeIdentifier } from 'micromark-util-normalize-identifier';
import { writingLiterals, type Transformer } from './config';
import { ending, shownOf, writesAsShown } from './fidelity';

/** A document as Markdown, and whether that reads back as the document. */
export type Written = { markdown: string; faithful: boolean };

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
};

type Draft = Omit<Unit, 'faithful'>;

/**
 * A document's units as far as they're made, and its writing once they
 * all are, with a final line break or without.
 */
type Progress = {
  runs: Node[][];
  units: (Unit | undefined)[];
  done: boolean;
  written: Map<boolean, Written>;
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
const MARK = '\uE001';
const AROUND = /^\n\n([^]*)\n\n$/;

// Where `caret` puts the cursor, written: another private-use character,
// which no writing escapes.
const CARET = '\uE000';

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

/**
 * The visual editor's writing of documents as Markdown, checked as it goes
 * (`writesAsShown`) a top-level block at a time, so an edit costs the
 * blocks it changed, not the page. ProseMirror keeps each block an edit
 * left alone, so what's known of it is kept for as long as it is.
 *
 * Blank lines part the blocks, so Markdown reads each as it reads it alone,
 * except where one reaches into the next: HTML left open (`<!--`) takes
 * what follows, a list takes another, an indented line joins an item; and
 * a footnote reference reads as one only if the page defines it. So blocks
 * are read with those next to them, with stubs for the footnotes they name,
 * until each pair next to each other has been read together; and every
 * footnote named must be defined. The last is read as the writing ends,
 * with its final line break or without, which HTML left open (`<pre>`)
 * takes in. A document that doesn't pass is read whole, which decides.
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

  constructor({ parse, serialize }: Transformer) {
    this.#parse = parse;
    this.#serialize = serialize;
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
      if (!a?.faithful || !b?.faithful || this.#pairs.get(a)?.has(b)) continue;
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
    const { runs, units } = this.#progressOf(doc);
    const given = new Set<Node>();
    base.forEach((node) => given.add(node));
    // A unit of each run that's to be read, made now if need be.
    const unit = (i: number) => (units[i] ??= this.#make(runs[i] ?? []));
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
      if (end !== null && near.includes(end)) faithful &&= this.#ends(unit(end), true);
      const read = writing(near.map(unit));
      for (const [label, written] of unit(i).names) names.set(label, written);
      faithful &&= read.every((u) => u.faithful) && unit(i).faithful;
      for (let k = 1; k < read.length && faithful; k++) {
        const [a, b] = [read[k - 1], read[k]];
        if (a && b) faithful = this.#pairs.get(a)?.get(b) ?? this.#reads([a, b]);
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
   */
  write(doc: Node, final = true): Written {
    const progress = this.#progressOf(doc);
    const known = progress.written.get(final);
    if (known) return known;
    this.prepare(doc, () => true);
    const { units } = progress;
    let written: Written;
    if (units.some((unit) => typeof unit?.markdown !== 'string')) {
      const markdown = ending(this.#serialize(doc), final);
      written = { markdown, faithful: writesAsShown(doc, markdown, this.#parse) };
    } else {
      const parts = writing(units.filter((unit) => unit !== undefined));
      const markdown = ending(parts.map((unit) => unit.markdown).join('\n\n'), final);
      const defined = new Set(units.flatMap((unit) => [...(unit?.defines ?? [])]));
      const named = units.every((unit) =>
        [...(unit?.names.keys() ?? [])].every((label) => defined.has(label)),
      );
      const last = parts.at(-1);
      let faithful =
        named &&
        (!last || this.#ends(last, final)) &&
        units.every((unit) => unit?.faithful) &&
        parts.every((unit, i) => {
          const before = parts[i - 1];
          return !before || this.#pairs.get(before)?.get(unit) === true;
        });
      // What its parts can't vouch for, the whole may still: reading it decides.
      faithful ||= writesAsShown(doc, markdown, this.#parse);
      written = { markdown, faithful };
    }
    progress.written.set(final, written);
    return written;
  }

  /**
   * Where `pos` in `doc` is in its writing (`write`), or null if that
   * can't be told, as before `prepare` is done with it.
   */
  caret(doc: Node, pos: number): number | null {
    if (!this.ready(doc)) return null;
    const { runs, units } = this.#progressOf(doc);
    let offset = 0;
    let start = 0;
    for (const [i, nodes] of runs.entries()) {
      const unit = units[i];
      if (typeof unit?.markdown !== 'string') return null;
      const size = sizeOf(nodes);
      if (pos <= start + size) {
        const marked = new Transform(this.#doc([nodes]));
        const at = pos - start + (marked.doc.firstChild?.nodeSize ?? 0);
        try {
          marked.replaceWith(at, at, marked.doc.type.schema.text(CARET));
        } catch {
          return offset;
        }
        // Without the paragraphs around it, written again with the cursor in it.
        const blocks = marked.doc.content.content.slice(1, -1);
        const [written] = this.#alone([blocks], unit.literals) ?? [];
        const caret = written?.indexOf(CARET) ?? 0;
        return offset + Math.max(0, Math.min(caret, unit.markdown.length));
      }
      if (unit.markdown) offset += unit.markdown.length + 2;
      start += size;
    }
    return offset;
  }

  #progressOf(doc: Node): Progress {
    let progress = this.#progress.get(doc);
    if (!progress) {
      const runs = groups(doc);
      const units = runs.map((nodes) => this.#unit(nodes));
      progress = { runs, units, done: false, written: new Map() };
      this.#progress.set(doc, progress);
    }
    return progress;
  }

  // The unit kept of just `nodes`.
  #unit(nodes: readonly Node[]): Unit | undefined {
    const [first] = nodes;
    return (first && this.#units.get(first))?.find(
      (unit) => unit.nodes.length === nodes.length && unit.nodes.every((n, i) => n === nodes[i]),
    );
  }

  // The unit of `progress`'s run at `i`, as made since for another
  // document, as the one shown once this was edited.
  #known({ runs, units }: Progress, i: number): Unit | undefined {
    return (units[i] ??= this.#unit(runs[i] ?? []));
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
    const unit = { ...draft, faithful };
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
