import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router';
import { meQuery } from '../../api';

export const Route = createFileRoute('/_app/admin')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me?.account.role !== 'admin') throw redirect({ to: '/' });
  },
  component: Admin,
});

function Admin() {
  const tab =
    'rounded-row px-3 py-1.5 text-sm font-bold text-subtle-foreground outline-offset-[-2px] hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none';
  const active = { className: 'bg-primary-soft text-primary-ink' };
  return (
    <div className="mx-auto grid h-full max-w-4xl content-start gap-3.5 overflow-y-auto">
      <nav aria-label="Administration" className="flex gap-1">
        <Link to="/admin" className={tab} activeProps={active} activeOptions={{ exact: true }}>
          Accounts
        </Link>
        <Link to="/admin/invitations" className={tab} activeProps={active}>
          Invitations
        </Link>
        <Link to="/admin/settings" className={tab} activeProps={active}>
          Settings
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
