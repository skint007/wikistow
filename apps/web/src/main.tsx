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
