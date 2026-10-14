import { markdownLanguage } from '@codemirror/lang-markdown';
import { Language, LanguageSupport } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { MarkdownParser, type LeafBlockParser, type MarkdownConfig } from '@lezer/markdown';

// A `---` first line opens the frontmatter block, closed by a `---` or `...`
// line, as `splitFrontmatter` reads it, and is shown as plain text. While
// it is being written and not yet closed, it runs to the end.
const OPENING = /^---\r?$/;
const CLOSING = /^(?:---|\.\.\.)\r?$/;

const frontmatter: MarkdownConfig = {
  defineNodes: [{ name: 'Frontmatter', block: true, style: t.meta }],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !OPENING.test(line.text)) return false;
        while (cx.nextLine()) {
          if (CLOSING.test(line.text)) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd()));
        return true;
      },
    },
  ],
};

/**
 * How long a paragraph's text may be for its inline syntax (emphasis,
 * links, code, HTML and the rest) to be shown. Matching much of it can take
 * time growing with the square of the paragraph's length, and the
 * highlighter reads a paragraph again on every key typed in it: 64 KB of
 * `*a` would hold up each key over half a second (#87), of `[a](` over a
 * second and a half (#138). A heading or table cell counts as a paragraph
 * of its own.
 */
export const INLINE_LIMIT = 10_000;

// A paragraph past `INLINE_LIMIT` is shown as plain text, from its first character.
const longParagraphs: MarkdownConfig = {
  parseInline: [
    {
      name: 'PlainInLongParagraph',
      before: 'Escape',
      parse: (cx) => (cx.text.length > INLINE_LIMIT ? cx.end : -1),
    },
  ],
};

const AUTOLINK = /(www\.)|(https?:\/\/)|([\w.+-]{1,100}@)|(mailto:|xmpp:)/y;
const URL_TEXT = /[\w-]+(\.[\w-]+)+(:\d+)?(\/[^\s<]*)?/y;
const LAST_TWO_DOMAIN_WORDS = /[\w-]+\.[\w-]+($|[/:])/;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w.-]+)+/y;
const XMPP_RESOURCE = /\/[a-zA-Z\d@.]+/y;
const ENTITY = /&(?:#\d+|#x[a-f\d]+|\w+);/y;

// Where a bare URL starting at `from` ends, as GFM's `autolinkURLEnd` finds
// it: trailing punctuation, unmatched `)` and entities are left out.
function urlEnd(text: string, from: number) {
  URL_TEXT.lastIndex = from;
  const url = URL_TEXT.exec(text)?.[0];
  if (url === undefined || LAST_TWO_DOMAIN_WORDS.exec(url)?.[0].includes('_')) return -1;
  let end = from + url.length;
  // How many more `)` than `(` the URL has, counted once and kept up to date
  // as `)` are trimmed.
  let unmatched = 0;
  for (const char of url) unmatched += char === ')' ? 1 : char === '(' ? -1 : 0;
  for (;;) {
    const last = text.charAt(end - 1);
    if (/[?!.,:*_~]/.test(last)) end--;
    else if (last === ')' && unmatched > 0) {
      end--;
      unmatched--;
    } else if (last === ';') {
      // An entity's name holds no `&` or `;`, so one ending here starts at the last `&`.
      const amp = text.lastIndexOf('&', end - 1);
      ENTITY.lastIndex = amp;
      if (amp < from || !ENTITY.test(text) || ENTITY.lastIndex !== end) break;
      end = amp;
    } else break;
  }
  return end;
}

function emailEnd(text: string, from: number) {
  EMAIL.lastIndex = from;
  const email = EMAIL.exec(text)?.[0];
  if (email === undefined) return -1;
  const last = email.at(-1);
  return last === '_' || last === '-' ? -1 : from + email.length - (last === '.' ? 1 : 0);
}

// GFM's `Autolink` from `@lezer/markdown` 1.8.0, but trimming a URL's end in
// time growing with its length: the original counts the URL's parens again
// for each `)` it trims and reads it again for each entity, so `www.a.b/` and
// 10,000 `)` held up each key 200 ms or more (#154). Its name replaces GFM's.
const autolink: MarkdownConfig = {
  parseInline: [
    {
      name: 'Autolink',
      parse(cx, _next, absPos) {
        const pos = absPos - cx.offset;
        if (pos && /\w/.test(cx.text.charAt(pos - 1))) return -1;
        AUTOLINK.lastIndex = pos;
        const m = AUTOLINK.exec(cx.text);
        if (!m) return -1;
        let end: number;
        if (m[1] || m[2]) {
          // www., http://
          end = urlEnd(cx.text, pos + m[0].length);
          if (end > -1 && cx.hasOpenLink) {
            const noBracket = /([^[\]]|\[[^\]]*\])*/.exec(cx.text.slice(pos, end));
            end = pos + (noBracket?.[0].length ?? 0);
          }
        } else if (m[3]) {
          // email address
          end = emailEnd(cx.text, pos);
        } else {
          // mailto:/xmpp:
          end = emailEnd(cx.text, pos + m[0].length);
          if (end > -1 && m[0] === 'xmpp:') {
            XMPP_RESOURCE.lastIndex = end;
            const resource = XMPP_RESOURCE.exec(cx.text);
            if (resource) end = resource.index + resource[0].length;
          }
        }
        if (end < 0) return -1;
        cx.addElement(cx.elt('URL', absPos, end + cx.offset));
        return end + cx.offset;
      },
    },
  ],
};

/** How many lines a link reference definition may take to be shown as one. */
const DEFINITION_LINES = 20;

// A paragraph starting with `[` that is still a possible link reference
// definition past `DEFINITION_LINES` stops being read as one. While a
// definition's title is open, `@lezer/markdown` 1.8.0 reads it again from its
// start on each line, so `[a]: /u "` and 64 KB of lines held up each key for
// seconds (#163).
const longDefinitions: MarkdownConfig = {
  parseBlock: [
    {
      name: 'LongDefinition',
      after: 'LinkReference',
      leaf(_cx, leaf) {
        if (!leaf.content.startsWith('[')) return null;
        // Placed just after it, the last parser is LinkReference's own.
        const definition = leaf.parsers.at(-1);
        let lines = 1;
        const guard: LeafBlockParser = {
          nextLine(_cx, _line, leaf) {
            if (++lines > DEFINITION_LINES)
              leaf.parsers = leaf.parsers.filter(
                (parser) => parser !== definition && parser !== guard,
              );
            return false;
          },
          finish: () => false,
        };
        return guard;
      },
    },
  ],
};

const { parser } = markdownLanguage;
if (!(parser instanceof MarkdownParser)) throw new Error('unreachable: a Markdown parser');

/**
 * Markdown as GitHub writes it, with frontmatter, and a paragraph too long
 * to match its inline syntax quickly shown as plain text, read without the
 * parser's slow cases on bare URLs and long definitions. Built from the
 * language rather than with `markdown()`, which adds HTML, CSS and
 * JavaScript to highlight inside HTML blocks, and keys that add list or
 * quote markup on Enter: here keys type exactly what they say.
 */
export const sourceLanguage = new LanguageSupport(
  new Language(
    markdownLanguage.data,
    parser.configure([frontmatter, longParagraphs, autolink, longDefinitions]),
    [],
    'markdown',
  ),
);
