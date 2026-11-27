import {
  fingerprint,
  followOperations,
  type ClientContext,
  type FollowedEntry,
  type IdentityId,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSpaceNames } from '../agents/pick-form';
import { refreshAccess } from '../data/queries';
import { PLAIN } from '../vault/store';
import { describePerson } from './people';
import { SettingRow } from '../settings/rows';
import { ErrorLine, useAction } from './use-action';

// The follow someone asked to see again, from where that person appears.
let asked: IdentityId | null = null;
const listeners = new Set<() => void>();
const setAsked = (id: IdentityId | null) => {
  asked = id;
  for (const listener of listeners) listener();
};

const followKey = (entry: FollowedEntry) => `${entry.from.identity.id} ${entry.to.keyHash}`;

/** Show again the details of a follow of `id`: both keys, and **Not them?** */
export const showFollow = (id: IdentityId) => setAsked(id);

/** The follows the person's record holds, seen or not, read again every few seconds. */
export const followsQuery = (ctx: ClientContext) => ({
  queryKey: [PLAIN, 'follows'],
  queryFn: () => followOperations.followsOf(ctx),
  // What lookups follow lands in the session's record as it goes.
  refetchInterval: 3_000,
});

/**
 * The one-time notice that a contact replaced their keys (protocol section
 * 8.4): the app followed a chain of statements, signed with the key it had,
 * to their new key, unchecked. It shows the key they had and the new one,
 * once on every device, until the person says OK, or **Not them?**, which
 * declines the new key. Shown again from where the person appears
 * (`showFollow`).
 */
export function FollowNotice({ ctx }: { ctx: ClientContext }) {
  const { data: follows } = useQuery(followsQuery(ctx));
  const again = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => asked,
  );
  const queryClient = useQueryClient();
  // The follow on screen stays there, through a decline that takes it out
  // of the record, until the person closes it.
  const [open, setOpen] = useState<FollowedEntry | null>(null);
  // Notices closed in this session, until the record says they were seen.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const next =
    follows?.find((entry) => entry.from.identity.id === again) ??
    follows?.find((entry) => !entry.seen && !closed.has(followKey(entry))) ??
    null;
  useEffect(() => {
    if (!open && next) setOpen(next);
  }, [open, next]);
  const done = (seen: FollowedEntry | null) => {
    if (open) setClosed((before) => new Set(before).add(followKey(open)));
    setOpen(null);
    setAsked(null);
    // Closing the notice is seeing it.
    if (seen && !seen.seen) {
      void followOperations
        .seeFollow(ctx, seen)
        .then(() => queryClient.invalidateQueries({ queryKey: [PLAIN, 'follows'] }))
        .catch(() => {});
    }
  };
  return open ? <FollowDialog key={followKey(open)} ctx={ctx} follow={open} onDone={done} /> : null;
}

function FollowDialog({
  ctx,
  follow,
  onDone,
}: {
  ctx: ClientContext;
  follow: FollowedEntry;
  /** With the follow when the person saw it, or null after a decline. */
  onDone: (seen: FollowedEntry | null) => void;
}) {
  const queryClient = useQueryClient();
  const { busy, error, run } = useAction();
  const [step, setStep] = useState<'notice' | 'decline'>('notice');
  const [warnings, setWarnings] = useState<followOperations.DeclinedOwnerSpace[] | null>(null);
  const id = follow.from.identity.id;
  const person = describePerson(ctx, id, null);
  const name = person.name;
  const current = ctx.trust.pinOf(id)?.identity ?? null;
  const settle = async () => {
    await queryClient.invalidateQueries({ queryKey: [PLAIN, 'follows'] });
    await refreshAccess(queryClient, ctx);
  };
  const close = () => {
    if (busy) return;
    onDone(warnings === null ? follow : null);
  };
  const decline = () =>
    run(async () => {
      const spaces = await followOperations.declineFollow(ctx, follow);
      setWarnings(spaces);
      await settle();
    });

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent dialogClassName="sm:max-w-lg" locked={busy}>
        {warnings !== null ? (
          <DeclinedWarnings name={name} spaces={warnings} ctx={ctx} onDone={() => onDone(null)} />
        ) : step === 'notice' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="size-5" strokeWidth={1.75} />
                <span>
                  <Name>{name}</Name> replaced their keys
                </span>
              </DialogTitle>
              <DialogDescription>
                Their new key is signed with the key you had for them, so this app moved to it.
                Nobody has compared it yet: if you can, check the new fingerprint with{' '}
                <Name>{name}</Name> by phone or in person.
              </DialogDescription>
            </DialogHeader>
            <dl className="grid gap-2 rounded-control bg-muted p-3 text-sm">
              <div>
                <dt className="font-bold">Key you had</dt>
                <dd className="font-mono break-all" data-testid="earlier-fingerprint">
                  {fingerprint(follow.from.identity)}
                </dd>
              </div>
              {current && (
                <div>
                  <dt className="font-bold">New key</dt>
                  <dd className="font-mono break-all" data-testid="new-fingerprint">
                    {fingerprint(current)}
                  </dd>
                </div>
              )}
            </dl>
            <ErrorLine error={error} />
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => setStep('decline')}>
                Not them?
              </Button>
              <Button disabled={busy} onClick={close}>
                OK
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldAlert className="size-5 text-destructive" strokeWidth={1.75} />
                <span>
                  Decline <Name>{name}</Name>’s new key?
                </span>
              </DialogTitle>
              <DialogDescription>
                If <Name>{name}</Name> didn’t replace their keys, someone else holds their old key
                and made the new one. Declining goes back to the key you had, and from then on this
                app shares nothing new with either key until you confirm one with{' '}
                <Name>{name}</Name>. What they could already open, they still can, until an owner
                gives those folders new keys. No device of yours follows this change again.
              </DialogDescription>
            </DialogHeader>
            <ErrorLine error={error} />
            <DialogFooter>
              <Button variant="ghost" disabled={busy} onClick={() => setStep('notice')}>
                Back
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => void decline()}>
                Decline new key
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Where an owner accepted the declined key (protocol section 8.4, **An
// owner's key the person declined**): the decline closes nothing there, so
// the app says who accepted it and what the person can do.
function DeclinedWarnings({
  name,
  spaces,
  ctx,
  onDone,
}: {
  name: string;
  spaces: readonly followOperations.DeclinedOwnerSpace[];
  ctx: ClientContext;
  onDone: () => void;
}) {
  const spaceNames = useSpaceNames();
  const spaceName = (spaceId: string) =>
    spaceNames.find((space) => space.spaceId === spaceId)?.name ?? 'A space this app can’t name';
  const nameOf = (id: string) => describePerson(ctx, id, null).name;
  return (
    <>
      <DialogHeader>
        <DialogTitle>You declined {name}’s new key</DialogTitle>
        <DialogDescription>
          This app shares nothing new with either of their keys now.
          {spaces.length > 0 &&
            ' But in the spaces below an owner accepted the key you declined, so it may read what anyone saves there, until an owner removes that person. People and owners it brought in, whom other owners accepted, may stay.'}
        </DialogDescription>
      </DialogHeader>
      {spaces.length > 0 && (
        <ul className="grid gap-3 text-sm" aria-label="Spaces where an owner accepted the key">
          {spaces.map((space) => (
            <li key={space.spaceId} className="grid gap-1 rounded-control bg-muted p-3">
              <p className="font-bold">
                <Name>{spaceName(space.spaceId)}</Name>
              </p>
              <p>
                {!space.known ? (
                  'The server didn’t say which owner accepted it; try again later to see.'
                ) : space.addedBy.length > 0 ? (
                  <>
                    Accepted by{' '}
                    {space.addedBy.map((by, i) => (
                      <span key={by}>
                        {i > 0 && ', '}
                        <Name>{nameOf(by)}</Name>
                      </span>
                    ))}
                    .
                  </>
                ) : (
                  'This app took that key as the space’s owner when it first saw the space.'
                )}{' '}
                {space.stillOwner === false
                  ? `${name} was an owner there when this app accepted the key; the server no longer lists them as one.`
                  : space.owner === true
                    ? `As an owner, you can remove ${name} as an owner there, and then leave the space if another owner stays.`
                    : space.owner === false
                      ? `Ask one of its owners to remove ${name}.`
                      : `If you’re an owner there, you can remove ${name} as an owner; if not, ask one of its owners to.`}
              </p>
              {space.owner !== false && space.stillOwner !== false && (
                <Link
                  to="/s/$spaceId/members"
                  params={{ spaceId: space.spaceId }}
                  className="text-primary underline"
                  onClick={onDone}
                >
                  Open the space’s people
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      <DialogFooter>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}

/**
 * Settings → Security: the people this app followed to a new key that
 * nobody has confirmed or declined yet, each with their details again (both
 * keys, and **Not them?**). The contact's details, wherever they share.
 */
export function ReplacedKeysRow({ ctx }: { ctx: ClientContext }) {
  const { data: follows } = useQuery(followsQuery(ctx));
  if (!follows || follows.length === 0) return null;
  return (
    <SettingRow
      name="People who replaced their keys"
      state="This app followed them to their new keys. Check a new fingerprint with them, or say it wasn’t them."
    >
      <ul className="grid gap-2" aria-label="People who replaced their keys">
        {follows.map((entry) => {
          const id = entry.from.identity.id;
          return (
            <li key={id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Name>{describePerson(ctx, id, null).name}</Name>
              <Button size="xs" variant="outline" onClick={() => showFollow(id)}>
                Details
              </Button>
            </li>
          );
        })}
      </ul>
    </SettingRow>
  );
}
