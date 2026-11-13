import { CaseSensitive, ChevronDown, ChevronUp, X } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { desktop } from '../../desktop';
import { usePhoneLayout } from '../../shell/phone-layout';
import { isApple } from '../../shell/search-model';
import type { Findable, FindSession } from './findable';
import { foundText, isFindKey, NOTHING_FOUND, type FindQuery, type Found } from './match';

/**
 * Find on page for one page view (#276): what it searches, the page as
 * read or the editor shown (the last given), and who opens the bar. Kept
 * apart from the page's own state, so opening the bar or typing in it
 * draws nothing of the page again.
 */
export class PageFind {
  #targets: Findable[] = [];
  #listeners = new Set<() => void>();
  #openers = new Set<(from: Element | null) => void>();

  /** What the bar searches now, if anything. */
  target = (): Findable | null => this.#targets.at(-1) ?? null;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /** Search `target` while it's there; the returned function takes it away. */
  add(target: Findable): () => void {
    this.#targets.push(target);
    this.#told();
    return () => {
      this.#targets = this.#targets.filter((t) => t !== target);
      this.#told();
    };
  }

  /**
   * Open the bar, or focus it again, its text selected; closed, the focus
   * goes back to `from`, else to where it was.
   */
  open = (from: Element | null = null) => {
    for (const opener of this.#openers) opener(from);
  };

  onOpen(opener: (from: Element | null) => void): () => void {
    this.#openers.add(opener);
    return () => void this.#openers.delete(opener);
  }

  #told() {
    for (const listener of this.#listeners) listener();
  }
}

export const PageFindContext = createContext<PageFind | null>(null);

/** Let the page's find bar search `target` while it's given; nothing outside a page view. */
export function useFindTarget(target: Findable | null | undefined) {
  const find = useContext(PageFindContext);
  useEffect(() => {
    if (find && target) return find.add(target);
  }, [find, target]);
}

/** Whether a key pressed in `target` belongs to a dialog over the page, which keeps its own keys. */
const inDialog = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest('[role="dialog"], [role="alertdialog"]');

/**
 * The find bar: Ctrl+F (Cmd+F on a Mac) opens it over the page view, as
 * Find on page in the page's menu does, and the desktop app's Edit menu
 * on a Mac. It highlights every match as the text is typed, goes from one
 * to the next with Enter (back with Shift+Enter), and in an editor
 * replaces them. Escape closes it, leaving the current match selected.
 */
export function FindBar({ find }: { find: PageFind }) {
  const target = useSyncExternalStore(find.subscribe, find.target);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [found, setFound] = useState<Found>(NOTHING_FOUND);
  // What the last Replace all did, said until the next search.
  const [said, setSaid] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  // Where the focus was before the bar took it, to go back to.
  const opener = useRef<Element | null>(null);
  const session = useRef<FindSession | null>(null);
  const query = useRef<FindQuery>({ text, matchCase });
  useLayoutEffect(() => {
    query.current = { text, matchCase };
  });
  const [focusing, focus] = useReducer((n: number) => n + 1, 0);
  // The phone layout scrolls the window, not the page's card.
  const narrow = usePhoneLayout();

  useEffect(
    () =>
      find.onOpen((from) => {
        const active = document.activeElement;
        if (from) opener.current = from;
        else if (!bar.current?.contains(active)) opener.current = active;
        setOpen(true);
        focus();
      }),
    [find],
  );

  // After a frame, as a menu item that opened it closes its menu first.
  useEffect(() => {
    if (focusing === 0) return;
    const frame = requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusing]);

  useEffect(() => {
    const apple = isApple();
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || !isFindKey(event, apple) || inDialog(event.target)) return;
      event.preventDefault();
      find.open();
    };
    window.addEventListener('keydown', keydown, true);
    const stop = desktop?.onFind(() => find.open());
    return () => {
      window.removeEventListener('keydown', keydown, true);
      stop?.();
    };
  }, [find]);

  // One search while the bar is open, of what it searches now: the page
  // as read, or the editor shown, which turning to another changes.
  useEffect(() => {
    if (!open || !target) {
      setFound(NOTHING_FOUND);
      return;
    }
    const opened = target.open(setFound);
    session.current = opened;
    opened.search(query.current);
    return () => {
      opened.end();
      if (session.current === opened) session.current = null;
    };
  }, [open, target]);

  const search = (next: FindQuery) => {
    setSaid(null);
    session.current?.search(next);
  };
  const close = () => {
    const took = session.current?.leave() ?? false;
    setOpen(false);
    setSaid(null);
    const back = opener.current;
    opener.current = null;
    if (!took && back instanceof HTMLElement && back.isConnected && back !== document.body)
      back.focus();
  };
  const replaceAll = () => {
    const count = session.current?.replaceAll(replacement) ?? 0;
    if (count > 0) setSaid(count === 1 ? 'Replaced 1' : `Replaced ${count}`);
  };
  const keys = (event: KeyboardEvent, enter: (back: boolean) => void) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      enter(event.shiftKey);
    }
  };

  if (!open) return null;
  const none = found.count === 0;
  const replaces = target?.replaces ?? false;
  // Not `disabled`, which would drop the focus as the last match goes.
  const unless = (off: boolean, action: () => void) => ({
    'aria-disabled': off,
    onClick: () => {
      if (!off) action();
    },
  });
  const shown = (
    <div
      ref={bar}
      role="search"
      aria-label="Find on page"
      className={cn(
        'grid gap-1.5 rounded-control bg-popover p-1.5 text-popover-foreground shadow-card ring-1 ring-border',
        narrow
          ? 'fixed inset-x-2 top-[calc(var(--titlebar-height)+3.75rem)] z-30'
          : 'absolute top-[4.25rem] right-4 w-[min(26rem,calc(100%-2rem))]',
      )}
    >
      <div className="flex items-center gap-1">
        <Input
          ref={input}
          aria-label="Find on page"
          placeholder="Find on page"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            search({ text: event.target.value, matchCase });
          }}
          onKeyDown={(event) => keys(event, (back) => session.current?.step(back ? -1 : 1))}
          className="h-8 flex-1"
        />
        <span
          aria-live="polite"
          className="min-w-[4.5rem] text-center text-xs whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {said ?? foundText(found, text)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous match"
          data-hint="Previous match (Shift+Enter)"
          {...unless(none, () => session.current?.step(-1))}
        >
          <ChevronUp strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next match"
          data-hint="Next match (Enter)"
          {...unless(none, () => session.current?.step(1))}
        >
          <ChevronDown strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Match case"
          data-hint="Match case"
          aria-pressed={matchCase}
          className="aria-pressed:bg-muted aria-pressed:text-foreground"
          onClick={() => {
            setMatchCase(!matchCase);
            search({ text, matchCase: !matchCase });
          }}
        >
          <CaseSensitive strokeWidth={1.75} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close find"
          data-hint="Close (Escape)"
          onClick={close}
        >
          <X strokeWidth={1.75} />
        </Button>
      </div>
      {replaces && (
        <div className="flex items-center gap-1">
          <Input
            aria-label="Replace with"
            placeholder="Replace with"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => keys(event, () => session.current?.replace(replacement))}
            className="h-8 flex-1"
          />
          <Button
            variant="secondary"
            size="sm"
            {...unless(none, () => session.current?.replace(replacement))}
          >
            Replace
          </Button>
          <Button variant="secondary" size="sm" {...unless(none, replaceAll)}>
            Replace all
          </Button>
        </div>
      )}
    </div>
  );
  // Where the window scrolls, under the top bar; the page's card holds
  // what's fixed in it (it's a container), so the bar goes outside it.
  if (narrow) return createPortal(shown, document.body);
  // Elsewhere as tall as nothing, at the top of the card, so it stays
  // over the page as the card scrolls.
  return <div className="sticky top-0 z-20 h-0">{shown}</div>;
}
