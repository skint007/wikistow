import { createFileRoute, Outlet, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { meQuery } from '../../api';
import { PendingOwnerWork } from '../../sharing/pending-owner-work';
import { useVault, vaultStore } from '../../vault/store';

/** Everything that needs the vault open: spaces and pages. */
export const Route = createFileRoute('/_app/_vault')({
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me?.identity) throw redirect({ to: '/vault/setup' });
    if (vaultStore.get().status === 'locked') {
      throw redirect({ to: '/vault/unlock', search: { redirect: location.href } });
    }
  },
  component: VaultLayout,
});

function VaultLayout() {
  const vault = useVault();
  const navigate = useNavigate();
  const router = useRouter();
  // Locking (here or from the account menu) leaves every decrypted page, and
  // unlocking comes back to it. Only the lock itself triggers this: the page
  // it left is read once, not tracked, so the redirect never nests itself.
  useEffect(() => {
    if (vault.status !== 'locked') return;
    void navigate({ to: '/vault/unlock', search: { redirect: router.state.location.href } });
  }, [vault.status, navigate, router]);
  // Ownership work left unfinished, in this session or an earlier one, is
  // listed once the vault opens (protocol section 7.6).
  return vault.status === 'unlocked' ? (
    <>
      <Outlet />
      <PendingOwnerWork />
    </>
  ) : null;
}
