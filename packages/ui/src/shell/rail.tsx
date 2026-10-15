import { spaceOperations } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Bot, Lock, LogOut, Plus, Search, Settings, Shield, Users } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Avatar, initials } from '@/components/avatar';
import { submitData } from '@/components/form/submit';
import { plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { meQuery } from '../api';
import { runCommand } from '../commands/command';
import { lockVault, requirementsHere } from '../commands/ui-commands';
import { authClient } from '../auth/client';
import { desktop } from '../desktop';
import { spacesQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { usePlugins } from '../plugins/runtime';
import { isApple } from './search-model';
import { useVault, vaultStore, type VaultState } from '../vault/store';

// The running build's version, set by the web app's Vite config.
declare const __APP_VERSION__: string;

/**
 * Space tiles, then navigation, then the account. Labels stay visible.
 * `onSignOut` and `onSearch` come from the shell (see `useSignOut`), which
 * outlives the phone drawer this may be in.
 */
export function Rail({
  onNavigate,
  onSignOut,
  onSearch,
}: {
  onNavigate?: () => void;
  onSignOut: () => Promise<void>;
  onSearch: () => void;
}) {
  const vault = useVault();
  return (
    <nav
      aria-label="Spaces and navigation"
      data-region="rail"
      className="flex h-full flex-col items-center gap-2 py-3.5"
    >
      {vault.status === 'unlocked' ? (
        <>
          <SpaceTiles vault={vault} onNavigate={onNavigate} />
          <button
            type="button"
            onClick={() => {
              onNavigate?.();
              onSearch();
            }}
            aria-keyshortcuts={isApple() ? 'Meta+K' : 'Control+K'}
            className="flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none"
          >
            <Search className="size-4" strokeWidth={1.75} />
            Search
          </button>
          <SharedLinkHere vault={vault} onNavigate={onNavigate} />
        </>
      ) : (
        <SharedLink here={false} onNavigate={onNavigate} />
      )}
      <Link
        to="/agents"
        onClick={onNavigate}
        className="flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none"
        activeProps={{ className: 'text-primary-ink bg-primary-soft' }}
      >
        <Bot className="size-4" strokeWidth={1.75} />
        Agents
      </Link>
      <PluginItems onNavigate={onNavigate} />
      <div className="flex-1" />
      <Link
        to="/settings"
        onClick={onNavigate}
        className="flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none"
        activeProps={{ className: 'text-primary-ink bg-primary-soft' }}
      >
        <Settings className="size-4" strokeWidth={1.75} />
        Settings
      </Link>
      <AccountMenu onSignOut={onSignOut} />
    </nav>
  );
}

/** Plugins' rail items, each opening its plugin's page. Only while the vault is open. */
function PluginItems({ onNavigate }: { onNavigate: (() => void) | undefined }) {
  const { regions } = usePlugins();
  return regions.rail.map(({ pluginId, id, title, icon, opens }) => (
    <Link
      key={`${pluginId}:${id}`}
      to="/plugin/$pluginId/$viewId"
      params={{ pluginId, viewId: opens }}
      onClick={onNavigate}
      title={title}
      data-plugin={pluginId}
      className="flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none"
      activeProps={{ className: 'text-primary-ink bg-primary-soft' }}
    >
      <span
        aria-hidden
        className="grid h-4 place-items-center overflow-hidden text-sm leading-none"
      >
        {icon ?? title.slice(0, 1)}
      </span>
      <span className="w-full truncate text-center">{title}</span>
    </Link>
  ));
}

/**
 * Shared with me. It also stands for a space open now that has no tile:
 * one someone shared only folders of, opened from Shared with me.
 */
function SharedLink({ here, onNavigate }: { here: boolean; onNavigate: (() => void) | undefined }) {
  return (
    <Link
      to="/shared"
      onClick={onNavigate}
      aria-current={here ? 'page' : undefined}
      className={cn(
        'flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none',
        here && 'bg-primary-soft text-primary-ink',
      )}
      activeProps={{ className: 'text-primary-ink bg-primary-soft' }}
    >
      <Users className="size-4" strokeWidth={1.75} />
      Shared
    </Link>
  );
}

function SharedLinkHere({
  vault,
  onNavigate,
}: {
  vault: Extract<VaultState, { status: 'unlocked' }>;
  onNavigate: (() => void) | undefined;
}) {
  const { data: spaces } = useQuery(spacesQuery(vault.ctx));
  const { spaceId } = useParams({ strict: false });
  const here = spaceId !== undefined && !!spaces && !spaces.some((space) => space.id === spaceId);
  return <SharedLink here={here} onNavigate={onNavigate} />;
}

function SpaceTiles({
  vault,
  onNavigate,
}: {
  vault: Extract<VaultState, { status: 'unlocked' }>;
  onNavigate: (() => void) | undefined;
}) {
  const { data: spaces = [] } = useQuery(spacesQuery(vault.ctx));
  const params = useParams({ strict: false });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <ul className="flex flex-col items-center gap-2">
        {spaces.map((space) => {
          const name =
            space.metadata?.opened.kind === 'current' ? space.metadata.opened.metadata.name : '?';
          const emoji =
            space.metadata?.opened.kind === 'current'
              ? space.metadata.opened.metadata.emoji
              : undefined;
          const active = params.spaceId === space.id;
          return (
            <li key={space.id} className="relative">
              {active && (
                <span aria-hidden className="absolute top-2 -left-3 h-7 w-1 rounded-r bg-primary" />
              )}
              <Link
                to="/s/$spaceId"
                params={{ spaceId: space.id }}
                onClick={onNavigate}
                aria-label={plainText(name)}
                aria-current={active ? 'page' : undefined}
                title={plainText(name)}
                className={cn(
                  'grid size-11 place-items-center rounded-tile bg-muted text-sm font-extrabold text-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none',
                  active && 'bg-primary-soft ring-2 ring-primary',
                )}
              >
                {emoji ?? initials(plainText(name))}
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => setCreating(true)}
        aria-label="New space"
        className="grid size-11 place-items-center rounded-tile border-2 border-dashed border-border text-muted-foreground hover:tint active:tint-strong"
      >
        <Plus className="size-4" strokeWidth={1.75} />
      </button>
      <span aria-hidden className="my-1 h-px w-7 bg-border" />
      <NewSpaceDialog open={creating} onOpenChange={setCreating} vault={vault} />
    </>
  );
}

function NewSpaceDialog({
  open,
  onOpenChange,
  vault,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vault: Extract<VaultState, { status: 'unlocked' }>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  async function submit(form: FormData) {
    const name = form.get('name');
    if (typeof name !== 'string' || !name.trim()) return;
    setError(null);
    try {
      const spaceId = await spaceOperations.createSpace(vault.ctx, { name: name.trim() });
      await queryClient.invalidateQueries({ queryKey: spacesQuery(vault.ctx).queryKey });
      onOpenChange(false);
      await navigate({ to: '/s/$spaceId', params: { spaceId } });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submitData(submit)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New space</DialogTitle>
            <DialogDescription>Its name is encrypted like everything in it.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="space-name">Name</Label>
            <Input id="space-name" name="name" required autoFocus maxLength={100} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit">Create space</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sign out, and whether the server refused the last try. Held by the shell:
 * signing out locks the vault first, which leaves for the unlock page and
 * closes the phone drawer, unmounting the menu it was started from.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // A sign-out the server refused leaves the session alive, so say so rather
  // than showing the sign-in page over it. Leaving before the cache is
  // cleared keeps the session check from sending sign-in back to itself.
  const signOut = useCallback(async () => {
    setFailed(false);
    // Unsaved edits are saved first, or the person chose to drop them.
    if (!(await vaultStore.requestLock())) return;
    const { error } = await authClient.signOut().catch((caught: unknown) => ({ error: caught }));
    if (error) {
      setFailed(true);
      return;
    }
    await desktop?.signedOut();
    await navigate({ to: '/sign-in' });
    queryClient.clear();
  }, [navigate, queryClient]);
  return { signOut, failed };
}

function AccountMenu({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const { data: me } = useQuery(meQuery);
  const navigate = useNavigate();
  const vault = useVault();
  if (!me) return null;

  return (
    <DropdownMenu>
      {/* Relative, so a mark can sit on the avatar's corner without being clipped. */}
      <DropdownMenuTrigger aria-label="Account" className="relative rounded-full">
        <Avatar name={me.account.name} avatar={me.account.avatar} className="size-9 text-xs" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end">
        <DropdownMenuLabel>
          <span className="block font-bold">{me.account.name}</span>
          <span className="block text-xs font-normal text-muted-foreground">
            {me.account.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {me.account.role === 'admin' && (
          <DropdownMenuItem onSelect={() => void navigate({ to: '/admin' })}>
            <Shield strokeWidth={1.75} /> Administration
          </DropdownMenuItem>
        )}
        {vault.status === 'unlocked' && (
          // Pages under the vault layout leave for the unlock screen themselves.
          <DropdownMenuItem
            onSelect={() => void runCommand(lockVault, {}, { satisfies: requirementsHere() })}
          >
            <Lock strokeWidth={1.75} /> Lock vault
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void onSignOut()}>
          <LogOut strokeWidth={1.75} /> Sign out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Version {__APP_VERSION__}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
