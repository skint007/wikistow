import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { AuthCard } from '@/components/layout/auth-card';
import type { RouterContext } from '../router';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: () => (
    <AuthCard title="Page not found" description="That link doesn’t lead anywhere.">
      <Link to="/" className="text-sm font-bold text-primary">
        Go home
      </Link>
    </AuthCard>
  ),
});
