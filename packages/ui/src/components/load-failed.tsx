import type { UseQueryResult } from '@tanstack/react-query';
import { useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { errorMessage } from '../errors';

type Loading = Pick<
  UseQueryResult,
  'data' | 'error' | 'errorUpdateCount' | 'fetchStatus' | 'refetch'
>;

/**
 * Whether a query failed before it had anything to show. It still counts
 * while asked again: a refetch with no data clears the error until it
 * answers, and `LoadFailed` mustn't go, and take focus with it, meanwhile.
 */
export const failedToLoad = (query: Loading) =>
  query.data === undefined && query.errorUpdateCount > 0;

/**
 * Says that `what` couldn't be loaded, where it would show, with a button
 * that asks again for each of `queries` that failed to load. Queries don't
 * retry on their own (router.tsx), so without it a picker would say it's
 * loading for good. Nothing shows while none has failed.
 */
export function LoadFailed({ what, queries }: { what: string; queries: readonly Loading[] }) {
  const failed = queries.filter(failedToLoad);
  return failed.length > 0 ? <FailedLine what={what} failed={failed} /> : null;
}

const CONTROLS = 'select:enabled, input:enabled, button:enabled, [href]';

function FailedLine({ what, failed }: { what: string; failed: readonly Loading[] }) {
  const line = useRef<HTMLDivElement>(null);
  // Once it loads, the line goes, and Try again with it. Focus moves to the
  // first control after where it was, such as the list that loaded, or
  // failing that the first around it, rather than to the top of the page.
  useLayoutEffect(() => {
    const at = line.current;
    return () => {
      const around = at?.parentElement;
      if (!around || !at.contains(document.activeElement)) return;
      const before = at.previousElementSibling;
      requestAnimationFrame(() => {
        const controls = [...around.querySelectorAll<HTMLElement>(CONTROLS)];
        const after = controls.find(
          (control) =>
            !before ||
            (!before.contains(control) &&
              !!(before.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)),
        );
        (after ?? controls[0])?.focus();
      });
    };
  }, []);
  // Asked again, or waiting for the browser to be online to ask (TanStack
  // Query holds fetches meanwhile), while the error is cleared.
  const asking = failed.some((query) => query.fetchStatus === 'fetching');
  const held = failed.some((query) => query.fetchStatus === 'paused');
  const retrying = asking || held;
  const error = failed.find((query) => query.error)?.error;
  return (
    <div ref={line} role="alert" className="flex items-center gap-3 text-sm text-destructive">
      <span className="flex-1">
        Couldn’t load {what}.{' '}
        {asking
          ? 'Trying again…'
          : held
            ? 'It tries again once you’re back online.'
            : errorMessage(error)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        // Unavailable rather than disabled, so it keeps focus meanwhile.
        aria-disabled={retrying}
        className="aria-disabled:cursor-wait aria-disabled:opacity-50"
        onClick={() => {
          if (!retrying) failed.forEach((query) => void query.refetch());
        }}
      >
        Try again
      </Button>
    </div>
  );
}
