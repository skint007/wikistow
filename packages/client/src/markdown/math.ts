import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math';
import type { Handlers, Options as ToMarkdownExtension, Unsafe } from 'mdast-util-to-markdown';
import { math } from 'micromark-extension-math';
import type {
  Code,
  Construct,
  Effects,
  Extension,
  State,
  Token,
  Tokenizer,
} from 'micromark-util-types';

// Math as Markdown syntax (wikistow.md, Math): `$$` blocks and `$…$` or
// `$$…$$` inline, as remark-math reads them, but with a single dollar
// read by Pandoc's rule, as Obsidian, Joplin and GitHub do: it opens only
// before a character that isn't a space, and closes only after one, not
// before a digit. So `$5 and $10` stays text. A block's fences may share
// a line with its TeX, as those apps allow.

// micromark character codes: `$`, `\`, and the negative ones it uses for
// line endings (CR, LF, CRLF), a tab (-2) and its virtual spaces (-1).
const DOLLAR = 36;
const BACKSLASH = 92;
const isDigit = (code: Code) => code !== null && code >= 48 && code <= 57;
const isLineEnding = (code: Code) => code !== null && code < -2;
const isSpace = (code: Code) => code !== null && (code < 0 || code === 32);

// remark-math's own inline math with at least two dollars, which is read
// as a code span is.
const { text } = math({ singleDollarTextMath: false });
const [double] = [text?.[DOLLAR]].flat();
if (!double) throw new Error('micromark-extension-math has no inline math');

/**
 * Inline math between single dollars, by Pandoc's rule: `$` before
 * something not a space, up to the next `$` after something not a space
 * or backslash and before no digit, on the lines of one paragraph. Its
 * tokens are those remark-math's own makes, so `mathFromMarkdownExtension` reads it.
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

// The next line, unless it's a lazy one (a paragraph's, in a quote it isn't marked as in).
const nonLazyContinuation: Construct = {
  partial: true,
  tokenize(effects, ok, nok) {
    const lineStart: State = (code) => (this.parser.lazy[this.now().line] ? nok(code) : ok(code));
    return (code) => {
      if (code === null) return ok(code);
      effects.enter('lineEnding');
      effects.consume(code);
      effects.exit('lineEnding');
      return lineStart;
    };
  },
};

/**
 * A math block: a line of two dollars or more, up to a line ending with as
 * many, the TeX between, or all of it on one line (`$$x$$`). Anything else
 * on its first line makes that line text, so a price (`$$$ dinner`) hides
 * nothing and a paragraph may start with inline math (`$$x$$ is…`). As a
 * code fence does, one no line closes goes on to its container's end: a
 * block can't turn out not to be one after its first line, as micromark
 * can't take back the lines after it. Its tokens are remark-math's.
 */
const tokenizeBlock: Tokenizer = function (effects, ok, nok) {
  const tail = this.events.at(-1);
  const indent =
    tail && tail[1].type === 'linePrefix' ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let size = 0;
  let firstLine = true;
  let spaces = 0;

  // A closing fence: as many dollars or more, ending the line, spaces aside.
  const closing: Construct = {
    partial: true,
    tokenize(effects, ok, nok) {
      let count = 0;
      const sequence: State = (code) => {
        if (code === DOLLAR) {
          count++;
          effects.consume(code);
          return sequence;
        }
        if (count < size) return nok(code);
        effects.exit('mathFlowFenceSequence');
        return trailing(code);
      };
      const trailing = whitespace(effects, (code) => {
        if (code !== null && !isLineEnding(code)) return nok(code);
        effects.exit('mathFlowFence');
        return ok(code);
      });
      return whitespace(effects, (code) => {
        if (code !== DOLLAR) return nok(code);
        effects.enter('mathFlowFence');
        effects.enter('mathFlowFenceSequence');
        return sequence(code);
      });
    },
  };

  const after: State = (code) => {
    effects.exit('mathFlow');
    return ok(code);
  };
  const lineEnd: State = (code) => {
    // Interrupting a paragraph, the first line says.
    if (firstLine && this.interrupt) return ok(code);
    firstLine = false;
    if (code === null) return after(code);
    return effects.attempt(nonLazyContinuation, lineStart, after)(code);
  };
  // As much of a line's indent as the opening fence had goes.
  const lineStart: State = (code) => {
    if (spaces < indent && (code === 32 || code === -1 || code === -2)) {
      if (spaces === 0) effects.enter('linePrefix');
      spaces++;
      effects.consume(code);
      return lineStart;
    }
    if (spaces > 0) effects.exit('linePrefix');
    spaces = 0;
    return beforeChunk(code);
  };
  const beforeChunk: State = (code) => {
    if (code === null || isLineEnding(code)) return lineEnd(code);
    if (code === DOLLAR || isSpace(code)) return effects.attempt(closing, after, chunkStart)(code);
    return chunkStart(code);
  };
  const chunkStart: State = (code) => {
    effects.enter('mathFlowValue');
    effects.consume(code);
    return chunk;
  };
  const chunk: State = (code) => {
    if (code === null || isLineEnding(code)) {
      effects.exit('mathFlowValue');
      return firstLine ? nok(code) : lineEnd(code);
    }
    if (code === DOLLAR) {
      effects.exit('mathFlowValue');
      return effects.attempt(closing, after, firstLine ? nok : chunkStart)(code);
    }
    effects.consume(code);
    return chunk;
  };
  const opening: State = (code) => {
    if (code === DOLLAR) {
      size++;
      effects.consume(code);
      return opening;
    }
    if (size < 2) return nok(code);
    effects.exit('mathFlowFenceSequence');
    return whitespace(effects, (code) => {
      effects.exit('mathFlowFence');
      return beforeChunk(code);
    })(code);
  };
  return (code) => {
    effects.enter('mathFlow');
    effects.enter('mathFlowFence');
    effects.enter('mathFlowFenceSequence');
    return opening(code);
  };
};

/** Spaces and tabs, if any, as one `whitespace` token, then `next`. */
function whitespace(effects: Effects, next: State): State {
  const inside: State = (code) => {
    if (code === 32 || code === -1 || code === -2) {
      effects.consume(code);
      return inside;
    }
    effects.exit('whitespace');
    return next(code);
  };
  return (code) => {
    if (code !== 32 && code !== -1 && code !== -2) return next(code);
    effects.enter('whitespace');
    return inside(code);
  };
}

const block: Construct = { name: 'mathFlow', tokenize: tokenizeBlock, concrete: true };

/** The micromark extension reading math: blocks (`block`), and inline math by `single` or remark-math's `$$`. */
export const mathSyntax: Extension = {
  flow: { [DOLLAR]: block },
  text: { [DOLLAR]: [single, double] },
};

const fromMarkdown = mathFromMarkdown();

/**
 * Reads math into `math` and `inlineMath` nodes, as remark-math does. In a
 * table cell, `\|` in inline math is a `|`, as it is in inline code, since
 * a bare one ends the cell.
 */
export const mathFromMarkdownExtension: FromMarkdownExtension = {
  ...fromMarkdown,
  exit: {
    ...fromMarkdown.exit,
    mathText(token) {
      fromMarkdown.exit?.['mathText']?.call(this, token);
      const node = this.stack.at(-1);
      const math = node && 'children' in node ? node.children.at(-1) : undefined;
      if (!this.data.inTable || math?.type !== 'inlineMath') return;
      math.value = math.value.replace(/\\\|/g, '|');
      math.data = { ...math.data, hChildren: [{ type: 'text', value: math.value }] };
    },
  },
};
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
  const math =
    SINGLE.test(node.value) && !/^\d/.test(info.after)
      ? `$${node.value}$`
      : (written.inlineMath?.(node, parent, state, info) ?? '');
  // In a table cell, a bar is escaped, as GFM writes one in inline code.
  return state.stack.includes('tableCell') ? math.replace(/\|/g, '\\$&') : math;
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
