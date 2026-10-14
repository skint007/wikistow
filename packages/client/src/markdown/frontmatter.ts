// Frontmatter (wikistow.md, Frontmatter): opaque text at the top of a page,
// split off before anything parses the body and joined back unchanged.

/** A page's Markdown in two parts; `(frontmatter ?? '') + body` is always the whole. */
export type SplitMarkdown = {
  /** The block's exact text, both delimiter lines and their line endings included, or null. */
  frontmatter: string | null;
  body: string;
};

const OPENING = /^---\r?\n/;
const CLOSING = /^(?:---|\.\.\.)\r?$/;

/**
 * Split `markdown` into its frontmatter and body. A page has frontmatter
 * when its first line is exactly `---` and a later line is exactly `---`
 * or `...`; otherwise a leading `---` is ordinary Markdown. Line endings
 * may be LF or CRLF and are kept as they are.
 */
export function splitFrontmatter(markdown: string): SplitMarkdown {
  const opening = OPENING.exec(markdown);
  if (!opening) return { frontmatter: null, body: markdown };
  for (let start = opening[0].length; start <= markdown.length;) {
    const newline = markdown.indexOf('\n', start);
    const end = newline < 0 ? markdown.length : newline + 1;
    if (CLOSING.test(markdown.slice(start, newline < 0 ? end : newline))) {
      return { frontmatter: markdown.slice(0, end), body: markdown.slice(end) };
    }
    if (newline < 0) break;
    start = end;
  }
  return { frontmatter: null, body: markdown };
}
