import type {
  ColorHighlightNode,
  HighlightNode,
  Html,
  Nodes,
  Parent,
  PhrasingContent,
  Root,
  TextColorNode,
} from 'mdast';
import type {} from 'mdast-util-to-hast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Handle, Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { resolveAll } from 'micromark-util-resolve-all';
import type {
  Code,
  Construct,
  Event,
  Extension,
  Resolver,
  State as MicromarkState,
  Token,
  Tokenizer,
} from 'micromark-util-types';

// Highlights and coloured text (#403). A highlight is Obsidian's
// `==text==`. A colour is one of the theme's, named in HTML that other
// renderers show as plain text, or as a plain highlight:
// `<span data-color="red">text</span>` for coloured text, and
// `<mark data-color="red">text</mark>` for a coloured highlight. Only that
// exact HTML, opened and closed within one run of text, reads as colour;
// any other stays HTML, as written.

/** The theme's colours a page may name, for text and for highlights. */
export const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

/** One of the theme's colours (`COLORS`). */
export type ColorName = (typeof COLORS)[number];

/** Whether `value` names one of the theme's colours. */
export const isColor = (value: unknown): value is ColorName =>
  typeof value === 'string' && (COLORS as readonly string[]).includes(value);

declare module 'mdast' {
  /** A highlight, `==text==`. */
  interface HighlightNode extends Parent {
    type: 'highlight';
    children: PhrasingContent[];
  }
  /** A highlight in one of the theme's colours, `<mark data-color="red">text</mark>`. */
  interface ColorHighlightNode extends Parent {
    type: 'colorHighlight';
    color: ColorName;
    children: PhrasingContent[];
  }
  /** Text in one of the theme's colours, `<span data-color="red">text</span>`. */
  interface TextColorNode extends Parent {
    type: 'textColor';
    color: ColorName;
    children: PhrasingContent[];
  }
  interface PhrasingContentMap {
    highlight: HighlightNode;
    colorHighlight: ColorHighlightNode;
    textColor: TextColorNode;
  }
  interface RootContentMap {
    highlight: HighlightNode;
    colorHighlight: ColorHighlightNode;
    textColor: TextColorNode;
  }
}

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    highlight: 'highlight';
    highlightSequence: 'highlightSequence';
    highlightSequenceTemporary: 'highlightSequenceTemporary';
    highlightText: 'highlightText';
  }
}

declare module 'mdast-util-to-markdown' {
  interface ConstructNameMap {
    highlight: 'highlight';
  }
}

export type { ColorHighlightNode, HighlightNode, TextColorNode } from 'mdast';

const EQUALS = 61;

/**
 * Pairs each closing `==` with the opening one before it, as GFM pairs
 * `~~`: the text between becomes the highlight, read again for what's
 * inside a span (`insideSpan`). A sequence left over is text.
 */
const resolveAllHighlight: Resolver = (events, context) => {
  let index = -1;
  while (++index < events.length) {
    const close = events[index];
    if (close?.[0] !== 'enter' || close[1].type !== 'highlightSequenceTemporary') continue;
    if (!close[1]._close) continue;
    let open = index;
    while (open--) {
      const opener = events[open];
      if (opener?.[0] !== 'exit' || opener[1].type !== 'highlightSequenceTemporary') continue;
      if (!opener[1]._open) continue;
      close[1].type = 'highlightSequence';
      opener[1].type = 'highlightSequence';
      const highlight: Token = {
        type: 'highlight',
        start: { ...opener[1].start },
        end: { ...close[1].end },
      };
      const text: Token = {
        type: 'highlightText',
        start: { ...opener[1].end },
        end: { ...close[1].start },
      };
      const next: Event[] = [
        ['enter', highlight, context],
        ['enter', opener[1], context],
        ['exit', opener[1], context],
        ['enter', text, context],
      ];
      const inside = context.parser.constructs.insideSpan.null;
      if (inside)
        splice(next, next.length, 0, resolveAll(inside, events.slice(open + 1, index), context));
      splice(next, next.length, 0, [
        ['exit', text, context],
        ['enter', close[1], context],
        ['exit', close[1], context],
        ['exit', highlight, context],
      ]);
      splice(events, open - 1, index - open + 3, next);
      index = open + next.length - 2;
      break;
    }
  }
  for (const event of events)
    if (event[1].type === 'highlightSequenceTemporary') event[1].type = 'data';
  return events;
};

/**
 * Exactly two `=`, as GFM reads `~~`: a run of three or more is text, and
 * so is one right after a `=` that isn't escaped. It opens before what
 * isn't a space, and closes after it, by GFM's flanking rules for `~~`, so
 * it may sit inside a word (`a==b==c`) and `a == b` stays text.
 */
const tokenize: Tokenizer = function (effects, ok, nok) {
  const previous = this.previous;
  const { events } = this;
  let size = 0;
  const more: MicromarkState = (code: Code) => {
    if (code === EQUALS) {
      if (size > 1) return nok(code);
      effects.consume(code);
      size++;
      return more;
    }
    if (size < 2) return nok(code);
    const token = effects.exit('highlightSequenceTemporary');
    const before = classifyCharacter(previous);
    const after = classifyCharacter(code);
    token._open = !after || (after === 2 && Boolean(before));
    token._close = !before || (before === 2 && Boolean(after));
    return ok(code);
  };
  return (code) => {
    if (previous === EQUALS && events.at(-1)?.[1].type !== 'characterEscape') return nok(code);
    effects.enter('highlightSequenceTemporary');
    return more(code);
  };
};

const highlightConstruct: Construct = {
  name: 'highlight',
  tokenize,
  resolveAll: resolveAllHighlight,
};

/** The micromark extension reading `==text==` as a highlight. */
export const highlightSyntax: Extension = {
  text: { [EQUALS]: highlightConstruct },
  // Not an attention marker, as GFM's `~` is: `*` beside `=` reads as it
  // did before, and as remark writes it.
  insideSpan: { null: [highlightConstruct] },
};

// The exact HTML that names a colour, and any other tag of those kinds.
const COLOR_OPEN = /^<(span|mark) data-color="([a-z]+)">$/;
const ANY_OPEN = /^<(span|mark)(?=[\s/>])[^]*>$/i;
const CLOSE = /^<\/(span|mark)>$/i;

type Opened = { tag: string; color: ColorName | null; at: number };

/** The node a colour's HTML, `<tag data-color>` to `</tag>`, makes of `children`. */
function colored(
  tag: string,
  color: ColorName,
  children: PhrasingContent[],
  open: Html,
  close: Html,
): PhrasingContent {
  const start = open.position?.start;
  const end = close.position?.end;
  const position = start && end ? { position: { start, end } } : {};
  const data = { hName: tag, hProperties: { dataColor: color } };
  return tag === 'mark'
    ? { type: 'colorHighlight', color, children, data, ...position }
    : { type: 'textColor', color, children, data, ...position };
}

/**
 * `children`, each colour's HTML around text in them made one node
 * (`colored`). Tags pair as a browser would pair them, innermost first;
 * a closing tag of another kind than the last one open, or past the run,
 * leaves the rest as it is.
 */
function paired(children: readonly PhrasingContent[]): PhrasingContent[] | null {
  const open: Opened[] = [];
  const pairs = new Map<number, number>();
  for (const [i, child] of children.entries()) {
    if (child.type !== 'html') continue;
    const value = child.value;
    const named = COLOR_OPEN.exec(value);
    const tag = named?.[1];
    const color = named?.[2];
    if (tag && isColor(color)) {
      open.push({ tag, color, at: i });
      continue;
    }
    // A browser opens one even written `<span/>`.
    const other = ANY_OPEN.exec(value)?.[1];
    if (other) {
      open.push({ tag: other.toLowerCase(), color: null, at: i });
      continue;
    }
    const closing = CLOSE.exec(value)?.[1]?.toLowerCase();
    // One with nothing open closes nothing, as a browser ignores it.
    if (!closing || open.length === 0) continue;
    const last = open.pop();
    if (last?.tag !== closing) break;
    if (last.color) pairs.set(last.at, i);
  }
  if (pairs.size === 0) return null;
  type Frame = { at: number; color: ColorName | null; tag: string; children: PhrasingContent[] };
  const frames: Frame[] = [{ at: -1, color: null, tag: '', children: [] }];
  const closes = new Map([...pairs].map(([from, to]) => [to, from]));
  for (const [i, child] of children.entries()) {
    const top = frames.at(-1);
    if (!top) break;
    if (pairs.has(i) && child.type === 'html') {
      const [, tag = '', color = ''] = COLOR_OPEN.exec(child.value) ?? [];
      if (isColor(color)) frames.push({ at: i, color, tag, children: [] });
      continue;
    }
    const from = closes.get(i);
    const opener = from === undefined ? undefined : children[from];
    if (from !== undefined && top.color && opener?.type === 'html' && child.type === 'html') {
      frames.pop();
      frames.at(-1)?.children.push(colored(top.tag, top.color, top.children, opener, child));
      continue;
    }
    top.children.push(child);
  }
  return frames[0]?.children ?? null;
}

// The nodes whose children are a run of text, where HTML is inline.
const PHRASING = new Set<string>([
  'paragraph',
  'heading',
  'tableCell',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'highlight',
  'colorHighlight',
  'textColor',
]);

/** Makes each colour's HTML around text one node (`paired`), in every run of text. Without recursion. */
function pairColors(tree: Root) {
  const stack: Nodes[] = [tree];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (!('children' in node)) continue;
    const html = node.children.some((child) => child.type === 'html');
    if (html && PHRASING.has(node.type)) {
      const children = paired(node.children as PhrasingContent[]);
      if (children) (node as Parent).children = children;
    }
    for (const child of node.children) stack.push(child);
  }
}

/**
 * Reads highlights into `highlight` nodes, shown as `<mark>`, and each
 * colour's HTML around text into a `colorHighlight` or `textColor` node,
 * shown as that HTML.
 */
export const highlightFromMarkdown: FromMarkdownExtension = {
  canContainEols: ['highlight'],
  enter: {
    highlight(token) {
      this.enter({ type: 'highlight', children: [], data: { hName: 'mark' } }, token);
    },
  },
  exit: {
    highlight(token) {
      this.exit(token);
    },
  },
  transforms: [pairColors],
};

const spaced = (character: string) => character === '' || /\s/.test(character);

/**
 * `written`, text as remark wrote it with `before` and `after` written
 * beside it, with each `=` escaped that could make a highlight's `==` with
 * one next to it: both of a run of two, and every one of a run beside a `=`
 * outside the text, as a highlight's own. Two with spaces, or a line's
 * start or end, on both sides (`a == b`) can neither open nor close, and
 * stay as they are, as do a lone `=` (`x = y`) and a run of three or more
 * (`===`), which is never a highlight's. Done on what's written,
 * rather than by remark's patterns, which skip a `=` when the match before
 * took it in, or when remark escapes the character before (`\~==`).
 */
export function escapeEquals(written: string, before: string, after: string): string {
  return written.replace(/(\\*)(=+)/g, (match, slashes: string, run: string, at: number) => {
    // An odd number of backslashes escapes the run's first.
    const first = slashes.length % 2 === 1 ? 1 : 0;
    const bare = run.slice(first);
    if (!bare) return match;
    const start = at + slashes.length + first;
    const end = at + match.length;
    const previous = start > 0 ? (written[start - 1] ?? '') : before.slice(-1);
    const next = end < written.length ? (written[end] ?? '') : after.charAt(0);
    const touches = (start === 0 && previous === '=') || (end === written.length && next === '=');
    // Only two make a sequence, which can't follow a `=` written as it is.
    const inert = bare.length !== 2 || (first === 0 && spaced(previous) && spaced(next));
    if (!touches && inert) return match;
    return `${slashes}${run.slice(0, first)}${bare.replace(/=/g, '\\=')}`;
  });
}

type HandleArgs = Parameters<Handle>;

/** Text, as remark writes it, with each `=` that could make a highlight escaped (`escapeEquals`). */
const text: Handle = (node: Nodes, _, state, info) =>
  escapeEquals(state.safe('value' in node ? node.value : '', info), info.before, info.after);

/** A highlight, as `==text==`, its markers placed as `containerPhrasing` places `**`. */
function highlight(...[node, , state, info]: HandleArgs) {
  const exit = state.enter('phrasing');
  const root: Root = { type: 'root', children: [node as HighlightNode] };
  const value = state.containerPhrasing(root, info);
  exit();
  return value;
}
highlight.attention = () => ({ construct: 'highlight' as const, markers: ['='], sizes: [2] });
highlight.peek = () => '=';

/** A colour's HTML around its text, as it was read. */
function colorHtml(tag: 'span' | 'mark') {
  function handle(...[node, , state, info]: HandleArgs) {
    const colored = node as TextColorNode | ColorHighlightNode;
    if (!isColor(colored.color)) return state.containerPhrasing(colored, info);
    const tracker = state.createTracker(info);
    let value = tracker.move(`<${tag} data-color="${colored.color}">`);
    value += tracker.move(
      state.containerPhrasing(colored, { ...tracker.current(), before: '>', after: '<' }),
    );
    value += tracker.move(`</${tag}>`);
    return value;
  }
  handle.peek = () => '<';
  return handle;
}

/** Writes highlights and colours back as they're read, and escapes `=` in text that would make one. */
export const highlightToMarkdown: ToMarkdownExtension = {
  handlers: { text, highlight, colorHighlight: colorHtml('mark'), textColor: colorHtml('span') },
};
