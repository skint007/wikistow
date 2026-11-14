import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { AuthCard } from '@/components/layout/auth-card';
import { ClipReceiver } from '../clip/clip-receiver';
import type { RouterContext } from '../router';

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
  notFoundComponent: () => (
    <AuthCard title="Page not found" description="That link doesn’t lead anywhere.">
      <Link to="/" className="text-sm font-bold text-primary">
        Go home
      </Link>
    </AuthCard>
  ),
});

// The web clipper's receiver, in the desktop app, on every page, so main
// always hears whether the vault is open, whatever the page shows.
function Root() {
  return (
    <>
      <ClipReceiver />
      <Outlet />
    </>
  );
}
