import { setBlockType, toggleMark, wrapIn } from '@milkdown/kit/prose/commands';
import { keymap } from '@milkdown/kit/prose/keymap';
import { Fragment, type MarkType, type Node } from '@milkdown/kit/prose/model';
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list';
import {
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@milkdown/kit/prose/state';
import { liftTarget } from '@milkdown/kit/prose/transform';
import { $prose } from '@milkdown/kit/utils';
import type { AlertType } from '../../alerts';
import { alertIn } from './alerts';
import { inlineHtml } from './read-alone';

// The formatting the visual editor's toolbar and shortcuts put on and take
// off, as plain ProseMirror commands: Milkdown's own only put it on. Each
// leaves only what Markdown holds, so the write-time guard has nothing to
// catch: a code block keeps no marks and turns back into a paragraph a
// line, and a heading is never made of what it can't hold.

/** A format: whether the selection has it, and the command that puts it on or takes it off. */
export type Format = { active: (state: EditorState) => boolean; run: Command };

// Whether every part of the selection that can have `type` has it, a
// cursor by the marks it types with. Blank text and line breaks, which
// Markdown writes no mark on, don't count, and neither does a selection of
// only those.
function marked(state: EditorState, type: MarkType): boolean {
  const { $cursor, ranges } = state.selection as TextSelection;
  if ($cursor) return !!type.isInSet(state.storedMarks ?? $cursor.marks());
  let counted = false;
  const all = ranges.every(({ $from, $to }) => {
    let missing = false;
    state.doc.nodesBetween($from.pos, $to.pos, (node, pos, parent) => {
      if (missing || !node.isInline || !parent?.type.allowsMarkType(type)) return !missing;
      const text = node.text?.slice(Math.max(0, $from.pos - pos), $to.pos - pos);
      if (node.type.name === 'hardbreak' || text?.trim() === '') return;
      counted = true;
      missing = !type.isInSet(node.marks);
    });
    return !missing;
  });
  return counted && all;
}

// The run of `type` the cursor is in.
function runAround(state: EditorState, type: MarkType): { from: number; to: number } | null {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor) return null;
  const runs: { from: number; to: number }[] = [];
  $cursor.parent.forEach((child, offset) => {
    if (!type.isInSet(child.marks)) return;
    const from = $cursor.start() + offset;
    const last = runs.at(-1);
    if (last?.to === from) last.to = from + child.nodeSize;
    else runs.push({ from, to: from + child.nodeSize });
  });
  return runs.find(({ from, to }) => from <= $cursor.pos && $cursor.pos <= to) ?? null;
}

function mark(name: string): Format {
  const active = (state: EditorState) => {
    const type = state.schema.marks[name];
    return !!type && marked(state, type);
  };
  return {
    active,
    run: (state, dispatch) => {
      const type = state.schema.marks[name];
      if (!type) return false;
      // A mark that doesn't go on past its end (inline code) would cover
      // only the first character typed: at a cursor, it's only taken off
      // the run the cursor is in.
      if (type.spec.inclusive === false && state.selection.empty) {
        const run = active(state) && runAround(state, type);
        if (run) dispatch?.(state.tr.removeMark(run.from, run.to, type));
        return !!run;
      }
      // Off all of a selection that has it, as `marked` tells; otherwise on all of it.
      if (!state.selection.empty && marked(state, type)) {
        const tr = state.tr;
        for (const { $from, $to } of state.selection.ranges)
          tr.removeMark($from.pos, $to.pos, type);
        dispatch?.(tr.scrollIntoView());
        return true;
      }
      return toggleMark(type, null, { removeWhenPresent: false })(state, dispatch);
    },
  };
}

// How deep the innermost node around the selection's start with one of
// `names` is, or null.
function depthOf(
  { selection }: Pick<EditorState, 'selection'>,
  names: readonly string[],
): number | null {
  const { $from } = selection;
  for (let depth = $from.depth; depth > 0; depth--)
    if (names.includes($from.node(depth).type.name)) return depth;
  return null;
}

const quote: Format = {
  active: (state) => depthOf(state, ['blockquote']) !== null,
  run: (state, dispatch) => {
    const type = state.schema.nodes['blockquote'];
    if (!type) return false;
    if (depthOf(state, ['blockquote']) === null) return wrapIn(type)(state, dispatch);
    // The selected blocks come out of the quote they're in, not out of a list inside it.
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to, (node) => node.type === type);
    const target = range && liftTarget(range);
    if (!range || target === null || target === undefined) return false;
    dispatch?.(state.tr.lift(range, target).scrollIntoView());
    return true;
  },
};

/** A quote's kind: an ordinary one (null), or one of GitHub's alerts. */
export type QuoteKind = AlertType | null;

// Where the innermost quote around the selection's start is.
function quoteAt(state: Pick<EditorState, 'selection'>): number | null {
  const depth = depthOf(state, ['blockquote']);
  return depth === null ? null : state.selection.$from.before(depth);
}

/** The kind of the innermost quote around the selection's start; undefined out of one. */
export function quoteKind(state: EditorState): QuoteKind | undefined {
  const at = quoteAt(state);
  const quote = at === null ? null : state.doc.nodeAt(at);
  return quote ? (alertIn(quote)?.type ?? null) : undefined;
}

/**
 * The quote at `at` in `tr`'s document made `kind`, its blocks kept: its
 * alert's marker changed, taken off with the line break after it (or the
 * paragraph it was alone in), or put first in its first paragraph, on a
 * line of its own. The toolbar's quote menu and each quote's own picker
 * (`quoteView`) use it.
 */
export function setKind(tr: Transaction, at: number, kind: QuoteKind) {
  const quote = tr.doc.nodeAt(at);
  const { schema } = tr.doc.type;
  const paragraph = schema.nodes['paragraph'];
  const lineBreak = schema.nodes['hardbreak'];
  if (!quote || !paragraph || !lineBreak) return;
  const marker = kind && `[!${kind.toUpperCase()}]`;
  const alert = alertIn(quote);
  const start = at + 2;
  if (alert) {
    if (marker) return void tr.insertText(marker, start, start + alert.length);
    const end = start + alert.length + (alert.next?.type === lineBreak ? 1 : 0);
    const first = quote.child(0);
    if (end - start === first.content.size && quote.childCount > 1)
      return void tr.delete(at + 1, at + 1 + first.nodeSize);
    return void tr.delete(start, end);
  }
  if (!marker) return;
  const first = quote.firstChild;
  if (first?.type !== paragraph)
    return void tr.insert(at + 1, paragraph.create(null, schema.text(marker)));
  // A soft line break, which Markdown writes as one.
  tr.insert(start, [schema.text(marker), lineBreak.create({ isInline: true })]);
  // In an empty paragraph, the cursor goes after the break, so text typed isn't on the marker's line.
  if (first.content.size === 0)
    tr.setSelection(TextSelection.create(tr.doc, start + marker.length + 1));
}

/**
 * A quote of `kind`, an ordinary quote or an alert: the quote the
 * selection is in turned to that kind, keeping what it holds, or the
 * selected blocks quoted as it. On in a quote of that kind already.
 */
export function quoteAs(kind: QuoteKind): Format {
  return {
    active: (state) => quoteKind(state) === kind,
    run: (state, dispatch) => {
      const type = state.schema.nodes['blockquote'];
      if (!type) return false;
      const at = quoteAt(state);
      if (at !== null) {
        if (quoteKind(state) !== kind && dispatch) {
          const tr = state.tr;
          setKind(tr, at, kind);
          dispatch(tr.scrollIntoView());
        }
        return true;
      }
      if (!dispatch) return wrapIn(type)(state);
      // The quote goes where the selected blocks start, as `wrapIn` puts it,
      // which the selection may not be in (all of the page selected).
      const { $from, $to } = state.selection;
      const range = $from.blockRange($to);
      return wrapIn(type)(state, (tr) => {
        if (range) setKind(tr, range.start, kind);
        dispatch(tr.scrollIntoView());
      });
    },
  };
}

// A leaf in text going into a code block: a line break ends a line, a
// wikilink or HTML is its source, a footnote reference as it's written;
// other atoms, as images, have no text.
function leafText(leaf: Node): string {
  const { source, value, label } = leaf.attrs;
  if (leaf.type.name === 'hardbreak') return '\n';
  if (leaf.type.name === 'footnote_reference') return `[^${String(label)}]`;
  return typeof source === 'string' ? source : typeof value === 'string' ? value : '';
}

// The selected text blocks as one code block with no language, a line each.
const toCode: Command = (state, dispatch) => {
  const type = state.schema.nodes['code_block'];
  const { $from, $to, anchor, head } = state.selection;
  const range = $from.blockRange($to);
  if (!type || !range) return false;
  const blocks: Node[] = [];
  for (let i = range.startIndex; i < range.endIndex; i++) blocks.push(range.parent.child(i));
  if (!blocks.every((block) => block.isTextblock && !block.type.spec.code)) return false;
  if (!range.parent.canReplaceWith(range.startIndex, range.endIndex, type)) return false;
  if (dispatch) {
    const text = blocks
      .map((block) => block.textBetween(0, block.content.size, undefined, leafText))
      .join('\n');
    const code = type.create({ language: '' }, text ? state.schema.text(text) : null);
    const at = (pos: number) =>
      range.start + 1 + state.doc.textBetween(range.start, pos, '\n', leafText).length;
    const tr = state.tr.replaceWith(range.start, range.end, code);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at(anchor), at(head))).scrollIntoView());
  }
  return true;
};

// The code block the selection starts in as paragraphs, one a line, its
// language gone with it. The selection stays on the same text.
const fromCode: Command = (state, dispatch) => {
  const { $from, anchor, head } = state.selection;
  const block = $from.parent;
  const type = state.schema.nodes['paragraph'];
  if (!block.type.spec.code || !type) return false;
  const lines = block.textContent.split('\n');
  const paragraphs = lines.map((line) => type.create(null, line ? state.schema.text(line) : null));
  const [index, container] = [$from.index(-1), $from.node(-1)];
  if (!container.canReplace(index, index + 1, Fragment.from(paragraphs))) return false;
  if (dispatch) {
    const [start, end] = [$from.before(), $from.after()];
    const tr = state.tr.replaceWith(start, end, paragraphs);
    // A position in the code, at the same place in its line's paragraph.
    const at = (pos: number) => {
      if (pos < start || pos > end) return tr.mapping.map(pos);
      let offset = Math.min(Math.max(pos - start - 1, 0), block.content.size);
      let place = start + 1;
      for (const line of lines) {
        if (offset <= line.length) return place + offset;
        offset -= line.length + 1;
        place += line.length + 2;
      }
      return place;
    };
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at(anchor), at(head))).scrollIntoView());
  }
  return true;
};

const codeBlock: Format = {
  active: (state) => !!state.selection.$from.parent.type.spec.code,
  run: (state, dispatch) => (codeBlock.active(state) ? fromCode : toCode)(state, dispatch),
};

const LISTS = ['bullet_list', 'ordered_list'];

// Numbered or bulleted: on text out of a list, a list of it; on a list of
// the other kind, the list turns into this kind; on one of this kind, the
// selected items come out of it.
function list(name: string): Format {
  return {
    active: (state) => {
      const depth = depthOf(state, LISTS);
      return depth !== null && state.selection.$from.node(depth).type.name === name;
    },
    run: (state, dispatch) => {
      const type = state.schema.nodes[name];
      const item = state.schema.nodes['list_item'];
      if (!type || !item) return false;
      const depth = depthOf(state, LISTS);
      if (depth === null) return wrapInList(type)(state, dispatch);
      const { $from } = state.selection;
      const current = $from.node(depth);
      if (current.type === type) return liftListItem(item)(state, dispatch);
      if (dispatch) {
        // Its items say which kind they're in too, or Milkdown turns it back.
        const start = $from.before(depth);
        const tr = state.tr.setNodeMarkup(start, type, { spread: current.attrs['spread'] });
        const listType = name === 'ordered_list' ? 'ordered' : 'bullet';
        current.forEach((child, offset) => {
          const label = listType === 'bullet' ? '•' : child.attrs['label'];
          tr.setNodeMarkup(start + 1 + offset, undefined, { ...child.attrs, listType, label });
        });
        dispatch(tr);
      }
      return true;
    },
  };
}

// Whether a heading can hold `block`'s content: no line break, nor HTML
// that's a block of its own.
const headingHolds = (block: Node) => {
  let holds = true;
  block.forEach((child) => {
    if (child.type.name === 'hardbreak') holds = false;
    if (child.type.name === 'html') holds &&= inlineHtml(String(child.attrs['value']));
  });
  return holds;
};

/**
 * A heading of `level`, or, for 0, a paragraph, of each selected text
 * block. Not of code, whose lines would run into one, nor of what a
 * heading can't hold (`headingHolds`).
 */
export function heading(level: number): Format {
  const is = (node: Node) =>
    level === 0
      ? node.type.name === 'paragraph'
      : node.type.name === 'heading' && node.attrs['level'] === level;
  return {
    active: (state) => is(state.selection.$from.parent),
    run: (state, dispatch) => {
      const type = state.schema.nodes[level === 0 ? 'paragraph' : 'heading'];
      if (!type) return false;
      const { from, to } = state.selection;
      // Each block it changes, whole, not only the selected part of it.
      let kept = true;
      state.doc.nodesBetween(from, to, (node) => {
        if (!node.isTextblock) return kept;
        kept &&= !node.type.spec.code && (level === 0 || headingHolds(node));
        return false;
      });
      return kept && setBlockType(type, level === 0 ? null : { level })(state, dispatch);
    },
  };
}

export const FORMATS = {
  bold: mark('strong'),
  italic: mark('emphasis'),
  code: mark('inlineCode'),
  quote,
  codeBlock,
  orderedList: list('ordered_list'),
  bulletList: list('bullet_list'),
} satisfies Record<string, Format>;

export type FormatName = keyof typeof FORMATS;

/** The heading levels the toolbar offers; shortcuts reach all six. */
export const HEADINGS = [0, 1, 2, 3] as const;

/** Each format's shortcut, as ProseMirror names keys: Milkdown's own, which these replace. */
export const SHORTCUTS: Record<FormatName, string> = {
  bold: 'Mod-b',
  italic: 'Mod-i',
  code: 'Mod-e',
  quote: 'Mod-Shift-b',
  codeBlock: 'Mod-Alt-c',
  orderedList: 'Mod-Alt-7',
  bulletList: 'Mod-Alt-8',
};

/** A heading level's shortcut, 0 for text. */
export const headingShortcut = (level: number) => `Mod-Alt-${level}`;

// Taken whether or not the format applies, so Milkdown's shortcut for it,
// which only puts it on, never runs instead.
const taken =
  (command: Command): Command =>
  (state, dispatch, view) => {
    command(state, dispatch, view);
    return true;
  };

/** The formats' shortcuts, toggling as the toolbar does, ahead of Milkdown's. */
export const formatKeys = $prose(() =>
  keymap({
    ...Object.fromEntries(
      Object.entries(SHORTCUTS).map(([name, key]) => [key, taken(FORMATS[name as FormatName].run)]),
    ),
    ...Object.fromEntries(
      [0, 1, 2, 3, 4, 5, 6].map((level) => [headingShortcut(level), taken(heading(level).run)]),
    ),
  }),
);
