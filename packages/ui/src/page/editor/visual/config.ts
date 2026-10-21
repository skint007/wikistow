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
import { alertOf } from '@wikistow/client/reader';
import type { Link, Root, Text } from 'mdast';
import { defaultHandlers, type State } from 'mdast-util-to-markdown';
import type { Options } from 'remark-stringify';
import type { Pluggable } from 'unified';
import { markdownSyntaxes } from '../../../registries';
import { inertHost, type VisualHost } from './host';
import { isLiteral } from './literals';
import { leaveLastBlock } from './plugins';
import { readAlone } from './read-alone';
import { schemaChanges } from './schema';
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

// A space in a link, starting text after more of it, as it's given to
// Milkdown (`writable`): one that closes the link early, where a mark
// around it ends, moves the spaces starting the rest out of it. This
// private-use character it leaves be, and it's written as the space.
const LINKED_SPACE = '\uE002';

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
  const value = node.value.replaceAll(LINKED_SPACE, ' ');
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

/** Text (`escaped`), but an alert's marker as GitHub writes it: `[!NOTE]`, not `\[!NOTE]`. */
const text: Handle = (node: Text, ...rest) => {
  const written = escaped(node, ...rest);
  return node.data?.alert ? written.replace(/^\\\[/, '[') : written;
};

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
const whole = (...[node, parent, state, info]: RootArgs) =>
  defaultHandlers.root(wholeLinks(node) as Root, parent, state, info);

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
const WRAPS = new Set(['strong', 'emphasis', 'delete', 'link']);

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

// `wrap` around `children`, with the spaces they start and end with
// outside it, as Milkdown puts them: a delimiter beside a space isn't one.
function around(wrap: Omit<Tree, 'children'>, children: readonly Tree[]): Tree[] {
  const inside = [...children];
  const take = (first: boolean, edge: RegExp) => {
    const node = first ? inside[0] : inside.at(-1);
    if (node?.type !== 'text' || !node.value) return [];
    const [space = ''] = edge.exec(node.value) ?? [];
    const value = first
      ? node.value.slice(space.length)
      : node.value.slice(0, -space.length || undefined);
    inside.splice(first ? 0 : -1, 1, ...(value ? [{ ...node, value }] : []));
    return space ? [{ type: 'text', value: space }] : [];
  };
  const before = take(true, /^\s+/);
  const after = take(false, /\s+$/);
  return [...before, ...(inside.length > 0 ? [{ ...wrap, children: inside }] : []), ...after];
}

// `leaves` nested in their marks, but those in `open`, which are around
// them already. The mark opened first is the one that goes on furthest,
// but never past the end of a link it would cut, which it ends before,
// opening again inside; of those that go on as far, the one Milkdown put
// outermost.
function nest(leaves: readonly Leaf[], open: ReadonlySet<string> = new Set()): Tree[] {
  const nested: Tree[] = [];
  const has = (i: number, wrap: Wrap) => !!leaves[i]?.marks.some((m) => m.key === wrap.key);
  for (let i = 0; i < leaves.length;) {
    const leaf = leaves[i];
    const marks = leaf?.marks.filter((wrap) => !open.has(wrap.key)) ?? [];
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

/**
 * `doc` without the marks Markdown can't hold. None on the spaces and line
 * breaks a mark's run starts or ends with, but code: delimiters can't sit
 * beside them, and Milkdown, which moves spaces out of a mark, wrote some
 * around nothing (`~~~~`, `[](…)`) and others differently each time. And
 * none an atom can't hold (`holds`). A space starting text in a link after
 * more of it is held for Milkdown, which may otherwise move it out
 * (`LINKED_SPACE`).
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
      const lead = inside.length - inside.trimStart().length;
      const trail = inside.length - inside.trimEnd().length;
      if (lead > 0) tr.removeMark(start + from, start + from + lead, mark);
      if (trail > 0 && lead < inside.length) tr.removeMark(start + to - trail, start + to, mark);
    }
    return false;
  });
  const spaces: { pos: number; marks: readonly Mark[] }[] = [];
  tr.doc.descendants((node, pos, parent, index) => {
    const before = index > 0 ? parent?.child(index - 1) : null;
    const link = node.marks.find((mark) => mark.type.name === 'link');
    const code = node.marks.some((mark) => mark.type.spec.code);
    if (node.text?.startsWith(' ') && link?.isInSet(before?.marks ?? []) && !code)
      spaces.push({ pos, marks: node.marks });
  });
  for (const { pos, marks } of spaces)
    tr.replaceWith(pos, pos + 1, doc.type.schema.text(LINKED_SPACE, marks));
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
    // Ids on headings are the reader's, worked out as it renders. And `<br>`
    // is HTML, as the reader shows it, not an empty paragraph.
    ...commonmark.filter(
      (plugin) => plugin !== syncHeadingIdPlugin && !remarkPreserveEmptyLinePlugin.includes(plugin),
    ),
    ...gfm,
    history,
    serializeWritable,
    ...schemaChanges,
    imageView(host),
    listItemView,
    tableView,
    codeBlockView(host),
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
          handlers: { ...kept, text, link, blockquote, root: whole },
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
