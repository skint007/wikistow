import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Outlet, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { meQuery } from '../api';
import { ReauthProvider } from '../auth/reauth';
import { desktop } from '../desktop';
import { AppShell } from '../shell/app-shell';
import { withoutSearchHash } from '../shell/search-link';
import { idleTooLong, useIdleLock } from '../vault/idle-lock';
import { restoreInTab } from '../vault/open';
import { forgetKeptUnlock, vaultStore } from '../vault/store';

/** Everything behind sign-in. A session that ends (sign-out, suspension) returns here to sign-in. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) {
      // The session ended while nobody was here (revoked from another
      // device, say): the kept unlock goes with it.
      await forgetKeptUnlock();
      // A search the address asks for waits in memory, not in the redirect.
      throw redirect({ to: '/sign-in', search: { redirect: withoutSearchHash(location.href) } });
    }
    // After a refresh, a browser tab opens the vault it kept, whichever page
    // it is on, unless it was left idle past the lock delay. The desktop app
    // opens a remembered one on the unlock page.
    if (!desktop && me.identity && vaultStore.get().status === 'locked') {
      if (idleTooLong()) await forgetKeptUnlock();
      else await restoreInTab(me.account.id);
    }
  },
  component: AppLayout,
});

function AppLayout() {
  // Always re-checked when the tab comes back into view, and every minute, so a
  // session ended elsewhere (sign-out, suspension) is noticed promptly.
  const { data: me } = useQuery({ ...meQuery, staleTime: 0, refetchInterval: 60_000 });
  const navigate = useNavigate();
  const router = useRouter();

  // Only losing the session triggers this: the page that was open is read
  // once, not tracked, so the redirect never nests itself.
  useEffect(() => {
    if (me !== null) return;
    vaultStore.lock();
    void navigate({
      to: '/sign-in',
      search: { redirect: withoutSearchHash(router.state.location.href) },
    });
  }, [me, navigate, router]);
  // Locks after the delay chosen in Settings with nobody using the app.
  useIdleLock();
  if (!me) return null;

  return (
    <ReauthProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </ReauthProvider>
  );
}
