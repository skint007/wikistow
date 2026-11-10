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
import { commentsStore, type CommentsPage } from './store';

// Above the selection, clear of it; on a touch screen, above the browser's
// own selection menu too, which the app can't add to (decision 13).
const GAP = 8;
const TOUCH_GAP = 56;

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
    document.addEventListener('selectionchange', later);
    addEventListener('scroll', later, { capture: true, passive: true });
    addEventListener('resize', later);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('selectionchange', later);
      removeEventListener('scroll', later, { capture: true });
      removeEventListener('resize', later);
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
        disabled={busy || tooLong}
        data-hint={tooLong ? 'Select at most 500 characters to comment on them' : undefined}
        aria-description={tooLong ? 'Select at most 500 characters to comment on them' : undefined}
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
 * text in `watched` changes. In the published view (`underlined`), the
 * open threads' passages found there are underlined, and a click on one
 * opens its thread.
 */
export function usePassages(
  page: CommentsPage,
  passages: Passages | null,
  watched: Element | null,
  { underlined }: { underlined: boolean },
) {
  const ctx = useClient();
  const needs = useNeedsConnection();
  const { data } = useQuery({
    ...pageCommentsQuery(ctx, page, { offline: needs.offline }),
    enabled: underlined,
  });
  useEffect(() => {
    commentsStore.setPassages(passages);
    return () => {
      if (commentsStore.get().passages === passages) commentsStore.setPassages(null);
    };
  }, [passages]);
  const [read, setRead] = useState(0);
  useEffect(() => {
    if (!watched) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        commentsStore.reread();
        setRead((n) => n + 1);
      });
    });
    observer.observe(watched, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [watched]);
  const threads = data?.threads;
  useEffect(() => {
    const root = underlined ? passages?.root() : null;
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
  }, [underlined, passages, threads, read]);
}
