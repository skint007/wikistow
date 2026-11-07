import { spaceOperations } from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import type { DesktopUpdate } from '@wikistow/contracts';
import {
  Bot,
  ExternalLink,
  Lock,
  LogOut,
  Megaphone,
  Plus,
  Search,
  Settings,
  Shield,
  Trash2,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useId, useState, type DragEvent } from 'react';
import { Avatar } from '@/components/avatar';
import { submitData } from '@/components/form/submit';
import { plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { ContextMenuItem } from '@/components/ui/context-menu';
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
import { desktop, desktopServerQuery, desktopUpdateQuery, linkHint } from '../desktop';
import { changesNotSent, forgetKept, signOutWarning } from '../data/kept-store';
import { connection } from '../data/connection';
import { useNeedsConnection } from './availability';
import { OfflinePill } from './offline-pill';
import { spaceOrderQuery, spacesQuery } from '../data/queries';
import { errorMessage } from '../errors';
import { Place, Replaceable } from '../plugins/places';
import { isApple } from './search-model';
import { SpaceIcon } from './space-look';
import { RowMenu } from './tree-menus';
import { useVault, vaultStore, type VaultState } from '../vault/store';
import { takeHeldSearch } from './search-link';

// The running build's version, set by the web app's Vite config.
declare const __APP_VERSION__: string;

type RailProps = {
  onNavigate?: () => void;
  onSignOut: () => Promise<void>;
  onSearch: () => void;
};

/**
 * Space tiles, then navigation, then the account. Labels stay visible.
 * `onSignOut` and `onSearch` come from the shell (see `useSignOut`), which
 * outlives the phone drawer this may be in. A plugin can draw the rail
 * instead (`rail`), at every size: then safe mode is the way back to
 * Settings (its keys, `?safe-mode` in a browser, or Open without plugins
 * as the vault is unlocked), whose banner links there.
 */
export function Rail(props: RailProps) {
  return (
    <Replaceable name="rail" inputs={NO_INPUTS}>
      <OwnRail {...props} />
    </Replaceable>
  );
}

const NO_INPUTS = {};

function OwnRail({ onNavigate, onSignOut, onSearch }: RailProps) {
  const vault = useVault();
  const needs = useNeedsConnection();
  return (
    <nav
      aria-label="Spaces and navigation"
      data-region="rail"
      // Scrolls itself when the window is too short for every item.
      className="flex h-full flex-col items-center gap-2 overflow-y-auto py-3.5"
    >
      <OfflinePill />
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
          <Link
            to="/trash"
            // Its list and everything in it are the server's (ADR 0009, decision 8).
            {...needs.click(() => onNavigate?.())}
            className="flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none aria-disabled:opacity-50"
            activeProps={{ className: 'text-primary-ink bg-primary-soft' }}
          >
            <Trash2 className="size-4" strokeWidth={1.75} />
            Trash
          </Link>
        </>
      ) : (
        <SharedLink here={false} onNavigate={onNavigate} />
      )}
      <Link
        to="/agents"
        {...needs.click(() => onNavigate?.())}
        className="flex w-14 flex-col items-center gap-1 rounded-control py-1.5 text-[10px] font-bold text-subtle-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none aria-disabled:opacity-50"
        activeProps={{ className: 'text-primary-ink bg-primary-soft' }}
      >
        <Bot className="size-4" strokeWidth={1.75} />
        Agents
      </Link>
      <Place name="rail" onNavigate={onNavigate} />
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

// What a space tile carries while dragged, so other drags aren't taken for one.
const SPACE_DRAG_TYPE = 'application/x-wikistow-space';

/** `ids` with the one at `from` moved to sit before what was at `to` (or last, at its length). */
function moved<T>(ids: T[], from: number, to: number) {
  const next = [...ids];
  next.splice(to > from ? to - 1 : to, 0, ...next.splice(from, 1));
  return next;
}

/**
 * The person's spaces in their order, home space first. A mouse drags any
 * other tile to a new place; the tile menu's Move up and Move down do the
 * same from the keyboard. The rail shows the new order at once, and puts the
 * old one back if saving it fails.
 */
function SpaceTiles({
  vault,
  onNavigate,
}: {
  vault: Extract<VaultState, { status: 'unlocked' }>;
  onNavigate: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const query = spacesQuery(vault.ctx);
  const { data: spaces = [] } = useQuery(query);
  const { data: order } = useQuery(spaceOrderQuery(vault.ctx));
  const params = useParams({ strict: false });
  const [creating, setCreating] = useState(false);
  const needs = useNeedsConnection();
  // The tile being dragged, and the place it would land: before the tile at that index.
  const [dragging, setDragging] = useState<{ from: number; to: number | null } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => setFailed(false), 6000);
    return () => clearTimeout(timer);
  }, [failed]);
  // Nothing goes above the home space.
  const first = order && spaces[0]?.id === order.homeId ? 1 : 0;

  async function move(from: number, to: number) {
    const before = queryClient.getQueryData(query.queryKey);
    if (!before) return;
    const after = moved(before, from, to);
    setFailed(false);
    queryClient.setQueryData(query.queryKey, after);
    try {
      await spaceOperations.saveSpaceOrder(
        vault.ctx,
        after.map((space) => space.id),
      );
    } catch {
      queryClient.setQueryData(query.queryKey, before);
      setFailed(true);
      void queryClient.invalidateQueries({ queryKey: query.queryKey });
    }
  }

  // Only a drag from these tiles, and only to a place that changes something.
  const dropAt = (event: DragEvent, to: number) => {
    if (!dragging || !event.dataTransfer.types.includes(SPACE_DRAG_TYPE)) return;
    const place = to === dragging.from || to === dragging.from + 1 ? null : to;
    if (place !== dragging.to) setDragging({ ...dragging, to: place });
    if (place === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  // Over a tile, the place is above it or below it, whichever half the pointer is in.
  const placeOver = (event: DragEvent<HTMLElement>, index: number) => {
    const { top, height } = event.currentTarget.getBoundingClientRect();
    return Math.max(first, event.clientY < top + height / 2 ? index : index + 1);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    if (dragging?.to != null) void move(dragging.from, dragging.to);
    setDragging(null);
  };

  return (
    <>
      <ul
        className="flex flex-col items-center gap-2"
        // Between tiles, the place last pointed at holds.
        onDragOver={(event) => dragging?.to != null && dropAt(event, dragging.to)}
        onDrop={drop}
        onDragLeave={(event) => {
          const to = event.relatedTarget;
          if (dragging && (!(to instanceof Node) || !event.currentTarget.contains(to))) {
            setDragging({ ...dragging, to: null });
          }
        }}
        onDragEnd={() => setDragging(null)}
      >
        {spaces.map((space, index) => {
          const name =
            space.metadata?.opened.kind === 'current' ? space.metadata.opened.metadata.name : '?';
          const active = params.spaceId === space.id;
          const movable = index >= first;
          const items = [
            movable && index > first && (
              <ContextMenuItem key="up" {...needs.select(() => void move(index, index - 1))}>
                Move up
              </ContextMenuItem>
            ),
            movable && index < spaces.length - 1 && (
              <ContextMenuItem key="down" {...needs.select(() => void move(index, index + 2))}>
                Move down
              </ContextMenuItem>
            ),
          ].filter(Boolean);
          const tile = (
            <Link
              to="/s/$spaceId"
              params={{ spaceId: space.id }}
              onClick={onNavigate}
              aria-label={plainText(name)}
              aria-current={active ? 'page' : undefined}
              data-hint={plainText(name)}
              data-hint-side="right"
              // The order is the server's to keep (ADR 0009, decision 8).
              draggable={movable && needs.can('drag')}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(SPACE_DRAG_TYPE, '');
                setDragging({ from: index, to: null });
              }}
              className={cn(
                'grid size-11 place-items-center overflow-hidden rounded-tile bg-muted text-sm font-extrabold text-foreground hover:tint active:tint-strong aria-[current=page]:hover:bg-none aria-[current=page]:active:bg-none',
                active && 'bg-primary-soft ring-2 ring-primary',
                dragging?.from === index && 'opacity-50',
              )}
            >
              <SpaceIcon metadata={space.metadata} name={name} />
            </Link>
          );
          return (
            <li
              key={space.id}
              className="relative"
              onDragOver={(event) => {
                event.stopPropagation();
                dropAt(event, placeOver(event, index));
              }}
            >
              {active && (
                <span aria-hidden className="absolute top-2 -left-3 h-7 w-1 rounded-r bg-primary" />
              )}
              {dragging?.to === index && <DropLine className="-top-[5px]" />}
              {dragging?.to === spaces.length && index === spaces.length - 1 && (
                <DropLine className="-bottom-[5px]" />
              )}
              {items.length > 0 ? <RowMenu items={items}>{tile}</RowMenu> : tile}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        {...needs.click(() => setCreating(true))}
        aria-label="New space"
        className="grid size-11 place-items-center rounded-tile border-2 border-dashed border-border text-muted-foreground hover:tint active:tint-strong aria-disabled:opacity-50"
      >
        <Plus className="size-4" strokeWidth={1.75} />
      </button>
      <span aria-hidden className="my-1 h-px w-7 bg-border" />
      <NewSpaceDialog open={creating} onOpenChange={setCreating} vault={vault} />
      {failed && (
        <p
          role="alert"
          className="fixed bottom-4 left-4 z-50 rounded-card bg-card px-4 py-2 text-sm text-destructive shadow-card min-[900px]:left-20"
        >
          Couldn’t save the order of your spaces. Try again.
        </p>
      )}
    </>
  );
}

/** Where a dragged space tile would land, in the gap above or below a tile. */
function DropLine({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn('absolute right-0 left-0 h-0.5 rounded-full bg-primary', className)}
    />
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
            <Input id="space-name" name="name" required autoFocus maxLength={200} />
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
 * Whether a failed sign-out's answer wasn't WikiStow's: a 404, or a body
 * that isn't its JSON, such as a proxy's error page. Its own refusals name
 * a code or a message.
 */
const notWikiStow = (error: { status: number }) =>
  error.status === 404 || !['code', 'message', 'error'].some((key) => key in error);

/** Whether to go on signing out, asked first if changes made offline would go with it. */
async function keepsChanges(): Promise<boolean> {
  const waiting = await changesNotSent();
  return !waiting || window.confirm(signOutWarning(waiting.count));
}

/**
 * Sign out, and why the last try failed: the server refused it (`refused`),
 * or no WikiStow answered (`gone`, #257): no answer at all, or one that
 * wasn't WikiStow's (`notWikiStow`). Either way the session is still alive
 * there. In the desktop app `signOutHere` then signs out on this computer
 * only. Held by the shell: signing out locks the vault first, which leaves
 * for the unlock page and closes the phone drawer, unmounting the menu it
 * was started from.
 */
export function useSignOut() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [failed, setFailed] = useState<'refused' | 'gone' | null>(null);
  // Leaving before the cache is cleared keeps the session check from sending
  // sign-in back to itself.
  const leave = useCallback(async () => {
    // A search a link asked for was this person's, not the next one's.
    takeHeldSearch();
    await navigate({ to: '/sign-in' });
    queryClient.clear();
  }, [navigate, queryClient]);
  // A failed sign-out leaves the session alive, so say so rather than
  // showing the sign-in page over it.
  const signOut = useCallback(async () => {
    setFailed(null);
    // Offline, the desktop app offers to sign out on this computer instead
    // (ADR 0009, decision 10); a browser's Sign out waits (`AccountMenu`).
    // The server is asked first, as it may be back since the last check.
    await connection.check();
    if (!connection.get().online) {
      if (desktop) setFailed('gone');
      return;
    }
    // Changes made offline and not sent yet go with the session: it asks first.
    if (!(await keepsChanges())) return;
    // Unsaved edits are saved first, or the person chose to drop them.
    if (!(await vaultStore.requestLock())) return;
    const outcome = await authClient.signOut().then(
      ({ error }) => (error ? (notWikiStow(error) ? 'gone' : 'refused') : null),
      () => 'gone' as const,
    );
    setFailed(outcome);
    if (outcome) return;
    await desktop?.signedOut();
    // Everything kept for offline goes with the session (ADR 0009, decision 10).
    await forgetKept();
    await leave();
  }, [leave]);
  const signOutHere = useCallback(async () => {
    if (!(await keepsChanges())) return;
    // Nothing is saved first: the server that would take it is gone.
    vaultStore.lock();
    await desktop?.signOutHere();
    await forgetKept();
    setFailed(null);
    // Sign-in asks for a server again, not the one forgotten.
    queryClient.setQueryData(desktopServerQuery.queryKey, null);
    await leave();
  }, [leave, queryClient]);
  return { signOut, signOutHere: desktop ? signOutHere : null, failed };
}

function AccountMenu({ onSignOut }: { onSignOut: () => Promise<void> }) {
  const { data: me } = useQuery(meQuery);
  const { data: update } = useQuery(desktopUpdateQuery);
  const navigate = useNavigate();
  const vault = useVault();
  const needs = useNeedsConnection();
  if (!me) return null;

  return (
    <DropdownMenu>
      {/* Relative, so a mark can sit on the avatar's corner without being clipped. */}
      <DropdownMenuTrigger
        aria-label={update ? 'Account, update available' : 'Account'}
        className="relative rounded-full"
      >
        <Avatar name={me.account.name} avatar={me.account.avatar} className="size-9 text-xs" />
        {update && <UpdateDot />}
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
        <DropdownMenuItem
          // The desktop app signs out on this computer offline (`useSignOut`).
          {...(desktop
            ? { onSelect: () => void onSignOut() }
            : needs.select(() => void onSignOut()))}
        >
          <LogOut strokeWidth={1.75} /> Sign out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {update && <UpdateEntry update={update} />}
        <DropdownMenuItem onSelect={() => void navigate({ to: '/whats-new' })}>
          <Megaphone strokeWidth={1.75} /> What’s new
        </DropdownMenuItem>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Version {__APP_VERSION__}
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How each kind of install is updated (`DesktopUpdate.source`), and the link to the release. */
const UPDATE_ROUTES = {
  aur: {
    how: (
      <>
        Update it with your AUR helper, such as <span className="whitespace-nowrap">yay -Syu</span>.
      </>
    ),
    link: 'Release notes',
  },
  deb: { how: 'Download the new .deb and install it.', link: 'Release notes and download' },
  rpm: { how: 'Download the new .rpm and install it.', link: 'Release notes and download' },
  windows: { how: 'Download the new installer and run it.', link: 'Download the installer' },
  mac: {
    how: (
      <>
        Download the new app, or with Homebrew run{' '}
        <span className="whitespace-nowrap">brew upgrade wikistow</span>.
      </>
    ),
    link: 'Release notes and download',
  },
  unknown: { how: 'Get it from the release page.', link: 'Open the release' },
} as const;

/**
 * The mark for a newer desktop release on a button's corner: the avatar,
 * and the top bar's menu button while the rail is in the drawer. The button
 * is `relative`, and its label says it too.
 */
export function UpdateDot() {
  return (
    <span
      aria-hidden
      className="absolute top-0 right-0 size-2.5 rounded-full bg-update-dot ring-2 ring-background"
    />
  );
}

/**
 * The desktop app's newer release, and how to get it. The link opens in the
 * system browser; it is described by the text above it, which a screen reader
 * in the menu wouldn't otherwise read.
 */
function UpdateEntry({ update }: { update: DesktopUpdate }) {
  const route = UPDATE_ROUTES[update.source ?? 'unknown'];
  const about = useId();
  return (
    <>
      <DropdownMenuLabel id={about} className="max-w-64 text-xs font-normal text-muted-foreground">
        <span className="flex items-center gap-1.5 text-sm font-bold text-foreground">
          <span aria-hidden className="size-2 rounded-full bg-update-dot" />
          Update available
        </span>
        <span className="block">
          WikiStow {update.version} is out. You have {update.installed}.
        </span>
        <span className="block">{route.how}</span>
      </DropdownMenuLabel>
      <DropdownMenuItem asChild>
        <a
          href={update.url}
          target="_blank"
          rel="noreferrer"
          aria-describedby={about}
          {...linkHint(update.url)}
        >
          <ExternalLink strokeWidth={1.75} /> {route.link}
        </a>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}
