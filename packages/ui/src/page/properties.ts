import { lineBreakOf } from './editor/surface';

// Frontmatter as the draft view edits it (wikistow.md, Frontmatter): the
// block's text is changed only between its delimiters, and joined back to
// the body as it was.

// A frontmatter block in three parts, each exactly as written: its opening
// line, the lines between, and its closing line (`---` or `...`, with its
// line break if it has one).
function partsOf(block: string) {
  const open = /^---\r?\n/.exec(block)?.[0] ?? '';
  const rest = block.slice(open.length);
  const lastLine = rest.replace(/\n$/, '').lastIndexOf('\n') + 1;
  return { open, between: rest.slice(0, lastLine), close: rest.slice(lastLine) };
}

/** What a Properties box shows of a frontmatter block: the text between its delimiters. */
export const propertiesText = (block: string) => partsOf(block).between.replace(/\r?\n$/, '');

/**
 * `block` with `text` between its delimiters, its delimiter lines kept as
 * they are and each line ending as its opening line does.
 */
export function withProperties(block: string, text: string): string {
  const { open, close } = partsOf(block);
  const lineBreak = open.endsWith('\r\n') ? '\r\n' : '\n';
  return `${open}${text === '' ? '' : text.replace(/\r?\n/g, lineBreak) + lineBreak}${close}`;
}

/** A frontmatter block with nothing in it. */
export const emptyProperties = (lineBreak: string) => `---${lineBreak}---${lineBreak}`;

/** A page's whole text from its frontmatter, if any, and its body. */
export function joinPage(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  // A closing line with no line break needs one before any body.
  const end = body !== '' && !frontmatter.endsWith('\n') ? lineBreakOf(frontmatter) : '';
  return `${frontmatter}${end}${body}`;
}
