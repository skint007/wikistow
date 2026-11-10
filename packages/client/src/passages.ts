// Passages a comment is on (protocol section 5.9, ADR 0014 decision 5), as
// text: a quote's `exact` in the page's own text, with what comes just
// before and after it. The reader and the visual editor each read the
// page's own text in their own way; these rules are the same for both.
import { MAX_QUOTE, MAX_QUOTE_CONTEXT, scalarCount } from './comments.ts';

/** A quote's text, without the version it was chosen in. */
export type QuoteText = { exact: string; prefix: string; suffix: string };

/**
 * How a part the app or a plugin draws from outside the version reads in
 * the page's own text: as its source, as Markdown, never as what a viewer
 * sees there (section 5.9). Wikilinks and claimed spans hold their source
 * already.
 */
export const ownSource = {
  /** A property reference or a claimed span, as code. */
  inlineCode: (code: string) => `\`${code}\``,
  math: (tex: string, display: boolean) => (display ? `$$\n${tex}\n$$` : `$${tex}$`),
  /** A query table, a diagram or a plugin block, as its fence. */
  fence: (language: string, code: string) =>
    `\`\`\`${language}\n${code.replace(/\n$/, '')}\n\`\`\``,
};

/** The last `count` characters of `text`, cut between characters (section 3.3), never inside one. */
const lastCharacters = (text: string, count: number) => Array.from(text).slice(-count).join('');
const firstCharacters = (text: string, count: number) => Array.from(text).slice(0, count).join('');

const SPACE = /\s/;

/** What a selection from `from` to `to` in the page's own text `text` quotes. */
export type QuoteAt =
  | { kind: 'quote'; quote: QuoteText }
  /** Only spaces, or nothing. */
  | { kind: 'empty' }
  /** Longer than a quote holds (`MAX_QUOTE`). */
  | { kind: 'too-long' };

/**
 * The quote of `text` from `from` to `to`, without the spaces and line
 * breaks at its ends, with up to 64 characters on each side.
 */
export function quoteAt(text: string, from: number, to: number): QuoteAt {
  while (from < to && SPACE.test(text[from]!)) from++;
  while (to > from && SPACE.test(text[to - 1]!)) to--;
  if (from >= to) return { kind: 'empty' };
  const exact = text.slice(from, to);
  if (scalarCount(exact) > MAX_QUOTE) return { kind: 'too-long' };
  return {
    kind: 'quote',
    quote: {
      exact,
      prefix: lastCharacters(text.slice(0, from), MAX_QUOTE_CONTEXT),
      suffix: firstCharacters(text.slice(to), MAX_QUOTE_CONTEXT),
    },
  };
}

// How many characters `a` and `b` share at their ends, or at their starts.
function sharedEnd(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function sharedStart(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Where `quote` is in `text`: `exact` where its `prefix` and `suffix` fit
 * best, or else its first match (decision 5); null when `exact` isn't
 * there.
 */
export function findQuote(
  text: string,
  { exact, prefix, suffix }: QuoteText,
): { from: number; to: number } | null {
  if (exact === '') return null;
  let best: { from: number; score: number } | null = null;
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const end = at + exact.length;
    const score =
      sharedEnd(prefix, text.slice(Math.max(0, at - prefix.length), at)) +
      sharedStart(suffix, text.slice(end, end + suffix.length));
    if (!best || score > best.score) best = { from: at, score };
    if (score === prefix.length + suffix.length) break;
  }
  return best && { from: best.from, to: best.from + exact.length };
}
