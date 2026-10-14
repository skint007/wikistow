import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react';
import { sharingMessage } from './messages';

// Tells the dialog around an action that it is running, so it stays open.
const Hold = createContext<((held: boolean) => void) | null>(null);

/**
 * Keep a dialog open while an action in it runs, so its outcome is always
 * seen: put `HoldOpen value={hold}` around the content and pass `locked`
 * to `DialogContent`. Every `useAction` inside holds it while it runs.
 */
export function useHoldOpen() {
  const [held, setHeld] = useState(0);
  const hold = useCallback((on: boolean) => setHeld((n) => Math.max(0, n + (on ? 1 : -1))), []);
  return { locked: held > 0, hold };
}

export const HoldOpen = Hold;

/**
 * Holds a dialog (`hold`) from the first of overlapping runs starting to the
 * last one finishing, so one run ending can't let go for another. `start`
 * returns the run's `finish`. `drop` lets go at once, when the component
 * that started them goes; runs from before it no longer count.
 */
function runHold(hold: ((held: boolean) => void) | null) {
  let running = 0;
  let generation = 0;
  return {
    start() {
      if (running++ === 0) hold?.(true);
      const started = generation;
      return () => {
        if (started === generation && --running === 0) hold?.(false);
      };
    },
    drop() {
      if (running > 0) hold?.(false);
      running = 0;
      generation += 1;
    },
  };
}

/**
 * Run an owner action, with its failure as a clear message (`describe`,
 * sharing's words unless given). `run` resolves whether it succeeded.
 * `busy` and the hold on the dialog around it last from the first run
 * starting to the last one finishing, or until the component that started
 * them goes (their outcome showing in what replaced it).
 */
export function useAction(describe: (error: unknown) => string = sharingMessage) {
  const hold = use(Hold);
  const [running, setRunning] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const holding = useMemo(() => runHold(hold), [hold]);
  useEffect(() => () => holding.drop(), [holding]);
  const run = useCallback(
    async (action: () => Promise<void>): Promise<boolean> => {
      setRunning((n) => n + 1);
      setError(null);
      const finish = holding.start();
      try {
        await action();
        return true;
      } catch (caught) {
        setError(describe(caught));
        return false;
      } finally {
        setRunning((n) => n - 1);
        finish();
      }
    },
    [holding, describe],
  );
  return { busy: running > 0, error, setError, run };
}

/** A failure line under a form. */
export function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}
