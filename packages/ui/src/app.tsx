import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { HintLayer } from '@/components/ui/tooltip';
import type { AppRouter } from './router';
import { Titlebar } from './shell/titlebar';
import { ThemeProvider } from './theme/theme';

export function App({ router }: { router: AppRouter }) {
  return (
    <QueryClientProvider client={router.options.context.queryClient}>
      <ThemeProvider>
        <RouterProvider router={router} />
        {/* Outside the router, so it stays on every screen, an error's too. After it, so
            Tab reaches the page's controls first. */}
        <Titlebar />
        <HintLayer />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
