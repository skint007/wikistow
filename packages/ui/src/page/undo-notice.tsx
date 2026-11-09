import type { ClientContext } from '@wikistow/client';
import { X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '../errors';

/**
 * What the notice says: something that is happening (`running`), that
 * happened, with a way to take it back (`undo`), or that failed (`failed`).
 */
export type Notice = {
  ctx: ClientContext;
  message: ReactNode;
  /** One-line notes under it, such as who else can read it now. */
  notes?: ReactNode;
  /** Takes it back. Its error is said in the notice, in this app's words. */
  undo?: () => Promise<void>;
  undoMessage?: (error: unknown) => string;
  /** While it runs, the notice stays. */
  running?: boolean;
  failed?: boolean;
};

let shown: Notice | null = null;
const listeners = new Set<() => void>();
const show = (next: Notice | null) => {
  shown = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Show `notice` in place of any other. The handle changes or closes it
 * while it is still the one shown, so a later notice isn't overwritten.
 */
export function showNotice(notice: Notice) {
  let current = notice;
  show(current);
  return {
    /** False when another notice took its place, which it leaves be. */
    update(next: Notice) {
      if (shown !== current) return false;
      current = next;
      show(current);
      return true;
    },
    close() {
      if (shown === current) show(null);
    },
  };
}

// How long a notice stays once whatever it says is done.
const SHOWN_MS = 10_000;

/**
 * The notice in the bottom corner after a delete, a move or a copy: what
 * happened, and Undo. It goes after 10 seconds, or when the vault session it
 * was made in ends; one that says something is running stays until it's done.
 */
export function UndoNotice({ ctx }: { ctx: ClientContext }) {
  const notice = useSyncExternalStore(subscribe, () => shown);
  // An Undo's progress and failure belong to its own notice, not a later one.
  const [undoing, setUndoing] = useState<{
    of: Notice;
    busy: boolean;
    error: string | null;
  } | null>(null);
  const busy = undoing !== null && undoing.of === notice && undoing.busy;
  const error = undoing !== null && undoing.of === notice ? undoing.error : null;
  // Counted again once an Undo that failed is done, so its error is read.
  useEffect(() => {
    if (!notice || notice.running || busy) return;
    const timer = setTimeout(() => shown === notice && show(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [notice, busy, error]);
  if (!notice || notice.ctx !== ctx) return null;

  async function undo(item: Notice, run: () => Promise<void>) {
    setUndoing({ of: item, busy: true, error: null });
    try {
      await run();
      if (shown === item) show(null);
      setUndoing((now) => (now?.of === item ? null : now));
    } catch (caught) {
      const error = (item.undoMessage ?? errorMessage)(caught);
      // Its notice went meanwhile: the failure takes the corner itself.
      if (shown !== item) showNotice({ ctx: item.ctx, message: error, failed: true });
      else setUndoing((now) => (now?.of === item ? { of: item, busy: false, error } : now));
    }
  }
  const { undo: takeBack } = notice;
  return (
    <div
      role={notice.failed || error ? 'alert' : 'status'}
      className="fixed bottom-4 left-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-card bg-card py-2 pr-2 pl-4 text-sm shadow-card min-[900px]:left-20"
    >
      <div className="grid min-w-0 gap-0.5">
        <span className={notice.failed || error ? 'text-destructive' : undefined}>
          {error ?? (busy ? 'Putting it back…' : notice.message)}
        </span>
        {notice.notes && !error && !busy && (
          <div className="text-muted-foreground">{notice.notes}</div>
        )}
      </div>
      {takeBack && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void undo(notice, takeBack)}
        >
          Undo
        </Button>
      )}
      {!notice.running && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          disabled={busy}
          onClick={() => show(null)}
        >
          <X strokeWidth={1.75} />
        </Button>
      )}
    </div>
  );
}
