import {
  Editor,
  editorViewOptionsCtx,
  parserCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
  SerializerReady,
  serializerCtx,
} from '@milkdown/kit/core';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { history } from '@milkdown/kit/plugin/history';
import type { Mark, Node } from '@milkdown/kit/prose/model';
import { Transform } from '@milkdown/kit/prose/transform';
import type { EditorProps } from '@milkdown/kit/prose/view';
import {
  commonmark,
  remarkPreserveEmptyLinePlugin,
  syncHeadingIdPlugin,
} from '@milkdown/kit/preset/commonmark';
import { gfm } from '@milkdown/kit/preset/gfm';
import { $remark } from '@milkdown/kit/utils';
import { escapeEquals } from '@wikistow/client/markdown';
import { alertOf } from '@wikistow/client/reader';
import type { Link, Nodes, Root, Text } from 'mdast';
import { defaultHandlers, type State } from 'mdast-util-to-markdown';
import type { Options } from 'remark-stringify';
import type { Pluggable } from 'unified';
import { markdownSyntaxes } from '../../../registries';
import { inertHost, type VisualHost } from './host';
import { isLiteral } from './literals';
import { HIGHLIGHT, highlightEditorNode, TEXT_COLOR } from './highlight-marks';
import { leaveLastBlock } from './plugins';
import { pluginInlineNode } from './plugin-inline';
import { readAlone } from './read-alone';
import { meaningOf } from './reader-fidelity';
import { schemaChanges } from './schema';
import { readingSpans } from './sources';
import {
  codeBlockView,
  imageView,
  listItemView,
  pluginBlockUnits,
  quoteView,
  tableView,
} from './views';

/** Markdown as Obsidian writes it: `-` bullets, `*` emphasis, backtick fences. */
export const STRINGIFY = {
  bullet: '-',
  emphasis: '*',
  fences: true,
  fence: '`',
} as const satisfies Options;

type Handle = NonNullable<NonNullable<Options['handlers']>['text']>;

const LINE_END = /^(?:[\r\n]|$)/;

// A `<` starting an email autolink (`<+me@x.org>`), with the backslashes
// before it: remark escapes one only before a letter.
const EMAIL_AUTOLINK =
  /(\\*)<(?=[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*>)/gi;

// The dot of a `www.` before an escape (`www.\_x.org`). remark leaves it,
// as the escape would end the literal, but GFM reads on past it: the domain
// ends at the backslash and the path takes the rest, linking what the text
// alone doesn't.
const WWW_DOT = /(?<=[Ww])\.(?=\\)/g;

// An `@` GFM can read an email at, from source: an address character
// before it and a domain character after. Every one is escaped, as remark
// means to, but its pattern takes the character before, so of two sharing
// it (`a@b@x.org`) it escapes the first only. In source, an escape ends the
// domain, so the second can link what the text alone doesn't
// (`b@x.org\_`).
const EMAIL_AT = /(?<=[+\-.\w])@(?=[-.\w])/g;

// A space at the edge of text in a mark that goes on past it, or in a
// colour's HTML, as it's given to Milkdown (`writable`): Milkdown moves the
// spaces at a mark's ends out of it as it closes it, and it closes a mark
// early, to open it again, where one it opened later ends, parting
// `**==a== b**`. This private-use character it leaves be, and it's
// written as the space.
const HELD_SPACE = '\uE002';

/**
 * Text, escaped wherever Markdown would read more in it. Milkdown's own
 * handler writes text ending in a space as it is, so `\[\[Plan]] ` before
 * a link or emphasis came back a live link. Spaces ending a block are
 * kept as typed, as escaping writes one before a line break as `&#x20;`.
 * Before a soft line break they're left out: two would make it a hard one,
 * and fewer mean nothing. A line of only spaces is escaped, as spaces
 * starting a line can make it code. So is each backslash, not only one
 * before punctuation: emphasis next to the text can write the character
 * after it as a reference (`&#x70;`), which a lone one would escape. A
 * `<` that would start an email autolink is escaped too, as is each `@`
 * GFM could read an email at and the dot of a `www.` before an escape,
 * the character written just before the text counted (`__\@x.org`). In
 * an autolink (`<…>`), where nothing escapes, text is written as it is.
 */
const escaped: Handle = (node: Text, parent, state, info) => {
  const value = node.value.replaceAll(HELD_SPACE, ' ');
  if (state.stack.includes('autolink')) return value;
  // With the character written before it, which may be an address's, as
  // the `_` of a `__` before `@x.org` is. A `*` there may be written `_`
  // yet, as remark picks the markers of bold and emphasis once their text
  // is written.
  const before = info.before.slice(-1).replace('*', '_');
  const safe = (part: string, after = info.after) => {
    const escaped = state
      .safe(part, { ...info, after, encode: [] })
      .replace(/\\([!-/:-@[-`{-~])?/g, (escape, escaped?: string) => (escaped ? escape : '\\\\'))
      .replace(EMAIL_AUTOLINK, (lt, slashes: string) =>
        slashes.length % 2 ? lt : `${slashes}\\<`,
      );
    return `${before}${escaped}`
      .replace(WWW_DOT, '\\.')
      .replace(EMAIL_AT, '\\@')
      .slice(before.length);
  };
  if (!LINE_END.test(info.after)) return safe(value);
  const body = value.replace(/[ \t]+$/, '');
  const space = value.slice(body.length);
  if (body === '' && LINE_END.test(info.before)) return safe(value);
  // Escaped as at the line's end, which it is once Markdown drops the spaces.
  return safe(body) + (parent?.children.at(-1) === node ? space : '');
};

// A dollar, with the backslashes before it.
const DOLLAR = /(\\*)\$/g;

/**
 * Text (`escaped`), but an alert's marker as GitHub writes it: `[!NOTE]`,
 * not `\[!NOTE]`. Each dollar not before a digit is escaped, as one could
 * close math (`mathToMarkdownExtension`), checked again on what's written,
 * since remark skips some; and in a block with inline math, or a dollar in
 * its code or a link, every one (`nearMath`), as one that could open math
 * could close at that dollar. So is each `=` that could make a highlight
 * (`escapeEquals`).
 */
const text: Handle = (node: Text, parent, state, info) => {
  const escapedText = escaped(node, parent, state, info);
  const written = node.data?.alert ? escapedText.replace(/^\\\[/, '[') : escapedText;
  // Nothing escapes in an autolink, which math can't start in.
  if (state.stack.includes('autolink')) return written;
  const priced = written.replace(DOLLAR, (dollar, slashes: string, at: number) => {
    const next = written.charAt(at + dollar.length) || info.after.charAt(0);
    const bare = slashes.length % 2 === 0;
    return bare && (node.data?.nearMath || !/\d/.test(next)) ? `${slashes}\\$` : dollar;
  });
  // The top-level block it's in.
  const block = state.indexStack[0] ?? -1;
  if (equals.bare.has(block)) return priced;
  const safe = escapeEquals(priced, info.before, info.after);
  if (safe !== priced) equals.escaped.add(block);
  return safe;
};

// An `=` in an image's alt to be written escaped (`image`), which remark's
// own escaping leaves be.
const HELD_EQUALS = '\uE003';

// Two `=` with only spaces on both sides, which can neither open nor close.
const inert = (before: string | undefined, after: string | undefined) =>
  /^\s$/.test(before ?? '') && /^\s$/.test(after ?? '');

/**
 * An image, its alt's `=` escaped as text's are (`escapeEquals`): Markdown
 * reads highlights in an alt before it takes their text as the alt, so
 * `![a==b==](u)` is the alt `ab`. Every run of two that could open or close
 * is escaped, and kept so only if its block reads otherwise without
 * (`whole`); a run of three or more is never a highlight's.
 */
type ImageArgs = Parameters<typeof defaultHandlers.image>;
function image(...[node, parent, state, info]: ImageArgs) {
  const block = state.indexStack[0] ?? -1;
  const alt = equals.bare.has(block)
    ? node.alt
    : node.alt?.replace(/=+/g, (run, at: number, all: string) =>
        run.length === 2 && !inert(all[at - 1], all[at + 2]) ? HELD_EQUALS.repeat(2) : run,
      );
  if (!alt || alt === node.alt) return defaultHandlers.image(node, parent, state, info);
  equals.escaped.add(block);
  return defaultHandlers
    .image({ ...node, alt }, parent, state, info)
    .replaceAll(HELD_EQUALS, '\\=');
}

// The top-level blocks whose text `text` is to leave each `=` in as it is,
// and those it escaped one in (`whole`).
const equals = { bare: new Set<number>(), escaped: new Set<number>() };

// Whether `node`, not text, is or holds a dollar that could close math
// opened in the text before it: inline math, or a dollar in code, a link's
// address or title, or HTML.
const closesMath = (node: Nodes) =>
  node.type === 'inlineMath' ||
  (node.type !== 'text' &&
    (('value' in node && node.value.includes('$')) ||
      ('url' in node && node.url.includes('$')) ||
      ('title' in node && !!node.title?.includes('$'))));

/**
 * Marks the text of each block of `tree` where a dollar outside its text
 * could close math (`closesMath`, `nearMath`). Without recursion.
 */
function markNearMath(tree: Root) {
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!('children' in node)) continue;
    const phrasing =
      node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell';
    const texts: Text[] = [];
    let near = false;
    const inside: Nodes[] = phrasing ? [...node.children] : [];
    for (let child = inside.pop(); child; child = inside.pop()) {
      near ||= closesMath(child);
      if (child.type === 'text') texts.push(child);
      if ('children' in child) inside.push(...child.children);
    }
    if (near) for (const text of texts) text.data = { ...text.data, nearMath: true };
    if (!phrasing) stack.push(...node.children);
  }
}

// A block quote, the text of its alert's marker, if it's one, marked so.
type QuoteArgs = Parameters<typeof defaultHandlers.blockquote>;
function blockquote(...[node, ...rest]: QuoteArgs) {
  const alert = alertOf(node);
  if (alert) alert.text.data = { ...alert.text.data, alert: true };
  return defaultHandlers.blockquote(node, ...rest);
}

declare module 'mdast' {
  interface TextData {
    /** Whether it starts with an alert's marker (`alertOf`). */
    alert?: boolean;
    /** Whether its block holds a dollar outside text that could close math (`markNearMath`). */
    nearMath?: boolean;
  }
  interface LinkData {
    /** Whether it may be written as its literal: the link mark's `bare`. */
    bare?: boolean;
  }
}

// Whether links are being written as their literals (`writingLiterals`),
// and whether one was.
const literals = { on: false, wrote: false };

/**
 * `write`, with each `bare` link that GFM reads its text alone as, an
 * autolink literal (`https://…`, `www.…`, an email), written as just that
 * text, as it was typed or the page wrote it; and whether any was. Beside other text it may read as
 * more, so what's written so must be read back.
 */
export function writingLiterals<T>(write: () => T): { written: T; literals: boolean } {
  literals.on = true;
  literals.wrote = false;
  try {
    return { written: write(), literals: literals.wrote };
  } finally {
    literals.on = false;
  }
}

// The text of `node` if it's to be written as its literal.
function literalOf(node: Link): string | null {
  if (!literals.on || node.title || !node.data?.bare) return null;
  const [text, ...rest] = node.children;
  if (text?.type !== 'text' || rest.length > 0 || !isLiteral(text.value, node.url)) return null;
  literals.wrote = true;
  return text.value;
}

// Whether remark would write `node` as an autolink, `<…>`, its text being
// its address, and the reader reads that back as just this link. GFM's
// literals are looser than `<…>`: `<me@x_y.org>` isn't one. Nor is one
// with a bar in a table cell, which ends the cell, escaped or not.
function autolinked(node: Link, state: State): boolean {
  const [text, ...rest] = node.children;
  const value = text?.type === 'text' && !rest.length ? text.value : null;
  const address = value !== null && (value === node.url || `mailto:${value}` === node.url);
  if (node.title || !address || !/^[a-z][a-z+.-]+:/i.test(node.url)) return false;
  if (/[\0- <>\u007F]/.test(node.url)) return false;
  if (node.url.includes('|') && state.stack.includes('tableCell')) return false;
  const read = readAlone(`<${value}>`);
  return read?.type === 'link' && read.url === node.url;
}

// The document, with no link split (`wholeLinks`).
type RootArgs = Parameters<typeof defaultHandlers.root>;

/**
 * Its text marked where it's near inline math (`markNearMath`). A block
 * whose text had a `=` escaped that could make a highlight
 * (`escapeEquals`) is written with none escaped instead if, written alone
 * so, it reads the same, as it does unless another `==` in it pairs with
 * one: `a ==> b` and `x==y` stay as typed, each block as it reads itself.
 * Writing it again starts from the state remark had, so a list's bullet
 * is the one it would have been.
 */
function whole(...[node, parent, state, info]: RootArgs) {
  const tree = wholeLinks(node) as Root;
  markNearMath(tree);
  const bullets = { current: state.bulletCurrent, last: state.bulletLastUsed };
  const write = (root: Root, bare: Iterable<number>) => {
    state.bulletCurrent = bullets.current;
    state.bulletLastUsed = bullets.last;
    equals.bare = new Set(bare);
    equals.escaped = new Set();
    try {
      return defaultHandlers.root(root, parent, state, info);
    } finally {
      equals.bare = new Set();
    }
  };
  const written = write(tree, []);
  const escaped = [...equals.escaped];
  const after = { current: state.bulletCurrent, last: state.bulletLastUsed };
  const bare = escaped.filter((i) => {
    const block = tree.children[i];
    if (!block) return false;
    const alone: Root = { type: 'root', children: [block] };
    try {
      return meaningOf(write(alone, [0])) === meaningOf(write(alone, []));
    } catch {
      return false;
    }
  });
  if (bare.length > 0) return write(tree, bare);
  state.bulletCurrent = after.current;
  state.bulletLastUsed = after.last;
  return written;
}

// Otherwise `<…>` where its text is its address and that reads as it,
// `[…](…)` where it isn't or doesn't.
type LinkArgs = Parameters<typeof defaultHandlers.link>;
function link(...[node, parent, state, info]: LinkArgs) {
  const literal = literalOf(node);
  if (literal !== null) return literal;
  const { options } = state;
  const resourceLink = options.resourceLink;
  options.resourceLink = !autolinked(node, state);
  try {
    return defaultHandlers.link(node, parent, state, info);
  } finally {
    options.resourceLink = resourceLink;
  }
}
link.peek = (...[node, , state]: LinkArgs) =>
  literalOf(node)?.charAt(0) ?? (autolinked(node, state) ? '<' : '[');

// Marks as mdast writes them: nodes around the text they cover.
const WRAPS = new Set([
  'strong',
  'emphasis',
  'delete',
  'link',
  'highlight',
  'colorHighlight',
  'textColor',
]);

type Tree = { type: string; value?: string; children?: Tree[] };
type Wrap = { key: string; node: Omit<Tree, 'children'> };
type Leaf = { node: Tree; marks: readonly Wrap[] };

// The leaves of `nodes`, each with the marks around it, outermost first.
// Milkdown leaves text it moved a mark's spaces out of empty.
function leavesOf(nodes: readonly Tree[], marks: readonly Wrap[] = []): Leaf[] {
  return nodes.flatMap((node) => {
    if (node.type === 'text' && !node.value) return [];
    if (!WRAPS.has(node.type) || !node.children) return [{ node, marks }];
    const { children, ...wrap } = node;
    return leavesOf(children, [...marks, { key: JSON.stringify(wrap), node: wrap }]);
  });
}

const isLink = (wrap: Wrap) => wrap.node.type === 'link';

// Marks that hold a space at their ends: a link's text, and a colour's HTML.
const SPACED = new Set(['link', 'textColor', 'colorHighlight']);

// `wrap` around `children`, with the spaces they start and end with
// outside it, as Milkdown puts them: a delimiter beside a space isn't one.
// A space held for Milkdown (`HELD_SPACE`) goes out too, but of a link or
// a colour's HTML, which can hold it.
function around(wrap: Omit<Tree, 'children'>, children: readonly Tree[]): Tree[] {
  const inside = [...children];
  // The spaces at one end, across text nodes of only spaces, as a held
  // space and a soft line break are.
  const take = (first: boolean, edge: RegExp) => {
    const taken: Tree[] = [];
    for (;;) {
      const node = first ? inside[0] : inside.at(-1);
      if (node?.type !== 'text' || !node.value) break;
      const [space = ''] = edge.exec(node.value) ?? [];
      if (!space) break;
      const value = first
        ? node.value.slice(space.length)
        : node.value.slice(0, -space.length || undefined);
      inside.splice(first ? 0 : -1, 1, ...(value ? [{ ...node, value }] : []));
      const moved = { type: 'text', value: space };
      if (first) taken.push(moved);
      else taken.unshift(moved);
      if (value) break;
    }
    return taken;
  };
  const held = SPACED.has(wrap.type) ? '' : HELD_SPACE;
  const before = take(true, new RegExp(`^[\\s${held}]+`));
  const after = take(false, new RegExp(`[\\s${held}]+$`));
  return [...before, ...(inside.length > 0 ? [{ ...wrap, children: inside }] : []), ...after];
}

// Which marks go outside others over the same text: a colour, then a
// highlight, as Obsidian writes `==**bold**==`, then the rest.
const OUTER: Readonly<Record<string, number>> = { textColor: 0, colorHighlight: 1, highlight: 1 };
const outer = (wrap: Wrap) => OUTER[wrap.node.type] ?? 2;

// `leaves` nested in their marks, but those in `open`, which are around
// them already. The mark opened first is the one that goes on furthest,
// but never past the end of a link it would cut, which it ends before,
// opening again inside; of those that go on as far, a colour or highlight
// (`OUTER`), else the one Milkdown put outermost.
function nest(leaves: readonly Leaf[], open: ReadonlySet<string> = new Set()): Tree[] {
  const nested: Tree[] = [];
  const has = (i: number, wrap: Wrap) => !!leaves[i]?.marks.some((m) => m.key === wrap.key);
  for (let i = 0; i < leaves.length;) {
    const leaf = leaves[i];
    const marks = (leaf?.marks.filter((wrap) => !open.has(wrap.key)) ?? []).sort(
      (a, b) => outer(a) - outer(b),
    );
    let best: Wrap | undefined;
    let end = i + 1;
    for (const wrap of marks) {
      let to = i;
      while (has(to, wrap)) to++;
      // Not past the start of a link in it that goes on past its end.
      for (let k = i; k < to && !isLink(wrap); k++) {
        const link = leaves[k]?.marks.find((m) => isLink(m) && !open.has(m.key));
        if (!link || (k > i && has(k - 1, link))) continue;
        let last = k;
        while (has(last, link)) last++;
        if (last > to) to = k;
      }
      if (!best ? to > i : to > end) [best, end] = [wrap, to];
    }
    if (best) {
      nested.push(...around(best.node, nest(leaves.slice(i, end), new Set([...open, best.key]))));
    } else if (leaf) nested.push(leaf.node);
    i = end;
  }
  return nested;
}

// `tree` with each run of text marks in it nested so no link is split.
// Milkdown opens the marks a node starts with in a fixed order, so one
// starting with a link and ending inside it, as bold on its first words,
// closes the link and writes it as two (`**[a](u)**[b](u)`), which the
// reader reads as two links.
function wholeLinks(tree: Tree): Tree {
  const { children } = tree;
  if (!children) return tree;
  const phrasing = children.some((child) => WRAPS.has(child.type));
  return { ...tree, children: phrasing ? nest(leavesOf(children)) : children.map(wholeLinks) };
}

// Each inline node as one character, a line break as the space it shows.
const leafText = (leaf: Node) => (leaf.type.name === 'hardbreak' ? '\n' : '\uFFFC');

/**
 * Whether Markdown can hold `mark` on `atom`, an inline node not text: not
 * code, which a code span would hold as text, nor a link on a footnote
 * reference, which a link's text can't hold.
 */
export const holds = (atom: Node, mark: Mark) =>
  !mark.type.spec.code && !(atom.type.name === 'footnote_reference' && mark.type.name === 'link');

// The marks Milkdown opens before the others (`visualPlugins`).
const RANKED_FIRST = new Set([HIGHLIGHT, TEXT_COLOR]);

// A colour's HTML, `<span data-color>` or `<mark data-color>`, which can
// hold spaces at its ends, as `**` and `==` can't.
const holdsSpaces = (mark: Mark) =>
  mark.type.name === TEXT_COLOR || (mark.type.name === HIGHLIGHT && mark.attrs['color'] !== null);

/**
 * `doc` without the marks Markdown can't hold. None on the spaces and line
 * breaks a mark's run starts or ends with, but code, and a colour's HTML on
 * spaces (`holdsSpaces`): delimiters can't sit beside them, and Milkdown,
 * which moves spaces out of a mark, wrote some around nothing (`~~~~`,
 * `[](…)`) and others differently each time. And none an atom can't hold
 * (`holds`). A space at the edge of text in a mark that goes on past it
 * where Milkdown closes it to open it again, or in a colour's HTML, is held
 * for Milkdown, which would otherwise move it out (`HELD_SPACE`).
 */
function writable(doc: Node): Node {
  const tr = new Transform(doc);
  doc.descendants((block, pos) => {
    if (!block.inlineContent) return true;
    const start = pos + 1;
    const runs: { mark: Mark; from: number; to: number }[] = [];
    block.forEach((node, offset, index) => {
      const end = offset + node.nodeSize;
      const previous = index > 0 ? block.child(index - 1).marks : [];
      for (const mark of node.marks) {
        const held = node.isText || holds(node, mark);
        if (!held) tr.removeMark(start + offset, start + end, mark);
        if (!held || mark.type.spec.code) continue;
        const run = mark.isInSet(previous) && runs.findLast((r) => r.mark.eq(mark));
        if (run) run.to = end;
        else runs.push({ mark, from: offset, to: end });
      }
    });
    const text = block.textBetween(0, block.content.size, undefined, leafText);
    for (const { mark, from, to } of runs) {
      const inside = text.slice(from, to);
      // A colour's HTML keeps spaces at its ends, but not a line break.
      const edge = (spaces: string) =>
        holdsSpaces(mark) && !spaces.includes('\n') ? 0 : spaces.length;
      const lead = edge(inside.slice(0, inside.length - inside.trimStart().length));
      const trail = edge(inside.slice(inside.trimEnd().length));
      if (lead > 0) tr.removeMark(start + from, start + from + lead, mark);
      if (trail > 0 && lead < inside.length) tr.removeMark(start + to - trail, start + to, mark);
    }
    return false;
  });
  const spaces = new Map<number, readonly Mark[]>();
  tr.doc.descendants((node, pos, parent, index) => {
    if (!node.isText || !node.text || node.marks.some((mark) => mark.type.spec.code)) return;
    const beside = (at: number) =>
      parent && at >= 0 && at < parent.childCount ? parent.child(at) : null;
    const before = beside(index - 1);
    const after = beside(index + 1);
    // A mark going on from `other`, where Milkdown closes it to open it
    // again: a link, after a space; any mark, where `other` has a highlight
    // or colour this text hasn't, or this one has that `other` hasn't, as
    // Milkdown opens those first (`visualPlugins`).
    const held = (other: Node | null, start: boolean) => {
      const going = node.marks.filter((mark) => !!other && mark.isInSet(other.marks));
      const colored = (a: Node, b: Node) =>
        a.marks.some((mark) => RANKED_FIRST.has(mark.type.name) && !mark.isInSet(b.marks));
      const reopened = !!other && (colored(other, node) || colored(node, other));
      return (
        node.marks.some(holdsSpaces) ||
        (start && going.some((mark) => mark.type.name === 'link')) ||
        (reopened && going.length > 0)
      );
    };
    if (node.text.startsWith(' ') && held(before, true)) spaces.set(pos, node.marks);
    if (node.text.endsWith(' ') && held(after, false))
      spaces.set(pos + node.text.length - 1, node.marks);
  });
  for (const [pos, marks] of spaces)
    tr.replaceWith(pos, pos + 1, doc.type.schema.text(HELD_SPACE, marks));
  return tr.doc;
}

/** Each writing of a document is of `writable`'s. */
const serializeWritable: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(SerializerReady);
  const serialize = ctx.get(serializerCtx);
  ctx.set(serializerCtx, (doc) => serialize(writable(doc)));
};

// The registered syntaxes' remark plugins, the very ones the reader runs.
const syntaxPlugins = markdownSyntaxes
  .flatMap((syntax) => syntax.remarkPlugins)
  .map((plugin: Pluggable, i) => {
    if (typeof plugin === 'function') return $remark(`syntax-${i}`, () => plugin);
    if (Array.isArray(plugin) && typeof plugin[0] === 'function') {
      const [use, options] = plugin;
      return $remark(`syntax-${i}`, () => use, options);
    }
    throw new Error('A remark preset can’t be a syntax’s plugin');
  });

/** What each registered syntax adds to the visual editor, loaded once. */
type SyntaxNode = Awaited<ReturnType<(typeof markdownSyntaxes)[number]['editorNode']>>;
let syntaxNodes: Promise<SyntaxNode[]> | undefined;
export const loadSyntaxNodes = () =>
  (syntaxNodes ??= Promise.all(markdownSyntaxes.map((syntax) => syntax.editorNode())));

/** Everything the visual editor is made of, the registered syntaxes' nodes included. */
export function visualPlugins(host: VisualHost, nodes: readonly SyntaxNode[]): MilkdownPlugin[] {
  return [
    // Before the table plugin's own Arrow Down.
    leaveLastBlock,
    // Before Backspace and Delete join text into a plugin's block.
    pluginBlockUnits(host),
    // Highlights and colours (`markdownSyntaxes`), ahead of bold and the
    // other marks, so they're opened first: Milkdown keeps a mark open
    // across text only inside the marks opened before it, and moves the
    // spaces out of one it opens again, parting `==**bold** text==`.
    ...highlightEditorNode(),
    // Ids on headings are the reader's, worked out as it renders. And `<br>`
    // is HTML, as the reader shows it, not an empty paragraph.
    ...commonmark.filter(
      (plugin) => plugin !== syncHeadingIdPlugin && !remarkPreserveEmptyLinePlugin.includes(plugin),
    ),
    ...gfm,
    history,
    serializeWritable,
    readingSpans,
    ...schemaChanges,
    imageView(host),
    listItemView,
    tableView,
    codeBlockView(host),
    pluginInlineNode(host),
    quoteView,
    ...syntaxPlugins.flat(),
    ...nodes.flatMap((node) => node(host)),
  ].flat();
}

/** A visual editor in `root`, not yet created. */
export function visualEditor({
  root,
  plugins,
  view,
}: {
  root: HTMLElement;
  plugins: readonly MilkdownPlugin[];
  view?: Partial<EditorProps>;
}): Editor {
  return Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      // Not Milkdown's emphasis and bold, which write their markers as they
      // were read, even where they can't open or close (`o*[n](u)*`): remark's
      // own pick the marker, or escape the letter beside it, so they do.
      ctx.update(remarkStringifyOptionsCtx, ({ handlers, ...prev }) => {
        const { strong: _strong, emphasis: _emphasis, ...kept } = handlers ?? {};
        return {
          ...prev,
          ...STRINGIFY,
          handlers: { ...kept, text, link, image, blockquote, root: whole },
        };
      });
      if (view) ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, ...view }));
    })
    .use([...plugins]);
}

/** Markdown to the visual editor's document and back, as it reads and writes it. */
export type Transformer = { parse: (markdown: string) => Node; serialize: (doc: Node) => string };

let shared: Promise<Transformer> | undefined;

/** The visual editor's reading and writing, from an editor nobody sees, made once. */
export function transformer(): Promise<Transformer> {
  shared ??= (async () => {
    const editor = visualEditor({
      root: document.createElement('div'),
      plugins: visualPlugins(inertHost(), await loadSyntaxNodes()),
    });
    await editor.create();
    return editor.action((ctx) => ({
      parse: ctx.get(parserCtx),
      serialize: ctx.get(serializerCtx),
    }));
  })();
  return shared;
}
