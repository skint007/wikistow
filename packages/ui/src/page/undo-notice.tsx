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
    update(next: Notice) {
      if (shown !== current) return;
      current = next;
      show(current);
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [notice]);
  // Counted again once an Undo that failed is done, so its error is read.
  useEffect(() => {
    if (!notice || notice.running || busy) return;
    const timer = setTimeout(() => shown === notice && show(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [notice, busy, error]);
  if (!notice || notice.ctx !== ctx) return null;

  async function undo(item: Notice, run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      if (shown === item) show(null);
    } catch (caught) {
      setError((item.undoMessage ?? errorMessage)(caught));
    } finally {
      setBusy(false);
    }
  }
  const { undo: undoing } = notice;
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
          <span className="text-muted-foreground">{notice.notes}</span>
        )}
      </div>
      {undoing && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void undo(notice, undoing)}
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
