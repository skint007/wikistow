import type { MilkdownPlugin } from '@milkdown/kit/ctx';
import { markRule } from '@milkdown/kit/prose';
import type { Mark, MarkType } from '@milkdown/kit/prose/model';
import type { Command, EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { $inputRule, $markSchema } from '@milkdown/kit/utils';
import { isColor, type ColorName } from '@wikistow/client/markdown';

// Highlights and the theme's colours in the visual editor (#403): a
// `highlight` mark, plain (`==text==`) or in a colour
// (`<mark data-color>`), and a `text_color` mark (`<span data-color>`),
// each written back as it was read. Pasted, a `<mark>` is a highlight,
// and a colour comes only from HTML this tab copied, which keeps its data
// attributes; from anywhere else, a highlight is plain.

/** The mark names, as the toolbar and the shortcuts find them in the schema. */
export const HIGHLIGHT = 'highlight';
export const TEXT_COLOR = 'text_color';

const colorOf = (dom: HTMLElement | string) => {
  const color = dom instanceof HTMLElement ? dom.dataset['color'] : undefined;
  return isColor(color) ? color : null;
};

/** A highlight, with a theme colour or none. */
export const highlightSchema = $markSchema(HIGHLIGHT, () => ({
  attrs: {
    color: { default: null, validate: (value: unknown) => value === null || isColor(value) },
  },
  parseDOM: [{ tag: 'mark', getAttrs: (dom) => ({ color: colorOf(dom) }) }],
  toDOM: (mark) => [
    'mark',
    isColor(mark.attrs['color']) ? { 'data-color': mark.attrs['color'] } : {},
  ],
  parseMarkdown: {
    match: (node) => node.type === 'highlight' || node.type === 'colorHighlight',
    runner: (state, node, type) => {
      const color = node.type === 'colorHighlight' && isColor(node['color']) ? node['color'] : null;
      state.openMark(type, { color });
      state.next(node.children);
      state.closeMark(type);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === HIGHLIGHT,
    runner: (state, mark) => {
      const color: unknown = mark.attrs['color'];
      if (isColor(color)) state.withMark(mark, 'colorHighlight', undefined, { color });
      else state.withMark(mark, 'highlight');
    },
  },
}));

/** Text in a theme colour. */
export const textColorSchema = $markSchema(TEXT_COLOR, () => ({
  attrs: { color: { validate: isColor } },
  parseDOM: [
    {
      tag: 'span[data-color]',
      getAttrs: (dom) => {
        const color = colorOf(dom);
        return color ? { color } : false;
      },
    },
  ],
  toDOM: (mark) => ['span', { 'data-color': mark.attrs['color'] }],
  parseMarkdown: {
    match: (node) => node.type === 'textColor',
    runner: (state, node, type) => {
      if (!isColor(node['color'])) return state.next(node.children);
      state.openMark(type, { color: node['color'] });
      state.next(node.children);
      state.closeMark(type);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === TEXT_COLOR,
    runner: (state, mark) => {
      state.withMark(mark, 'textColor', undefined, { color: mark.attrs['color'] });
    },
  },
}));

/**
 * `==text==` typed becomes a highlight, as `**text**` becomes bold: two
 * `=`, not after a third or an escape, around text that doesn't start or
 * end with a space.
 */
const typedHighlight = $inputRule((ctx) =>
  markRule(/(?<![=\\])==([^\s=](?:[^=]*[^\s=])?)==$/, highlightSchema.type(ctx)),
);

/** The marks, and typing a highlight, as `markdownSyntaxes` registers them. */
export const highlightEditorNode = (): MilkdownPlugin[] =>
  [highlightSchema, textColorSchema, typedHighlight].flat();

/** Which colour a mark of a kind has: a highlight's, or the text's. */
export type ColorKind = 'highlight' | 'text';

const typeOf = (state: EditorState, kind: ColorKind): MarkType | undefined =>
  state.schema.marks[kind === 'highlight' ? HIGHLIGHT : TEXT_COLOR];

// Whether `type` can go on some of the selection, or on what's typed at a
// cursor: not in code, nor on text with a mark that excludes it.
function applies(state: EditorState, type: MarkType): boolean {
  const { $cursor, ranges } = state.selection as TextSelection;
  if ($cursor) return $cursor.parent.inlineContent && $cursor.parent.type.allowsMarkType(type);
  let can = false;
  for (const { $from, $to } of ranges)
    state.doc.nodesBetween($from.pos, $to.pos, (node, _pos, parent) => {
      if (!can && node.isInline && parent?.type.allowsMarkType(type))
        can = !node.marks.some((mark) => mark.type !== type && mark.type.excludes(type));
      return !can;
    });
  return can;
}

/** A colour as the selection has it: one of the theme's, `plain` for a highlight with none, or `none`. */
export type ColorShown = ColorName | 'plain' | 'none';

/**
 * The colour of `kind` all of the selection has (`ColorShown`), or null if
 * it mixes them. Spaces alone, which Markdown writes no mark on, don't
 * count. A cursor goes by the marks it types with.
 */
export function colorAt(state: EditorState, kind: ColorKind): ColorShown | null {
  const type = typeOf(state, kind);
  if (!type) return 'none';
  const { $cursor, ranges } = state.selection as TextSelection;
  const shown = (marks: readonly Mark[]): ColorShown => {
    const color: unknown = type.isInSet(marks)?.attrs['color'];
    return isColor(color) ? color : type.isInSet(marks) ? 'plain' : 'none';
  };
  if ($cursor) return shown(state.storedMarks ?? $cursor.marks());
  const seen = new Set<ColorShown>();
  for (const { $from, $to } of ranges)
    state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
      if (!node.isText) return true;
      const text = node.text?.slice(Math.max(0, $from.pos - pos), $to.pos - pos) ?? '';
      if (text.trim()) seen.add(shown(node.marks));
      return false;
    });
  const [only] = seen;
  return seen.size === 1 && only ? only : seen.size === 0 ? 'none' : null;
}

/**
 * Gives the selection a highlight or text colour of `kind`: `color`, a
 * plain highlight (`plain`), or none (null), in place of the one it has.
 * At a cursor, the text typed next has it. It doesn't apply where the mark
 * can't go, as in code.
 */
export function setColor(kind: ColorKind, color: ColorName | 'plain' | null): Command {
  return (state, dispatch) => {
    const type = typeOf(state, kind);
    if (!type || (kind === 'text' && color === 'plain')) return false;
    if (!applies(state, type)) return false;
    if (!dispatch) return true;
    const mark = color === null ? null : type.create({ color: color === 'plain' ? null : color });
    const tr = state.tr;
    const { $cursor, ranges } = state.selection as TextSelection;
    if ($cursor) {
      tr.removeStoredMark(type);
      if (mark) tr.addStoredMark(mark);
    } else {
      for (const { $from, $to } of ranges) {
        tr.removeMark($from.pos, $to.pos, type);
        if (mark) tr.addMark($from.pos, $to.pos, mark);
      }
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}
