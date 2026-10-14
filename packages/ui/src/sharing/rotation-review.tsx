import type { RotationPlan } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { sharesQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { ACCESS_LABELS, accessOf } from './model';
import { describePerson, peopleQuery, type Person } from './people';
import { NewMark } from './new-mark';

const LEFT_OUT: Record<RotationPlan['leftOut'][number]['reason'], string> = {
  'left-out': 'Loses access',
  'key-changed': 'Left out: their key changed and you haven’t confirmed it',
  'no-envelope': 'Left out: they need to be added again',
  'unknown-key': 'Left out: this app can’t check their key, so add them again',
};

/** One share's rotation, with the name the owner knows the share by. */
export type LabelledPlan = { label: string; plan: RotationPlan };

/**
 * Who keeps each share after a key rotation, and who doesn't, by name
 * (protocol section 7.5), for the owner to confirm. The people kept come
 * from keys this app verified, never from the server's list alone.
 */
export function RotationReview({
  plans,
  ownerIds,
  busy = false,
  onReviewKey,
}: {
  plans: readonly LabelledPlan[];
  ownerIds: ReadonlySet<string>;
  /** Whether the plans are being worked out or sent, so no key can be reviewed. */
  busy?: boolean;
  /** Show the key-change warning for someone left out over an unconfirmed key. */
  onReviewKey?: (person: Person) => void;
}) {
  const ctx = useClient();
  const ids = plans.flatMap(({ plan }) => [
    ...plan.remaining.map((r) => r.identity.id),
    ...plan.leftOut.map((l) => l.identityId),
  ]);
  const { data: people } = useQuery(peopleQuery(ctx, ids));
  const person = (id: string) => people?.get(id) ?? describePerson(ctx, id, null);
  return (
    <div className="grid max-h-[50vh] gap-4 overflow-y-auto">
      {plans.map(({ label, plan }) => (
        <ShareReview
          key={plan.shareId}
          label={label}
          plan={plan}
          titled={plans.length > 1}
          ownerIds={ownerIds}
          person={person}
          busy={busy}
          {...(onReviewKey ? { onReviewKey } : {})}
        />
      ))}
      <p className="text-sm text-muted-foreground">
        {plans.length > 1 ? (
          'Each folder above gets new keys.'
        ) : (
          <>
            “<Name>{plans[0]?.label ?? ''}</Name>” gets new keys.
          </>
        )}{' '}
        Anyone who loses access keeps what they could already read, but nothing saved from now on.
        Agents reach a folder only through their person, so the agents of anyone who loses access
        lose it too; the others get the new keys from their own people’s apps.
      </p>
    </div>
  );
}

/** One share's part of the review: who keeps it, with what access, and who is left out. */
function ShareReview({
  label,
  plan,
  titled,
  ownerIds,
  person,
  busy,
  onReviewKey,
}: LabelledPlan & {
  titled: boolean;
  ownerIds: ReadonlySet<string>;
  person: (id: string) => Person;
  busy: boolean;
  onReviewKey?: (person: Person) => void;
}) {
  const ctx = useClient();
  // Publish rights don't change in a rotation; the share's list says who has them.
  const { data: shares } = useQuery(sharesQuery(ctx, plan.spaceId));
  const canPublish = (id: string) =>
    !!shares?.find((s) => s.shareId === plan.shareId)?.members.find((m) => m.identityId === id)
      ?.canPublish;
  return (
    <section key={plan.shareId} aria-label={plainText(label)} className="grid gap-2">
      {titled && (
        <h3 className="font-extrabold">
          <Name>{label}</Name>
        </h3>
      )}
      <p className="text-sm font-bold text-subtle-foreground">
        Keeps access ({plan.remaining.length})
      </p>
      <ul className="grid gap-1 text-sm">
        {plan.remaining.map(({ identity, role }) => {
          const kept = person(identity.id);
          return (
            <li key={identity.id} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">
                  <Name>{kept.name}</Name>
                  {kept.email && (
                    <span className="text-muted-foreground">
                      {' '}
                      · <Name>{kept.email}</Name>
                    </span>
                  )}
                </span>
                {kept.status === 'new' && (
                  <span className="shrink-0">
                    <NewMark />
                  </span>
                )}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {ownerIds.has(identity.id)
                  ? 'Owner'
                  : role === 'reader'
                    ? plan.demoted.includes(identity.id)
                      ? 'Becomes a reader'
                      : 'Reader'
                    : ACCESS_LABELS[accessOf({ role, canPublish: canPublish(identity.id) })]}
              </span>
            </li>
          );
        })}
      </ul>
      {plan.leftOut.length > 0 && (
        <ul className="grid gap-1 text-sm">
          {plan.leftOut.map(({ identityId, reason }) => {
            const left = person(identityId);
            return (
              <li key={identityId} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-bold">
                    <Name>{left.name}</Name>
                  </span>
                  {left.status === 'new' && (
                    <span className="shrink-0">
                      <NewMark />
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2 text-destructive">
                  {LEFT_OUT[reason]}
                  {reason === 'key-changed' && onReviewKey && left.entry && (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onReviewKey(left)}
                    >
                      Review key
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
