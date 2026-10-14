import type { SpaceId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Name, plainText } from '@/components/name';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronDown, Download, Share, ShieldAlert, Users } from 'lucide-react';
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
import { initials } from './rail';

/**
 * The sidebar's head: the space tile and name, and for owners, how many
 * people have access. Its menu exports the space, and for owners shares it
 * or shows its members.
 * A new owner who hasn't confirmed who added them gets a way back to that
 * question instead (section 6.5). Someone who holds only folders of a
 * space sees no space name (section 7.7), just that the folders were
 * shared with them.
 */
export function SpaceHeader({
  spaceId,
  name,
  emoji,
  onShare,
  onExport,
}: {
  spaceId: SpaceId;
  /** Null for someone who holds only folder shares in the space. */
  name: string | null;
  emoji: string | undefined;
  /** Unset when the space can't be shared whole, as when its own name failed its checks. */
  onShare: (() => void) | undefined;
  onExport: () => void;
}) {
  const ctx = useClient();
  const navigate = useNavigate();
  const standing = useOwnerStanding(spaceId);
  const owner = standing === 'owner';
  return (
    <div className="flex items-center gap-3 px-1">
      <span className="grid size-[38px] shrink-0 place-items-center rounded-tile bg-linear-to-br from-primary-2 to-primary text-sm font-extrabold text-primary-foreground">
        {name === null ? (
          <Users className="size-4" strokeWidth={1.75} />
        ) : (
          (emoji ?? initials(plainText(name)))
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
            className="flex items-center gap-1 text-left text-xs font-bold text-primary-ink hover:underline"
          >
            <ShieldAlert className="size-3.5 shrink-0" strokeWidth={1.75} />
            Confirm who added you
          </button>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Space menu"
          className="grid size-8 shrink-0 place-items-center rounded-control text-muted-foreground hover:bg-accent"
        >
          <ChevronDown className="size-4" strokeWidth={1.75} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {owner && (
            <>
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
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={onExport}>
            <Download strokeWidth={1.75} /> Export…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Everyone with access to the space, owners included, as a count and a stack of initials. */
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
        {ids.slice(0, 3).map((id) => (
          <span
            key={id}
            className="grid size-5 place-items-center rounded-full bg-strong text-[9px] font-extrabold text-strong-foreground ring-2 ring-card"
          >
            {initials(plainText(people?.get(id)?.name ?? '?')).slice(0, 1)}
          </span>
        ))}
      </span>
      {ids.length === 1 ? '1 person' : `${ids.length} people`}
    </Link>
  );
}
