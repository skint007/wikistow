import { useOffline } from '../data/connection';

/** What a control that waits for the server says offline (ADR 0009, decision 8). */
export const NEEDS_CONNECTION = 'Needs the connection';

/** What a control that waits for a page's offline change to be sent says (ADR 0009, decision 8). */
export const SENDS_FIRST = 'Waits until your change made offline is sent';

/** A control waiting, dimmed, saying why in its hint, and doing nothing. */
const waiting = (hint: string) =>
  ({ 'aria-disabled': true, 'data-hint': hint, 'aria-description': hint }) as const;

const stay = (event: { preventDefault(): void }) => event.preventDefault();

/**
 * For controls that need the server (ADR 0009, decision 8): offline, each
 * stays where it is, dimmed with "Needs the connection" as its hint
 * (`aria-disabled`, which keeps the hint showing on hover, as `disabled`
 * wouldn't), and does nothing when pressed. Spread `click(…)` on a button
 * in place of `onClick`, and `select(…)` on a menu item in place of
 * `onSelect`, which offline keeps the menu open. With `held`, why the
 * controls wait online too, as for a page with a change not sent yet.
 */
export function useNeedsConnection(held: string | null = null) {
  const offline = useOffline();
  const hint = offline ? NEEDS_CONNECTION : held;
  return {
    offline,
    click: <E extends { preventDefault(): void }>(onClick: (event: E) => void) =>
      hint ? { ...waiting(hint), onClick: stay } : { onClick },
    select: (onSelect: (event: Event) => void) =>
      hint ? { ...waiting(hint), onSelect: stay } : { onSelect },
  };
}
