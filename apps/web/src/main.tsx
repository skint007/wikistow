import { createBrowserHistory } from '@tanstack/react-router';
import { App, createAppRouter } from '@wikistow/ui';
import '@wikistow/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const router = createAppRouter({ history: createBrowserHistory() });
createRoot(root).render(
  <StrictMode>
    <App router={router} />
  </StrictMode>,
);

// The service worker serves the app when the server can't (ADR 0009,
// decision 6). Only a build has one, and the desktop app, at `app://`,
// loads from disk already. It keeps the build once the page has loaded, so
// the two don't compete for the connection. The page may have loaded before
// this runs, as the app's modules wait for some of theirs.
if (import.meta.env.PROD && location.protocol !== 'app:' && 'serviceWorker' in navigator) {
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // No worker (a browser that refuses one, or private mode): the app works online as before.
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
