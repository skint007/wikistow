import type { QuoteText } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { useNeedsConnection } from '../shell/availability';
import { useClient } from '../vault/store';
import { quoteOf } from './model';
import { clearUnderlines, pointAt, selectedIn, underline, type Passages } from './passages';
import { pageCommentsQuery } from './queries';
import {
  commentsStore,
  passagesStore,
  useCommentsStore,
  usePassagesStore,
  type CommentsPage,
} from './store';

// Above the selection, clear of it; on a touch screen, above the browser's
// own selection menu too, which the app can't add to (decision 13).
const GAP = 8;
const TOUCH_GAP = 56;

const TOO_LONG = 'Select at most 500 characters to comment on them';

type Shown = { left: number; top: number; quote: QuoteText | 'too-long' };

/**
 * The **Comment** button over a selection in the page's text (ADR 0014,
 * decisions 5 and 13), in the app's own reader or the visual editor
 * (`passages`), never over a plugin's view, which gives none. Pressed, it
 * gives `onComment` what the selection quotes.
 */
export function PassageButton({
  passages,
  onComment,
}: {
  passages: Passages | null;
  onComment: (quote: QuoteText) => Promise<void>;
}) {
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const pressing = useRef(false);
  useEffect(() => {
    if (!passages) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const root = passages.root();
      const range = root && selectedIn(root);
      const quote = range && passages.quote();
      if (!range || !quote || quote.kind === 'empty') {
        // Pressing the button may move the selection; it stays until pressed.
        if (!pressing.current) setShown(null);
        return;
      }
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const touch = matchMedia('(pointer: coarse)').matches;
      const left = Math.min(Math.max(rect.left + rect.width / 2, 48), innerWidth - 48);
      setShown({
        left,
        top: Math.max(rect.top - (touch ? TOUCH_GAP : GAP), 4),
        quote: quote.kind === 'quote' ? quote.quote : 'too-long',
      });
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    // A press that ends without a click, dragged off or turned into a
    // scroll, lets the button follow the selection again.
    const released = () =>
      setTimeout(() => {
        if (!pressing.current) return;
        pressing.current = false;
        later();
      });
    document.addEventListener('selectionchange', later);
    addEventListener('scroll', later, { capture: true, passive: true });
    addEventListener('resize', later);
    addEventListener('pointerup', released);
    addEventListener('pointercancel', released);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', later);
      removeEventListener('scroll', later, { capture: true });
      removeEventListener('resize', later);
      removeEventListener('pointerup', released);
      removeEventListener('pointercancel', released);
      setShown(null);
    };
  }, [passages]);
  if (!shown) return null;
  const tooLong = shown.quote === 'too-long';
  return createPortal(
    <div
      className="fixed z-40 -translate-x-1/2 -translate-y-full"
      style={{ left: shown.left, top: shown.top }}
    >
      <Button
        size="sm"
        className="shadow-card"
        aria-label="Comment on the selection"
        disabled={busy}
        // Dimmed, it says why on hover, as `disabled` wouldn't let it.
        {...(tooLong && {
          'aria-disabled': true,
          'data-hint': TOO_LONG,
          'aria-description': TOO_LONG,
        })}
        // The selection stays as it is while the button is pressed.
        onPointerDown={(event) => {
          event.preventDefault();
          pressing.current = true;
        }}
        onClick={() => {
          pressing.current = false;
          if (typeof shown.quote === 'string') return;
          setBusy(true);
          void onComment(shown.quote).finally(() => {
            setBusy(false);
            setShown(null);
          });
        }}
      >
        <MessageSquare strokeWidth={1.75} /> Comment
      </Button>
    </div>,
    document.body,
  );
}

/**
 * Give the comments panel the page's text while it shows (`passages`), so
 * threads' passages are found, ordered and shown, and tell it when the
 * text in `watched` changes: always where passages are underlined
 * (`underlined`), else while the panel is open, as a draft changes as it's
 * typed. Only what reads `passagesStore` hears of it, never the page,
 * whose drawing again would change its text again.
 */
export function usePassages(
  passages: Passages | null,
  watched: Element | null,
  { underlined }: { underlined: boolean },
) {
  const { open } = useCommentsStore();
  useEffect(() => {
    passagesStore.set(passages);
    return () => {
      if (passagesStore.get().passages === passages) passagesStore.set(null);
    };
  }, [passages]);
  useEffect(() => {
    if (!watched || !(underlined || open)) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        passagesStore.reread();
      });
    });
    observer.observe(watched, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [watched, underlined, open]);
}

/**
 * The passages of the page's open threads, underlined where the page as
 * read in the published view has them (`passagesStore`); a click on one
 * opens its thread.
 */
export function PassageUnderlines({ page }: { page: CommentsPage }) {
  const ctx = useClient();
  const needs = useNeedsConnection();
  const { passages, read } = usePassagesStore();
  const { data } = useQuery(pageCommentsQuery(ctx, page, { offline: needs.offline }));
  const threads = data?.threads;
  useEffect(() => {
    void read;
    const root = passages?.root();
    if (!root || !threads) return;
    const quotes = threads.flatMap((thread) => {
      const quote = thread.resolved === null ? quoteOf(thread) : null;
      return quote ? [{ key: thread.thread, quote }] : [];
    });
    const shown = underline(root, quotes);
    const click = (event: Event) => {
      if (!(event instanceof MouseEvent) || !getSelection()?.isCollapsed) return;
      if (event.target instanceof Element && event.target.closest('a, button, input, label'))
        return;
      const at = pointAt(event.clientX, event.clientY);
      const hit = at && shown.find(({ range }) => range.isPointInRange(at.node, at.offset));
      if (hit) commentsStore.open(hit.key);
    };
    root.addEventListener('click', click);
    return () => {
      root.removeEventListener('click', click);
      clearUnderlines();
    };
  }, [passages, threads, read]);
  return null;
}
