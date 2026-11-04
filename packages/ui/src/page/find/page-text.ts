import { reveal, type Findable, type FindSession } from './findable';
import { matchesIn, matchFrom, stepped, type FindQuery, type Found, type Match } from './match';

// What a page as read shows that isn't its text: controls, what only a
// screen reader hears, and its properties (`data-find="skip"`), which Find
// on page leaves out (#276). Frames, a diagram's or a plugin block's, hold
// no text of this document anyway.
const SKIPPED =
  'button, script, style, textarea, input, select, [aria-hidden="true"], .sr-only, [data-find="skip"]';

// Where the matches are highlighted (`::highlight()` in app.css): every one,
// and over it the current one.
const MATCHES = 'find-match';
const CURRENT = 'find-current';

/** A text node of the page, at its offset in the text joined up (`readText`). */
type Piece = { node: Text; at: number };

type PageText = { text: string; pieces: Piece[] };

const inline = (display: string) => display.startsWith('inline') || display === 'contents';

const SPACE = /^\s*$/;

// Whether `block` shows its spaces as they are, as code does.
const keepsSpace = (block: Element | null) =>
  !!block && /^(pre|break-spaces)/.test(getComputedStyle(block).whiteSpace);

// Whether `element` shows nothing: one with no box of its own (`display:
// contents`) shows its children, which are asked in turn.
const hidden = (element: Element) =>
  element.checkVisibility?.({ visibilityProperty: true }) === false &&
  getComputedStyle(element).display !== 'contents';

/**
 * The text `roots` show, in order, joined up: a line break between blocks
 * (and at each `<br>`), so no match runs from one paragraph into the next,
 * as none can have a line break in it. Hidden text isn't in it.
 */
export function readText(roots: readonly Element[]): PageText {
  let text = '';
  const pieces: Piece[] = [];
  const blocks = new Map<Element, Element | null>();
  // The nearest block around `element`, which a line break in the text stands between.
  const blockOf = (element: Element | null): Element | null => {
    if (!element) return null;
    const known = blocks.get(element);
    if (known !== undefined) return known;
    const block = inline(getComputedStyle(element).display)
      ? blockOf(element.parentElement)
      : element;
    blocks.set(element, block);
    return block;
  };
  let last: Element | null = null;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(SKIPPED) || hidden(node)) return NodeFilter.FILTER_REJECT;
        return node.localName === 'br' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node instanceof Text)) {
        text += '\n';
        continue;
      }
      const block = blockOf(node.parentElement);
      // Space between blocks, as the HTML has it, which shows as nothing.
      if (block === node.parentElement && SPACE.test(node.data) && !keepsSpace(block)) continue;
      if (block !== last) {
        text += '\n';
        last = block;
      }
      pieces.push({ node, at: text.length });
      text += node.data;
    }
    text += '\n';
    last = null;
  }
  return { text, pieces };
}

/** The piece `offset` is in: for a match's start, the one it starts; for its end, the one it ends. */
function pieceAt(pieces: readonly Piece[], offset: number, end: boolean): Piece | undefined {
  let low = 0;
  let high = pieces.length - 1;
  let found: Piece | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const piece = pieces[middle]!;
    if (end ? piece.at < offset : piece.at <= offset) {
      found = piece;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Each match, as a range of the page's text nodes. */
function rangesOf({ pieces }: PageText, matches: readonly Match[]): Range[] {
  return matches.map(({ from, to }) => {
    const start = pieceAt(pieces, from, false)!;
    const end = pieceAt(pieces, to, true)!;
    const range = document.createRange();
    range.setStart(start.node, from - start.at);
    range.setEnd(end.node, to - end.at);
    return range;
  });
}

const highlights = () =>
  typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;

/** Where the reader is: the top of the box the page scrolls in, or of the window. */
function readingTop(from: Element | undefined): number {
  for (let box = from?.parentElement; box; box = box.parentElement) {
    const { overflowY } = getComputedStyle(box);
    if ((overflowY === 'auto' || overflowY === 'scroll') && box.scrollHeight > box.clientHeight)
      return Math.max(0, box.getBoundingClientRect().top);
  }
  return 0;
}

/**
 * The page as read, for Find on page: the text `roots` show (its title
 * and its body), highlighted with the CSS Custom Highlight API, so the page
 * as drawn is left as it is. It searches again as the page changes, as a
 * box is ticked or a diagram drawn, staying where it was.
 */
export function pageText(roots: () => readonly Element[]): Findable {
  return {
    replaces: false,
    open(report): FindSession {
      let query: FindQuery = { text: '', matchCase: false };
      let page: PageText = { text: '', pieces: [] };
      let matches: Match[] = [];
      let ranges: Range[] = [];
      let current: number | null = null;
      let observer: MutationObserver | null = null;
      let frame = 0;

      const found = (): Found => ({ count: matches.length, current });
      const draw = () => {
        const set = highlights();
        if (!set) return;
        set.set(MATCHES, new Highlight(...ranges));
        const shown = current === null ? undefined : ranges[current];
        const mark = shown ? new Highlight(shown) : new Highlight();
        mark.priority = 1;
        set.set(CURRENT, mark);
      };
      const show = () => {
        const range = current === null ? undefined : ranges[current];
        const element = range?.startContainer.parentElement;
        if (range && element) reveal(() => range.getBoundingClientRect(), element);
      };
      // Read the page again, keeping the current match the one at or after where it was.
      const read = (from: number | null) => {
        const shown = roots();
        page = readText(shown);
        matches = matchesIn(page.text, query);
        ranges = rangesOf(page, matches);
        if (from !== null) {
          current = matchFrom(matches, { from, to: from }, 0);
        } else {
          // The first the reader can see, or the first after it.
          const top = readingTop(shown[0]);
          const index = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
          current = matches.length === 0 ? null : index === -1 ? 0 : index;
        }
        draw();
        watch(shown);
      };
      const watch = (shown: readonly Element[]) => {
        observer?.disconnect();
        if (query.text === '') return;
        observer = new MutationObserver(() => {
          if (frame) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            const at = current === null ? null : (matches[current]?.from ?? null);
            read(at);
            report(found());
          });
        });
        for (const root of shown)
          observer.observe(root, { childList: true, subtree: true, characterData: true });
      };

      return {
        search(next) {
          // Typed on, it stays where it was, as the match grows or shrinks.
          const at =
            current !== null && next.matchCase === query.matchCase
              ? (matches[current]?.from ?? null)
              : null;
          query = next;
          read(at);
          show();
          report(found());
        },
        step(by) {
          current = stepped(matches.length, current, by);
          draw();
          show();
          report(found());
        },
        replace: () => {},
        replaceAll: () => 0,
        leave() {
          const range = current === null ? undefined : ranges[current];
          const selection = getSelection();
          if (range && selection) {
            selection.removeAllRanges();
            selection.addRange(range.cloneRange());
          }
          return false;
        },
        end() {
          observer?.disconnect();
          cancelAnimationFrame(frame);
          highlights()?.delete(MATCHES);
          highlights()?.delete(CURRENT);
        },
      };
    },
  };
}
