import type { FindQuery, Found } from './match';

/**
 * One search of something Find on page can search, the page as read or an
 * editor, open while the bar is: it highlights every match and tells
 * `report` what it found, again whenever that changes (the text was
 * edited, or the cursor moved), until `end`.
 */
export type FindSession = {
  /** Look for `query`, from where the reader or the cursor is; an empty text finds nothing. */
  search(query: FindQuery): void;
  /** Go to the next match (1) or the one before (-1), around the end, and show it. */
  step(by: 1 | -1): void;
  /** Put `text` in place of the current match, if one is, and go to the next. */
  replace(text: string): void;
  /** Put `text` in place of every match, as one edit; how many were. */
  replaceAll(text: string): number;
  /**
   * Leave the bar for what it searched, the current match selected there.
   * True if that took the focus, as an editor does.
   */
  leave(): boolean;
  /** Take the highlights away. */
  end(): void;
};

export type Findable = {
  /** Whether it can replace what it finds: an editor can, the page as read can't. */
  replaces: boolean;
  open(report: (found: Found) => void): FindSession;
};

// Room left above and below a match brought into view, where the find bar
// and the page's toolbar may float over it.
const MARGIN = 80;

const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll';

/**
 * Scroll `rect`, a match's, into the middle of each box `from` scrolls in,
 * and of the window, unless it's already well inside it.
 */
export function reveal(rect: () => DOMRect, from: Element) {
  for (let box: Element | null = from; box; box = box.parentElement) {
    if (box === document.scrollingElement || box === document.body) break;
    const style = getComputedStyle(box);
    const y = scrolls(style.overflowY) && box.scrollHeight > box.clientHeight;
    const x = scrolls(style.overflowX) && box.scrollWidth > box.clientWidth;
    if (!x && !y) continue;
    const at = rect();
    const frame = box.getBoundingClientRect();
    const margin = Math.min(MARGIN, frame.height / 4);
    const top =
      y && (at.top < frame.top + margin || at.bottom > frame.bottom - margin)
        ? at.top - (frame.top + frame.height / 2)
        : 0;
    const left =
      x && (at.left < frame.left || at.right > frame.right)
        ? at.left - (frame.left + frame.width / 2)
        : 0;
    // At once, as the next box out measures where it is now.
    if (top || left) box.scrollBy({ top, left, behavior: 'instant' });
  }
  const at = rect();
  const height = window.innerHeight;
  const margin = Math.min(MARGIN, height / 4);
  if (at.top < margin || at.bottom > height - margin)
    window.scrollBy({ top: at.top - height / 2, behavior: 'instant' });
}
