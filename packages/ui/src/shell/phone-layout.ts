import { useSyncExternalStore } from 'react';

/**
 * Where the app takes its phone layout (`app-shell.tsx`, `min-[900px]`):
 * the rail and sidebar in a drawer behind a top bar, and the window
 * scrolling rather than the page's card. Tablets follow whichever layout
 * they get, and so does a plugin's device (#405).
 */
export const PHONE_LAYOUT = '(max-width: 899px)';

/** Whether the app shows its phone layout now, following the window as it resizes. */
export const usePhoneLayout = () =>
  useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(PHONE_LAYOUT);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia(PHONE_LAYOUT).matches,
  );
