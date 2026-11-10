import {
  DIAGRAM_LANGUAGE,
  findQuote,
  QUERY_LANGUAGE,
  quoteAt,
  type QuoteAt,
  type QuoteText,
} from '@wikistow/client';
import { claimedBlock } from '@wikistow/plugin-sdk';

/**
 * Where a page's text shows, for comments on passages (ADR 0014, decision
 * 5): the app's own reader in the published view, or the visual editor in
 * the draft view. The source editor and a plugin's view give none.
 */
export type Passages = {
  /** The element the text is in, which a selection must be inside. */
  root(): Element | null;
  /** What the selection there quotes now, or null with nothing selected there. */
  quote(): QuoteAt | null;
  /**
   * Where `quote` is in the page's own text, as an offset to order threads
   * by; null when it isn't there now, and undefined while the text isn't
   * shown to tell.
   */
  find(quote: QuoteText): number | null | undefined;
  /** Select the passage and bring it into view; false when it isn't there now. */
  show(quote: QuoteText): boolean;
};

/**
 * A part of the page as read that the app or a plugin draws from outside
 * the version, marked with its source (`ownSource`), which the page's own
 * text takes in its place: a wikilink, math, a property reference, a
 * claimed span, a query table, a diagram or a plugin block.
 */
export const QUOTE_SOURCE = 'data-quote-source';
/**
 * Whether a code block in `language` is drawn from outside the version, as
 * a query table, a diagram or a plugin block is, and so reads as its fence.
 * A claimed block reads so whether its plugin runs or not.
 */
export const fencedAsSource = (language: string | undefined) =>
  !!language &&
  (language === QUERY_LANGUAGE || language === DIAGRAM_LANGUAGE || claimedBlock(language) !== null);

/** Marks such a part that stands as a block of its own. */
export const QUOTE_BLOCK = 'data-quote-block';
/** Marks the app's own reading of the body, where a passage can be chosen. */
export const QUOTE_ROOT = 'data-quote-root';

// What a page as read shows that isn't its words: controls, what only a
// screen reader hears, and the labels the app draws over code and alerts.
const SKIPPED =
  'button, script, style, textarea, input, select, [aria-hidden="true"], .sr-only, .code-language, .markdown-alert-title';

const inline = (display: string) => display.startsWith('inline') || display === 'contents';

const hidden = (element: Element) =>
  element.checkVisibility?.({ visibilityProperty: true }) === false &&
  getComputedStyle(element).display !== 'contents';

/** A text node of the body, or a part taken as its source, at its offset in the text. */
type Piece = { node: Node; at: number; length: number; atom: boolean };

export type OwnText = { text: string; pieces: Piece[] };

/**
 * The page's own text as the reader shows it in `root` (section 5.9):
 * its words, a line break between blocks, and each part marked
 * `QUOTE_SOURCE` as its source. Line breaks and tabs within a paragraph
 * read as the spaces they show as; code keeps its own.
 */
export function readOwnText(root: Element): OwnText {
  let text = '';
  const pieces: Piece[] = [];
  const separate = () => {
    if (text !== '' && !text.endsWith('\n')) text += '\n';
  };
  const visit = (node: Node, keepsSpace: boolean) => {
    if (node instanceof Text) {
      const parent = node.parentElement;
      const block = !parent || !inline(getComputedStyle(parent).display);
      // Space between blocks, as the HTML has it, which shows as nothing.
      if (!keepsSpace && block && /^\s*$/.test(node.data)) return;
      const data = keepsSpace ? node.data : node.data.replace(/[\n\r\t]/g, ' ');
      pieces.push({ node, at: text.length, length: data.length, atom: false });
      text += data;
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches(SKIPPED) || hidden(node)) return;
    if (node.localName === 'br') {
      text += '\n';
      return;
    }
    const source = node.getAttribute(QUOTE_SOURCE);
    if (source !== null) {
      const block = node.hasAttribute(QUOTE_BLOCK);
      if (block) separate();
      pieces.push({ node, at: text.length, length: source.length, atom: true });
      text += source;
      if (block) separate();
      return;
    }
    const style = getComputedStyle(node);
    const block = !inline(style.display);
    const keeps = keepsSpace || /^(pre|break-spaces)/.test(style.whiteSpace);
    if (block) separate();
    for (const child of node.childNodes) visit(child, keeps);
    if (block) separate();
  };
  visit(root, false);
  return { text, pieces };
}

/** Where `range` is in `own`'s text: a part taken as its source counts whole. */
export function offsetsOf({ pieces }: OwnText, range: Range): { from: number; to: number } | null {
  let from: number | null = null;
  let to = 0;
  for (const piece of pieces) {
    if (!range.intersectsNode(piece.node)) continue;
    const start =
      !piece.atom && range.startContainer === piece.node ? piece.at + range.startOffset : piece.at;
    const end =
      !piece.atom && range.endContainer === piece.node
        ? piece.at + range.endOffset
        : piece.at + piece.length;
    from ??= start;
    to = end;
  }
  return from === null ? null : { from, to };
}

/** The DOM range of `from` to `to` in `own`'s text, a part taken as its source whole. */
export function rangeOf({ pieces }: OwnText, from: number, to: number): Range | null {
  const first = pieces.find((p) => p.at + p.length > from);
  const last = pieces.findLast((p) => p.at < to);
  if (!first || !last) return null;
  const range = document.createRange();
  if (first.atom) range.setStartBefore(first.node);
  else range.setStart(first.node, Math.max(0, from - first.at));
  if (last.atom) range.setEndAfter(last.node);
  else range.setEnd(last.node, Math.min(last.length, to - last.at));
  return range;
}

/** The selection's range, when it is inside `root` and selects something. */
export function selectedIn(root: Element): Range | null {
  const selection = getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return root.contains(range.commonAncestorContainer) ? range : null;
}

/** Passages in the app's own reader, whose body is `root()`. */
export function readerPassages(root: () => Element | null): Passages {
  const found = (quote: QuoteText) => {
    const at = root();
    if (!at) return undefined;
    const own = readOwnText(at);
    return { own, match: findQuote(own.text, quote) };
  };
  return {
    root,
    quote() {
      const at = root();
      const range = at && selectedIn(at);
      if (!at || !range) return null;
      const own = readOwnText(at);
      const offsets = offsetsOf(own, range);
      return offsets ? quoteAt(own.text, offsets.from, offsets.to) : null;
    },
    find(quote) {
      const passage = found(quote);
      return passage && (passage.match?.from ?? null);
    },
    show(quote) {
      const passage = found(quote);
      const range = passage?.match && rangeOf(passage.own, passage.match.from, passage.match.to);
      if (!range) return false;
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
      return true;
    },
  };
}

const highlights = () =>
  typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;

/** Where the passages are underlined (`::highlight(comment-passage)` in app.css). */
const UNDERLINE = 'comment-passage';

/**
 * Underline each passage of `quotes` found in `root` with the CSS Custom
 * Highlight API, leaving the page as drawn as it is. Returns each one's
 * range, for clicks, by its key.
 */
export function underline<K>(
  root: Element,
  quotes: readonly { key: K; quote: QuoteText }[],
): { key: K; range: Range }[] {
  const own = readOwnText(root);
  const shown = quotes.flatMap(({ key, quote }) => {
    const match = findQuote(own.text, quote);
    const range = match && rangeOf(own, match.from, match.to);
    return range ? [{ key, range }] : [];
  });
  highlights()?.set(UNDERLINE, new Highlight(...shown.map((s) => s.range)));
  return shown;
}

export const clearUnderlines = () => highlights()?.delete(UNDERLINE);

/** The text position under a point, where the browser can tell. */
export function pointAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const at = document.caretPositionFromPoint(x, y);
    return at && { node: at.offsetNode, offset: at.offset };
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}
