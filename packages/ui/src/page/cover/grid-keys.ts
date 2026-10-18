import type { KeyboardEvent, RefObject } from 'react';

/**
 * Arrow keys through a picker's grid of `columns` buttons, those inside
 * `grid` marked `[data-pick]`, and from the first row up to `search`.
 */
export function moveInGrid(
  event: KeyboardEvent,
  {
    grid,
    search,
    columns,
  }: {
    grid: RefObject<HTMLElement | null>;
    search: RefObject<HTMLInputElement | null>;
    columns: number;
  },
) {
  const steps: Record<string, number> = {
    ArrowRight: 1,
    ArrowLeft: -1,
    ArrowDown: columns,
    ArrowUp: -columns,
  };
  const step = steps[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const all = [...(grid.current?.querySelectorAll<HTMLElement>('[data-pick]') ?? [])];
  const at = all.findIndex((button) => button === document.activeElement);
  const next = at + step;
  if (next < 0) search.current?.focus();
  else all[Math.min(next, all.length - 1)]?.focus();
}

/** The first of a picker's grid buttons, for ArrowDown from its search box. */
export const firstInGrid = (grid: RefObject<HTMLElement | null>) =>
  grid.current?.querySelector<HTMLElement>('[data-pick]');
