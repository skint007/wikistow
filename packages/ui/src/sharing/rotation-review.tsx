import type { RotationOffer, RotationPlan } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { Name, plainText } from '@/components/name';
import { Button } from '@/components/ui/button';
import { sharesQuery } from '../data/queries';
import { useClient } from '../vault/store';
import { ACCESS_LABELS, accessOf } from './model';
import { describePerson, peopleQuery, type Person } from './people';
import { NewMark } from './new-mark';
import { raisable, tickedRole } from './ticks';

const LEFT_OUT: Record<RotationPlan['leftOut'][number]['reason'], string> = {
  'left-out': 'Loses access',
  'key-changed': 'Left out: their key changed and you haven’t confirmed it',
  'no-envelope': 'Waits: no owner you accept gave them these keys. Give them access later.',
  'unknown-key': 'Left out: this app can’t check their key, so add them again',
  'old-key': 'Waits: only earlier keys of an owner gave them access',
  'replaced-keys': 'Waits: they replaced their keys',
};

// What ticking an offer does, by why it is offered.
const TICK: Record<RotationOffer['reason'], string> = {
  'old-key': 'Keep their access',
  'replaced-keys': 'Give them access at their new key',
};

/** One share's rotation, with the name the owner knows the share by. */
export type LabelledPlan = { label: string; plan: RotationPlan };

/**
 * The offers the owner ticked (`RotationPlan.offers`), by share and then
 * by person, with the role to give.
 */
export type Ticks = ReadonlyMap<string, ReadonlyMap<string, 'reader' | 'editor'>>;

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
  ticks,
  onTick,
  plain = false,
}: {
  plans: readonly LabelledPlan[];
  ownerIds: ReadonlySet<string>;
  /** Whether the plans are being worked out or sent, so no key can be reviewed. */
  busy?: boolean;
  /** Show the key-change warning for someone left out over an unconfirmed key. */
  onReviewKey?: (person: Person) => void;
  /** The offers ticked, with `onTick`: without it, offers are only listed as waiting. */
  ticks?: Ticks;
  onTick?: (shareId: string, offer: RotationOffer, role: 'reader' | 'editor' | null) => void;
  /** Only who keeps access, without saying what new keys do, for a change asked in plain words. */
  plain?: boolean;
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
          // Plain, with no footnote to name it, even one folder is named.
          titled={plain || plans.length > 1}
          ownerIds={ownerIds}
          person={person}
          busy={busy}
          {...(onReviewKey ? { onReviewKey } : {})}
          {...(onTick ? { onTick, ticked: ticks?.get(plan.shareId) ?? new Map() } : {})}
        />
      ))}
      {!plain && (
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
      )}
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
  ticked,
  onTick,
}: LabelledPlan & {
  titled: boolean;
  ownerIds: ReadonlySet<string>;
  person: (id: string) => Person;
  busy: boolean;
  onReviewKey?: (person: Person) => void;
  ticked?: ReadonlyMap<string, 'reader' | 'editor'>;
  onTick?: (shareId: string, offer: RotationOffer, role: 'reader' | 'editor' | null) => void;
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
            const offer = plan.offers.find((o) => o.identityId === identityId);
            if (offer && onTick) {
              const raises = raisable(plan, offer);
              const tickedAs = tickedRole(plan, offer, ticked?.get(identityId));
              // Ticked as the offer's role where an owner this app accepts
              // vouched for them, and as a reader where only an earlier key did.
              const ticksAs = offer.vouched && raises ? 'editor' : 'reader';
              return (
                <li key={identityId} className="grid gap-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="truncate font-bold">
                      <Name>{left.name}</Name>
                      {left.email && (
                        <span className="font-normal text-muted-foreground">
                          {' '}
                          · <Name>{left.email}</Name>
                        </span>
                      )}
                    </span>
                    <span className={tickedAs ? 'text-muted-foreground' : 'text-destructive'}>
                      {tickedAs
                        ? tickedAs === 'editor'
                          ? 'Keeps access, as an editor'
                          : 'Keeps access, as a reader'
                        : LEFT_OUT[reason]}
                    </span>
                  </span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={tickedAs !== null}
                      disabled={busy}
                      aria-label={`${TICK[offer.reason]}: ${plainText(left.name)}`}
                      onChange={(event) =>
                        onTick(plan.shareId, offer, event.target.checked ? ticksAs : null)
                      }
                    />
                    {TICK[offer.reason]}
                  </label>
                  {tickedAs && raises && (
                    <label className="flex items-center gap-2 pl-6">
                      <input
                        type="checkbox"
                        checked={tickedAs === 'editor'}
                        disabled={busy}
                        aria-label={`As an editor: ${plainText(left.name)}`}
                        onChange={(event) =>
                          onTick(plan.shareId, offer, event.target.checked ? 'editor' : 'reader')
                        }
                      />
                      As an editor
                    </label>
                  )}
                </li>
              );
            }
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
