import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AppRouter } from './router';
import { ThemeProvider } from './theme/theme';

export function App({ router }: { router: AppRouter }) {
  return (
    <QueryClientProvider client={router.options.context.queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
