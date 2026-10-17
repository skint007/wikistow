import type { spaceOperations, SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Avatar } from '@/components/avatar';
import { Name } from '@/components/name';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ChevronDown,
  Download,
  Palette,
  Share,
  ShieldAlert,
  Users,
  UsersRound,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { sharesQuery, spaceKeysQuery } from '../data/queries';
import { askAgain, useOwnerStanding } from '../sharing/owner-standing';
import { peopleQuery } from '../sharing/people';
import { useClient } from '../vault/store';
import { SpaceIcon, SpaceLookDialog } from './space-look';

/**
 * The sidebar's head: the space tile and name, and for owners, how many
 * people have access. Its menu exports the space, and for owners changes its
 * name and look, shares it, shows its members, or its groups.
 * A new owner who hasn't confirmed who added them gets a way back to that
 * question instead (section 6.5). Someone who holds only folders of a
 * space sees no space name (section 7.7), just that the folders were
 * shared with them.
 */
export function SpaceHeader({
  spaceId,
  name,
  metadata,
  onShare,
  onExport,
}: {
  spaceId: SpaceId;
  /** Null for someone who holds only folder shares in the space. */
  name: string | null;
  /** The space's own metadata, for its emoji and image; null when it failed its checks. */
  metadata: spaceOperations.LoadedMetadata | null | undefined;
  /** Unset when the space can't be shared whole, as when its own name failed its checks. */
  onShare: (() => void) | undefined;
  onExport: () => void;
}) {
  const ctx = useClient();
  const navigate = useNavigate();
  const standing = useOwnerStanding(spaceId);
  const owner = standing === 'owner';
  const [restyling, setRestyling] = useState(false);
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="grid size-[38px] shrink-0 place-items-center overflow-hidden rounded-tile bg-linear-to-br from-primary-2 to-primary text-sm font-extrabold text-primary-foreground">
        {name === null ? (
          <Users className="size-4" strokeWidth={1.75} />
        ) : (
          <SpaceIcon metadata={metadata} name={name} />
        )}
      </span>
      <div className="grid min-w-0 flex-1">
        <h2 className="truncate text-base font-extrabold">
          {name === null ? 'Shared with you' : <Name>{name}</Name>}
        </h2>
        {owner && <MemberCount spaceId={spaceId} />}
        {standing === 'unconfirmed' && (
          <button
            type="button"
            onClick={() => askAgain(ctx, spaceId)}
            className="flex items-center gap-1 text-left text-xs font-bold text-primary-ink underline decoration-current/40 underline-offset-2 hover:decoration-current"
          >
            <ShieldAlert className="size-3.5 shrink-0" strokeWidth={1.75} />
            Confirm who added you
          </button>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Space menu"
          className="grid size-8 shrink-0 place-items-center rounded-control text-muted-foreground hover:tint active:tint-strong"
        >
          <ChevronDown className="size-4" strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {owner && (
            <>
              <DropdownMenuItem onSelect={() => setRestyling(true)}>
                <Palette strokeWidth={1.75} /> Name and look…
              </DropdownMenuItem>
              {onShare && (
                <DropdownMenuItem onSelect={onShare}>
                  <Share strokeWidth={1.75} /> Share space…
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onSelect={() => void navigate({ to: '/s/$spaceId/members', params: { spaceId } })}
              >
                <Users strokeWidth={1.75} /> Members and owners
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => void navigate({ to: '/s/$spaceId/groups', params: { spaceId } })}
              >
                <UsersRound strokeWidth={1.75} /> Groups
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={onExport}>
            <Download strokeWidth={1.75} /> Export…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SpaceLookDialog spaceId={spaceId} open={restyling} onOpenChange={setRestyling} />
    </div>
  );
}

/** Everyone with access to the space, owners included, as a count and a stack of avatars. */
function MemberCount({ spaceId }: { spaceId: SpaceId }) {
  const ctx = useClient();
  const { data: shares } = useQuery(sharesQuery(ctx, spaceId));
  const { data: keys } = useQuery(spaceKeysQuery(ctx, spaceId));
  const ids = [
    ...new Set([
      ...(keys?.listed.map((o) => o.identity.id) ?? []),
      ...(shares?.flatMap((s) => s.members.map((m) => m.identityId)) ?? []),
    ]),
  ];
  const { data: people } = useQuery({ ...peopleQuery(ctx, ids), enabled: ids.length > 0 });
  if (!keys || !shares) return null;
  return (
    <Link
      to="/s/$spaceId/members"
      params={{ spaceId }}
      className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden className="flex -space-x-1.5">
        {ids.slice(0, 3).map((id) => {
          const person = people?.get(id);
          return (
            <Avatar
              key={id}
              name={person?.name ?? '?'}
              avatar={person?.avatar ?? null}
              letters={1}
              className="size-5 text-[9px] ring-2 ring-card"
            />
          );
        })}
      </span>
      <span className="underline decoration-current/40 underline-offset-2">
        {ids.length === 1 ? '1 person' : `${ids.length} people`}
      </span>
    </Link>
  );
}
