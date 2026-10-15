import { useRouterState } from '@tanstack/react-router';
import { Menu, Search } from 'lucide-react';
import type { ClientContext, SpaceId } from '@wikistow/client';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SafeModeBanner } from '../plugins/safe-mode-banner';
import { runCommand } from '../commands/command';
import { openSearch, requirementsHere } from '../commands/ui-commands';
import { Rail, useSignOut } from './rail';
import { useVault, vaultStore } from '../vault/store';
import { SearchDialog } from './search-dialog';
import { isApple, isSearchKey } from './search-model';
import { Sidebar } from './sidebar';

type Slot = { setSpace: (spaceId: SpaceId | null) => void; closeDrawer: () => void };
const SlotContext = createContext<Slot | null>(null);

/**
 * Rail + cards. On narrow screens the rail and the current space's sidebar
 * move into a drawer behind a top bar. Space pages tell the shell which
 * space is open with `useShellSpace`. A refused sign-out is reported here,
 * not in the rail, so it still shows after the drawer closed. Search opens
 * from the rail, the top bar or `isSearchKey` while the vault is open.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [spaceId, setSpace] = useState<SpaceId | null>(null);
  const [drawer, setDrawer] = useState(false);
  const slot = useMemo(() => ({ setSpace, closeDrawer: () => setDrawer(false) }), []);
  const closeDrawer = slot.closeDrawer;
  const vault = useVault();
  const { signOut, failed: signOutFailed } = useSignOut();
  // The session search was opened in: unlocking again starts a new one, closed.
  const [searchIn, setSearchIn] = useState<ClientContext | null>(null);
  const search = useCallback(() => {
    const now = vaultStore.get();
    if (now.status !== 'unlocked') return;
    void runCommand(
      openSearch,
      {},
      { satisfies: requirementsHere(), openSearch: () => setSearchIn(now.ctx) },
    );
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Left to whatever handled it first, such as an editor's own keys.
      if (event.defaultPrevented || !isSearchKey(event, isApple())) return;
      if (vaultStore.get().status !== 'unlocked') return;
      // Never the browser's own shortcut. Over another dialog nothing opens; in
      // search itself, it stays where it is.
      event.preventDefault();
      if (document.querySelector('dialog[open]')) return;
      search();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [search]);
  // Anything that moves to another page closes the drawer: links, menus, and
  // the redirect after locking.
  const href = useRouterState({ select: (state) => state.location.href });
  useEffect(() => closeDrawer(), [href, closeDrawer]);
  return (
    <SlotContext value={slot}>
      <div
        data-region="app"
        className="min-h-svh bg-background min-[900px]:grid min-[900px]:h-svh min-[900px]:grid-cols-[70px_1fr]"
      >
        <div className="hidden min-[900px]:block">
          <Rail onSignOut={signOut} onSearch={search} />
        </div>
        <header
          data-region="topbar"
          className="sticky top-0 z-10 flex h-[52px] items-center gap-3 bg-background px-3 min-[900px]:hidden"
        >
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setDrawer(true)}
            className="grid size-9 place-items-center rounded-control hover:tint active:tint-strong"
          >
            <Menu className="size-5" strokeWidth={1.75} />
          </button>
          <span className="font-extrabold">
            Wiki<span className="text-primary">Stow</span>
          </span>
          {vault.status === 'unlocked' && (
            <button
              type="button"
              aria-label="Search"
              onClick={search}
              className="ml-auto grid size-9 place-items-center rounded-control hover:tint active:tint-strong"
            >
              <Search className="size-5" strokeWidth={1.75} />
            </button>
          )}
        </header>
        <div
          data-region="main"
          className="min-h-0 p-2 min-[900px]:py-3.5 min-[900px]:pr-3.5 min-[900px]:pl-0"
        >
          {children}
        </div>
      </div>
      <Dialog open={drawer} onOpenChange={setDrawer}>
        <DialogContent
          side="left"
          dialogClassName="w-[92vw] max-w-none"
          className="flex gap-2 p-2"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Navigation</DialogTitle>
          <div className="w-[70px] shrink-0">
            <Rail onNavigate={closeDrawer} onSignOut={signOut} onSearch={search} />
          </div>
          <div className="min-w-0 flex-1">
            {/* Locking re-renders this before the space page lets go of its space. */}
            {spaceId && vault.status === 'unlocked' && (
              <Sidebar spaceId={spaceId} onNavigate={closeDrawer} />
            )}
          </div>
        </DialogContent>
      </Dialog>
      {vault.status === 'unlocked' && (
        <SearchDialog
          ctx={vault.ctx}
          open={searchIn === vault.ctx}
          onOpenChange={(open) => setSearchIn(open ? vault.ctx : null)}
        />
      )}
      <SafeModeBanner />
      {signOutFailed && (
        <p
          role="alert"
          className="fixed bottom-4 left-4 z-50 rounded-card bg-card px-4 py-2 text-sm text-destructive shadow-card min-[900px]:left-20"
        >
          Couldn’t sign out. Try again.
        </p>
      )}
    </SlotContext>
  );
}

/** Put this space's sidebar in the phone drawer while the caller is mounted. */
export function useShellSpace(spaceId: SpaceId) {
  const slot = use(SlotContext);
  useEffect(() => {
    slot?.setSpace(spaceId);
    return () => slot?.setSpace(null);
  }, [slot, spaceId]);
}
