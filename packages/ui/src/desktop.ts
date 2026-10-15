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
