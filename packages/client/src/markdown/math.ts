import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import type { Handlers, Options as ToMarkdownExtension, Unsafe } from 'mdast-util-to-markdown';
import { math } from 'micromark-extension-math';
import type { Code, Construct, Extension, State, Token, Tokenizer } from 'micromark-util-types';

// Math as Markdown syntax (wikistow.md, Math): `$$` blocks and `$…$` or
// `$$…$$` inline, as remark-math reads them, but with a single dollar
// read by Pandoc's rule, as Obsidian, Joplin and GitHub do: it opens only
// before a character that isn't a space, and closes only after one, not
// before a digit. So `$5 and $10` stays text.

// micromark character codes: `$`, `\`, and the negative ones it uses for
// line endings (CR, LF, CRLF), a tab (-2) and its virtual spaces (-1).
const DOLLAR = 36;
const BACKSLASH = 92;
const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57;
const isLineEnding = (code: Code) => code !== null && code < -2;
const isSpace = (code: Code) => code !== null && (code < 0 || code === 32);

// remark-math's own constructs: its `$$` blocks, and inline math with at
// least two dollars, which is read as a code span is.
const { flow, text } = math({ singleDollarTextMath: false });
const [double] = [text?.[DOLLAR]].flat();
if (!double) throw new Error('micromark-extension-math has no inline math');

/**
 * Inline math between single dollars, by Pandoc's rule: `$` before
 * something not a space, up to the next `$` after something not a space
 * or backslash and before no digit, on the lines of one paragraph. Its
 * tokens are those remark-math's own makes, so `mathFromMarkdown` reads it.
 */
const tokenize: Tokenizer = function (effects, ok, nok) {
  // The last character inside, which a closing `$` must come after.
  let last: Code = null;
  let closing: Token;
  const afterOpen: State = (code) => {
    if (code === null || code === DOLLAR || isSpace(code)) return nok(code);
    effects.exit('mathTextSequence');
    return between(code);
  };
  // Between parts of the math: spaces and line endings are their own tokens, as remark-math's are.
  const between: State = (code) => {
    if (code === null) return nok(code);
    if (code === DOLLAR && last !== null && !isSpace(last) && last !== BACKSLASH) {
      closing = effects.enter('mathTextSequence');
      effects.consume(code);
      return afterClose;
    }
    if (code === 32) {
      effects.enter('space');
      effects.consume(code);
      effects.exit('space');
      last = code;
      return between;
    }
    if (isLineEnding(code)) {
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      last = code;
      return between;
    }
    effects.enter('mathTextData');
    return data(code);
  };
  const data: State = (code) => {
    const ends =
      code === null ||
      code === 32 ||
      isLineEnding(code) ||
      (code === DOLLAR && last !== null && !isSpace(last) && last !== BACKSLASH);
    if (ends) {
      effects.exit('mathTextData');
      return between(code);
    }
    effects.consume(code);
    last = code;
    return data;
  };
  // A `$` before a digit doesn't close it: it's part of the math.
  const afterClose: State = (code) => {
    if (isDigit(code)) {
      closing.type = 'mathTextData';
      last = DOLLAR;
      return data(code);
    }
    effects.exit('mathTextSequence');
    effects.exit('mathText');
    return ok(code);
  };
  return (code) => {
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    effects.consume(code);
    return afterOpen;
  };
};

const single: Construct = {
  name: 'mathText',
  tokenize,
  ...(double.resolve && { resolve: double.resolve }),
  ...(double.previous && { previous: double.previous }),
};

/** The micromark extension reading math: blocks, and inline math by `single` or remark-math's `$$`. */
export const mathSyntax: Extension = { flow, text: { [DOLLAR]: [single, double] } };

export { mathFromMarkdown };
export type { InlineMath, Math as MathBlock } from 'mdast-util-math';

// A `$` in text that could close inline math: after something not a space,
// before no digit. Escaping each, no two in text make math. So is each next
// to another, which could make a `$$`. Prices (`$5 and $10`) stay as typed.
const UNSAFE: Unsafe[] = [
  { character: '$', before: '\\S', after: '\\D|$', inConstruct: 'phrasing' },
  { character: '$', after: '\\$', inConstruct: 'phrasing' },
  { character: '$', before: '\\$', inConstruct: 'phrasing' },
  { atBreak: true, character: '$', after: '\\$' },
];

// Inline math that reads back between single dollars: no space at either
// end, no dollar or line ending inside, no backslash ending it.
const SINGLE = /^[^\s$](?:[^$\r\n]*[^\s$\\])?$/;

const written = mathToMarkdown({ singleDollarTextMath: false }).handlers ?? {};
type InlineArgs = Parameters<Handlers['inlineMath']>;

/** Inline math between single dollars where it reads back so, before no digit; else remark-math's `$$`. */
function inlineMath(...[node, parent, state, info]: InlineArgs) {
  if (SINGLE.test(node.value) && !/^\d/.test(info.after)) return `$${node.value}$`;
  return written.inlineMath?.(node, parent, state, info) ?? '';
}
inlineMath.peek = () => '$';

/**
 * Writes math as remark-math does, inline math between single dollars where
 * it can be (`inlineMath`), and escapes only the dollars in text that could
 * make math (`UNSAFE`). Where a block holds inline math, a dollar in its
 * text that could open math could close at that math's end, so the visual
 * editor escapes those too.
 */
export const mathToMarkdownExtension: ToMarkdownExtension = {
  unsafe: UNSAFE,
  handlers: { ...written, inlineMath },
};
