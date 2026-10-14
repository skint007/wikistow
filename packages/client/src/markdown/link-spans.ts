// Where each link of a page is written, for Markdown export to rewrite
// (`export.ts`). Pure, and free of the rest of the client, so the web
// app's Markdown worker can load it.

import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import type { PlacedWikilink } from '../links.ts';
import { splitFrontmatter } from './frontmatter.ts';
import { parseWikilink, wikilinkSyntax } from './wikilink.ts';

type Span = { start: number; end: number };

/** A page's links, where each is written, as export finds them and compares a read-back with. */
export type LinkSpans = {
  wikilinks: PlacedWikilink[];
  /**
   * Each link, image, definition and autolink's URL, in order, whether it is
   * an image's, and where its destination is written, or where an autolink
   * outside a link's text is, with a `!` or `[` just before it that would
   * join the link it becomes, as an image or a wikilink's `[[`.
   */
  urls: {
    url: string;
    image?: true;
    destination: Span | null;
    autolink?: Span & { before?: string };
  }[];
  tables: Span[];
};

// The reader's syntax (`parseMarkdown`), made once.
const SYNTAX = [gfm(), wikilinkSyntax];

/**
 * The page's links as the reader reads them (`parseMarkdown`), and where
 * each destination is written: the label or title may hold the same text.
 * They come from the tokens the reader's tree is built from, without
 * building it, which is most of the time a read takes. As in that tree,
 * an image's text is plain: a link or wikilink in it is none. Some text
 * takes this far longer than its size suggests (#47), so the web app runs
 * it in a worker it can end.
 */
export function linkSpans(markdown: string): LinkSpans {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const offset = frontmatter?.length ?? 0;
  const document = parse({ extensions: SYNTAX }).document();
  const events = postprocess(document.write(preprocess()(body, undefined, true)));
  const wikilinks: PlacedWikilink[] = [];
  const tables: Span[] = [];
  const urls: LinkSpans['urls'] = [];
  const open: string[] = [];
  let inImageText = 0;
  let escapedTo = -1;
  for (const [kind, token, context] of events) {
    if (kind === 'exit') {
      open.pop();
      if (token.type === 'label' && open.at(-1) === 'image') inImageText--;
      continue;
    }
    if (token.type === 'label' && open.at(-1) === 'image') inImageText++;
    open.push(token.type);
    if (inImageText > 0) continue;
    const span = { start: offset + token.start.offset, end: offset + token.end.offset };
    if (token.type === 'characterEscape') escapedTo = token.end.offset;
    // GFM's token types aren't declared to micromark's types.
    switch (token.type as string) {
      case 'table':
        tables.push(span);
        break;
      case 'wikilink': {
        // As `placedWikilinks` finds them.
        const node = parseWikilink(context.sliceSerialize(token));
        if (!node || node.unsupported) break;
        const { source, target, heading, shown, embed } = node;
        wikilinks.push({ source, target, heading, shown, embed, ...span });
        break;
      }
      case 'resource':
        urls.push({ url: '', destination: null, ...(open.at(-2) === 'image' && { image: true }) });
        break;
      case 'definition':
        urls.push({ url: '', destination: null });
        break;
      case 'resourceDestinationString':
      case 'definitionDestinationString': {
        // Escapes and references decoded, as the tree has it.
        urls[urls.length - 1] = {
          ...urls.at(-1),
          url: decodeString(context.sliceSerialize(token)),
          destination: span,
        };
        break;
      }
      case 'autolink': {
        // Without its `<` and `>`, as the tree has it.
        const url = context.sliceSerialize(token).slice(1, -1);
        const before = body[token.start.offset - 1];
        const autolink =
          (before === '!' || before === '[') && escapedTo !== token.start.offset
            ? { start: span.start - 1, end: span.end, before }
            : span;
        // A link's text can't hold the link it would become, and a `]` just
        // before it would take the new label as a reference's, unlinking
        // `[foo]` there.
        const rewritable = !open.includes('label') && before !== ']';
        urls.push({ url, destination: null, ...(rewritable && { autolink }) });
        break;
      }
      case 'literalAutolink':
        urls.push({ url: context.sliceSerialize(token), destination: null });
    }
  }
  return { wikilinks, urls, tables };
}
