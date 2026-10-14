import type { DesktopBridge } from '@wikistow/contracts';

declare global {
  interface Window {
    wikistowDesktop?: DesktopBridge;
  }
}

/**
 * The desktop app's bridge (`DesktopBridge`) when these pages run inside it,
 * or null in a browser. Only the few things that differ check it: signing in
 * through the system browser, and forgetting the session on sign-out.
 * Outside a page (the unit tests) there is none either.
 */
export const desktop: DesktopBridge | null =
  typeof window === 'undefined' ? null : (window.wikistowDesktop ?? null);
