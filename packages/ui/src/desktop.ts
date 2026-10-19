import { queryOptions } from '@tanstack/react-query';
import type { DesktopBridge } from '@wikistow/contracts';

declare global {
  interface Window {
    wikistowDesktop?: DesktopBridge;
  }
}

/**
 * The desktop app's bridge (`DesktopBridge`) when these pages run inside it,
 * or null in a browser. Only the few things that differ check it: signing in
 * through the system browser, forgetting the session on sign-out, and the
 * account menu's update notice. Outside a page (the unit tests) there is none either.
 */
export const desktop: DesktopBridge | null =
  typeof window === 'undefined' ? null : (window.wikistowDesktop ?? null);

/** Where a hint cuts a long address short. */
const LONGEST_ADDRESS = 200;

/**
 * Where a link goes, as its hint (`data-hint`), in the desktop app: it has
 * no status bar showing it, as a browser does, so in a browser there's none.
 * A link to a page of the wiki gives the page's name, not its `app://` address.
 * A long address wraps after a slash (a zero-width space), not mid-word.
 */
export function linkHint(where: string) {
  if (!desktop) return undefined;
  const shown = where.length > LONGEST_ADDRESS ? `${where.slice(0, LONGEST_ADDRESS - 1)}…` : where;
  return shown.replaceAll(/\/(?!\/)/g, '/\u200B');
}

/**
 * A newer desktop release than the one running, as the app last found it
 * (`DesktopBridge.update`); always null in a browser, where updating is the
 * server's business. The app checks every few hours; asking it is only IPC.
 */
export const desktopUpdateQuery = queryOptions({
  queryKey: ['desktop-update'],
  queryFn: () => desktop?.update() ?? null,
  enabled: desktop !== null,
  refetchInterval: 60 * 60_000,
});
