import type { Node, WikilinkNode } from 'mdast';
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type { Options as ToMarkdownExtension } from 'mdast-util-to-markdown';
import type { Code, Construct, Extension, State, Tokenizer } from 'micromark-util-types';

// Wikilinks as Markdown syntax (wikistow.md, Wikilinks): a micromark
// extension that reads `[[…]]` and `![[…]]` as one token, an mdast node
// holding what it says, and a writer that puts the source back verbatim,
// so a page round-trips byte for byte through any editor that uses them.

/** One wikilink as written. */
export type Wikilink = {
  /** The source text, `[[` to `]]` included, `!` too for an embed. */
  source: string;
  /** What it points at, before any `#` or `|`: a title, `Folder/title`, or a file name. */
  target: string;
  heading: string | null;
  shown: string | null;
  /** `![[file.png]]`: an attachment of this page, not another page. */
  embed: boolean;
};

/**
 * Obsidian forms kept verbatim as inert text: a page embed (`![[Page]]`)
 * or a block reference (`[[Page#^id]]`). They never resolve or load anything.
 */
export type UnsupportedWikilink = 'page-embed' | 'block-ref';

declare module 'mdast' {
  /** A wikilink in a page body. */
  interface WikilinkNode extends Node, Wikilink {
    type: 'wikilink';
    unsupported: UnsupportedWikilink | null;
    /**
     * Its text as written, before it resolves: the shown text, else the
     * target and heading; an unsupported form, its source. Plain-text
     * readings of a page (an image's alt, a heading's id) use it.
     */
    value: string;
  }
  interface PhrasingContentMap {
    wikilink: WikilinkNode;
  }
  interface RootContentMap {
    wikilink: WikilinkNode;
  }
}

export type { WikilinkNode };

declare module 'micromark-util-types' {
  interface TokenTypeMap {
    wikilink: 'wikilink';
  }
}

// A file name ends in an extension; anything else embedded is a page.
const FILE = /\.[A-Za-z0-9]{1,8}$/;

/** `Page › Heading`, or either alone, as a wikilink without its own text reads. */
export const withHeading = (name: string, heading: string | null) =>
  heading ? (name ? `${name} › ${heading}` : heading) : name;

/**
 * What a wikilink's source says, or null when it isn't one (`[[]]`, `[[#]]`,
 * `[[|text]]`). In a table the alias bar is written `\|`, so a backslash
 * just before the first `|` belongs to the bar, not the target.
 */
export function parseWikilink(source: string): WikilinkNode | null {
  const embed = source.startsWith('!');
  const inner = source.slice(embed ? 3 : 2, -2);
  const bar = inner.indexOf('|');
  const ref = bar < 0 ? inner : inner.slice(0, bar).replace(/\\$/, '');
  const shown = bar < 0 ? null : inner.slice(bar + 1);
  const hashAt = ref.indexOf('#');
  const target = (hashAt < 0 ? ref : ref.slice(0, hashAt)).trim();
  const heading = hashAt < 0 ? null : ref.slice(hashAt + 1).trim();
  if (target === '' && !heading) return null;
  const unsupported = heading?.startsWith('^')
    ? 'block-ref'
    : embed && !FILE.test(target)
      ? 'page-embed'
      : null;
  const value = unsupported ? source : (shown ?? withHeading(target, heading));
  return { type: 'wikilink', source, target, heading, shown, embed, unsupported, value };
}

// micromark character codes: `!`, `<`, `[`, `\`, `]`, `` ` ``, and the
// negative ones it uses for line endings (CR, LF, CRLF).
const BANG = 33;
const LESS = 60;
const OPEN = 91;
const BACKSLASH = 92;
const CLOSE = 93;
const TICK = 96;
const isLineEnding = (code: Code) => code === -5 || code === -4 || code === -3;

// What binds tighter than link brackets (CommonMark, Links) and starts at
// `<`: an autolink or a raw HTML tag. A code span does too; see `codeSpan`.
const TAGS = new Set(['autolink', 'htmlText']);

/**
 * `!?[[…]]` on one line, with no brackets inside and a source
 * `parseWikilink` accepts. Anything else is left to the other constructs,
 * so `[x](y)` is still a link and `\[[x]]` stays text. The source is judged
 * as `wikilinkFromMarkdown` will read it, serialized from the token, so a
 * tab and the virtual spaces micromark pads it with count the same in both.
 *
 * A code span, autolink or HTML tag that starts inside binds tighter, as it
 * does in a Markdown link: one that reaches past the closing `]]`
 * (`` [[a`]]` ``, `[[a<b title="]]">`) means no wikilink, while one closed
 * inside (`` [[a `b` c]] ``, `[[a <b>c]]`) is part of the target as written.
 * Each is tried once, at its first character, as micromark reads it there
 * when the brackets are text, and reading no further than it does.
 */
const tokenize: Tokenizer = function (effects, ok, nok) {
  // Where the code span, autolink or tag that started inside ends, if any.
  let tighterEnd = -1;
  // Whether this character is backslash-escaped, and the one before an unescaped backtick.
  let escaped = false;
  let afterTick = false;
  const ended =
    (ok: State): State =>
    (after) => {
      tighterEnd = this.now().offset;
      return ok(after);
    };
  const tag: Construct = {
    partial: true,
    tokenize: (effects, ok, nok) => (code) => {
      const list = code === null ? undefined : this.parser.constructs.text[code];
      const tried = (Array.isArray(list) ? list : list ? [list] : []).filter(
        ({ name }) => name && TAGS.has(name),
      );
      return tried.length ? effects.attempt(tried, ended(ok), nok)(code) : nok(code);
    },
  };
  // A run of backticks closed by the next run of the same length, on this
  // line or a later one of the paragraph, as micromark's `codeText` reads
  // it. That construct can't be tried here: it asserts that a backtick
  // before it is one micromark itself read as escaped, and `` \` `` here is not.
  const codeSpan: Construct = {
    partial: true,
    tokenize: (effects, ok, nok) => {
      let size = 0;
      let run = 0;
      const open: State = (code) => {
        if (code !== TICK) return between(code);
        size++;
        effects.consume(code);
        return open;
      };
      const between: State = (code) => {
        if (code === TICK) {
          run++;
          effects.consume(code);
          return between;
        }
        if (run === size) return ended(ok)(code);
        if (code === null) return nok(code);
        run = 0;
        effects.consume(code);
        return between;
      };
      return open;
    },
  };
  const bracket =
    (next: State): State =>
    (code) => {
      if (code !== OPEN) return nok(code);
      effects.consume(code);
      return next;
    };
  const inside: State = (code) => {
    if (code === null || isLineEnding(code) || code === OPEN) return nok(code);
    if (code === CLOSE && this.now().offset < tighterEnd) return nok(code);
    if (!escaped && this.now().offset >= tighterEnd) {
      // A run of backticks opens a code span only at its first unescaped one.
      if (code === TICK && !afterTick) return effects.check(codeSpan, step, step)(code);
      if (code === LESS) return effects.check(tag, step, step)(code);
    }
    return step(code);
  };
  const step: State = (code) => {
    afterTick = code === TICK && !escaped;
    escaped = code === BACKSLASH && !escaped;
    effects.consume(code);
    return code === CLOSE ? close : inside;
  };
  const close: State = (code) => {
    if (code !== CLOSE) return nok(code);
    effects.consume(code);
    return parseWikilink(this.sliceSerialize(effects.exit('wikilink'))) ? ok : nok;
  };
  const opening = bracket(bracket(inside));
  return (code) => {
    effects.enter('wikilink');
    if (code !== BANG) return opening(code);
    effects.consume(code);
    return opening;
  };
};

const construct = { name: 'wikilink', tokenize };

/**
 * The micromark syntax extension. It is tried before CommonMark's own
 * constructs at `[` and `!`, so `[[Page]](url)` is a wikilink and then text.
 * Nothing in a code span, HTML or an autolink that starts first is one, as
 * micromark reads those before ever reaching their `[`.
 */
export const wikilinkSyntax: Extension = { text: { [BANG]: construct, [OPEN]: construct } };

/** Turns a wikilink token into a `wikilink` mdast node. */
export const wikilinkFromMarkdown: FromMarkdownExtension = {
  enter: {
    wikilink(token) {
      // The tokenizer accepted this very source; were it ever not one, it
      // stays text rather than failing the page.
      const source = this.sliceSerialize(token);
      this.enter(parseWikilink(source) ?? { type: 'text', value: source }, token);
    },
  },
  exit: {
    wikilink(token) {
      this.exit(token);
    },
  },
};

/**
 * `source` as a table cell holds it: each `|` escaped (`\|`), as one
 * unescaped would end the cell. A link read from a cell is so already.
 */
export const inTableCell = (source: string) =>
  source.replace(/(\\*)\|/g, (bar, slashes: string) =>
    slashes.length % 2 === 0 ? `${slashes}\\|` : bar,
  );

/** Writes a `wikilink` node back exactly as it was read; in a table cell, its bars escaped. */
export const wikilinkToMarkdown: ToMarkdownExtension = {
  handlers: {
    wikilink: (node: WikilinkNode, _parent, state) =>
      state.stack.includes('tableCell') ? inTableCell(node.source) : node.source,
  },
};
