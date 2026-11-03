import { useOffline } from '../data/connection';

/** What a control that waits for the server says offline (ADR 0009, decision 8). */
export const NEEDS_CONNECTION = 'Needs the connection';

/** A control waiting for the server: dimmed, saying why in its hint, and doing nothing. */
const WAITING = {
  'aria-disabled': true,
  'data-hint': NEEDS_CONNECTION,
  'aria-description': NEEDS_CONNECTION,
} as const;

const stay = (event: { preventDefault(): void }) => event.preventDefault();

/**
 * For controls that need the server (ADR 0009, decision 8): offline, each
 * stays where it is, dimmed with "Needs the connection" as its hint
 * (`aria-disabled`, which keeps the hint showing on hover, as `disabled`
 * wouldn't), and does nothing when pressed. Spread `click(…)` on a button
 * in place of `onClick`, and `select(…)` on a menu item in place of
 * `onSelect`, which offline keeps the menu open.
 */
export function useNeedsConnection() {
  const offline = useOffline();
  return {
    offline,
    click: <E extends { preventDefault(): void }>(onClick: (event: E) => void) =>
      offline ? { ...WAITING, onClick: stay } : { onClick },
    select: (onSelect: (event: Event) => void) =>
      offline ? { ...WAITING, onSelect: stay } : { onSelect },
  };
}
