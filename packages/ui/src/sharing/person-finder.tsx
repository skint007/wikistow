import {
  normalizeEmail,
  sharingOperations,
  type ClientContext,
  type Lookup,
} from '@wikistow/client';
import type { GroupId } from '@wikistow/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { ShieldAlert, Users } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Avatar } from '@/components/avatar';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Picker } from '@/components/ui/picker';
import { PLAIN, useClient } from '../vault/store';
import { needsKeyReview, type KeyOutcome } from './key-change';
import { sharingMessage } from './messages';
import { ACCESS_LABELS, isAccess, type Access } from './model';
import { NewMark } from './new-mark';
import { describePerson, type Person } from './people';

/** A person picked from the list or found by exact email, whose key may be sealed to. */
export type Found = { person: Person & { entry: Lookup }; access: Access };

/** The access choice, named `label`, by default "Access". */
export function AccessSelect({
  id,
  value,
  onChange,
  disabled,
  label = 'Access',
  allowed,
}: {
  id: string;
  value: Access;
  onChange: (access: Access) => void;
  disabled?: boolean;
  label?: string;
  /** Only these choices, as for an agent, which never gets more than its person. */
  allowed?: readonly Access[];
}) {
  const options = Object.entries(ACCESS_LABELS).flatMap(([access, text]) =>
    isAccess(access) && (!allowed || allowed.includes(access))
      ? [{ value: access, label: text }]
      : [],
  );
  return (
    <Picker
      id={id}
      label={label}
      value={value}
      options={options}
      disabled={disabled}
      onChange={onChange}
      className="w-auto font-bold"
    />
  );
}

/** A group of the space that can be chosen instead of a person. */
export type GroupChoice = { groupId: GroupId; name: string; people: number };

// Everyone on the server who could be shared with. A minute old is fresh
// enough: someone missing can still be found by their whole email.
const serverPeopleQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'server-people'],
    queryFn: () => sharingOperations.listPeople(ctx),
    staleTime: 60_000,
  });

const holds = (text: string | null, typed: string) =>
  text !== null && text.toLocaleLowerCase().includes(typed);

/**
 * Pick someone from the people on the server, or find them by the exact
 * email of their account (protocol section 7.3). The field filters the list
 * by name or email. Pinned people show by their label, with Key changed
 * where it applies; anyone else by the directory's name and email, marked
 * new. The email a person was listed or found by travels with them, so a
 * key that differs from the pin or from that email's label is a key change,
 * which `review` must clear first. People `exclude` turns away, and
 * accounts without a vault yet, are listed with the reason and can't be
 * picked. With `withAccess`, the owner also picks their access. With
 * `groups`, the space's groups whose names hold what is typed are offered
 * beside it, and `onGroup` hears which one is chosen, with the access.
 */
export function PersonFinder({
  withAccess = true,
  exclude,
  submitLabel,
  review,
  onFound,
  groups = [],
  onGroup,
}: {
  withAccess?: boolean;
  groups?: readonly GroupChoice[];
  onGroup?: (groupId: GroupId, access: Access) => void;
  /** Why this person can't be chosen here, such as already having access; null if they can. */
  exclude?: (person: Person) => ReactNode;
  submitLabel: string;
  review: (person: Person) => Promise<KeyOutcome>;
  onFound: (found: Found) => void;
}) {
  const ctx = useClient();
  const id = useId();
  const listing = useQuery(serverPeopleQuery(ctx));
  const [access, setAccess] = useState<Access>('reader');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  // One pick at a time, even for a second click before `busy` renders.
  const looking = useRef(false);

  // Why `person` can't be picked here, or null if they can.
  const refusal = (person: Person): ReactNode => {
    if (person.self) return 'That’s you.';
    if (person.nameless) {
      return person.pinnedKey
        ? 'Your contacts have no usable name for this person, so they can’t be chosen here.'
        : 'Their account has no name this app can show safely, so they can’t be chosen here.';
    }
    return exclude?.(person) ?? null;
  };

  const typed = query.trim().toLocaleLowerCase();
  const people = (listing.data?.people ?? [])
    .map((lookup) => describePerson(ctx, lookup.identity.id, lookup, lookup.foundBy))
    .filter((person) => holds(person.name, typed) || holds(person.email, typed))
    .sort((a, b) => a.name.localeCompare(b.name));
  const withoutVault = (listing.data?.withoutVault ?? []).filter(
    (account) => holds(account.name, typed) || holds(account.email, typed),
  );
  const offered = onGroup
    ? groups.filter((group) => group.name.toLocaleLowerCase().includes(typed))
    : [];

  // Seal-ready `lookup`, once its person may be picked and any key change is
  // confirmed. `foundBy` is the email they were listed or found by.
  async function choose(lookup: Lookup) {
    const seen = () => describePerson(ctx, lookup.identity.id, lookup, lookup.foundBy);
    let person = seen();
    const why = refusal(person);
    if (why) {
      setError(why);
      return;
    }
    if (needsKeyReview(person)) {
      if ((await review(person)) !== 'confirmed') {
        setError(
          <>
            Nothing was shared with <Name>{person.name}</Name>’s new key.
          </>,
        );
        return;
      }
      person = seen();
    }
    const { entry } = person;
    if (entry) onFound({ person: { ...person, entry }, access });
  }

  async function pick(find: () => Promise<Lookup | null>) {
    if (looking.current) return;
    looking.current = true;
    setBusy(true);
    setError(null);
    try {
      const lookup = await find();
      if (lookup) await choose(lookup);
    } catch (caught) {
      setError(sharingMessage(caught));
    } finally {
      looking.current = false;
      setBusy(false);
    }
  }

  // A plain submit handler, not a form action: React resets a form after
  // its action, which would clear the field after every failed lookup.
  // A whole email picks the listed person with it, or is looked up, for
  // someone the list missed. Other text picks the one person it matches.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = query.trim();
    if (!text) return;
    void pick(async () => {
      if (text.includes('@')) {
        const email = normalizeEmail(text);
        const listed = listing.data?.people.find((p) => normalizeEmail(p.email) === email);
        if (listed) return listed;
        const lookup = await sharingOperations.findPerson(ctx, text);
        if (!lookup) {
          setError('No one with a vault uses that email. They need to set up their vault first.');
        }
        return lookup;
      }
      const [only, ...more] = people;
      if (only?.entry && more.length === 0) return only.entry;
      setError(
        only
          ? 'Pick someone from the list.'
          : withoutVault.length > 0
            ? 'They haven’t set up their vault yet, so they can’t be chosen.'
            : listing.data
              ? 'No one here matches that. Check the name, or type their whole email.'
              : 'Type their whole email.',
      );
      return null;
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <Label htmlFor={`${id}-query`}>
        {onGroup && groups.length > 0 ? 'Name, email or group' : 'Name or email'}
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${id}-query`}
          name="query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
          placeholder="Name or name@example.com"
          className="min-w-48 flex-1"
        />
        {withAccess && <AccessSelect id={`${id}-access`} value={access} onChange={setAccess} />}
        <Button type="submit" disabled={busy}>
          {busy ? 'Looking…' : submitLabel}
        </Button>
      </div>
      {offered.length > 0 && (
        <ul aria-label="Groups" className="flex flex-wrap gap-2">
          {offered.map((group) => (
            <li key={group.groupId}>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onGroup?.(group.groupId, access)}
              >
                <Users strokeWidth={1.75} /> <Name>{group.name}</Name>
                <span className="text-muted-foreground">
                  {group.people === 1 ? '1 person' : `${group.people} people`}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {listing.isError ? (
        <p className="text-xs text-muted-foreground">
          The list of people couldn’t load. Type their whole email instead.
        </p>
      ) : (
        (people.length > 0 || withoutVault.length > 0) && (
          <ul aria-label="People" className="grid max-h-64 gap-0.5 overflow-y-auto">
            {people.map((person) => {
              const why = refusal(person);
              const entry = person.entry;
              return (
                <li key={person.id}>
                  <PersonChoice
                    name={person.name}
                    email={person.email}
                    disabled={busy || why !== null}
                    onPick={entry ? () => void pick(async () => entry) : undefined}
                    marks={
                      needsKeyReview(person) ? (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-destructive">
                          <ShieldAlert strokeWidth={1.75} className="size-3.5" /> Key changed
                        </span>
                      ) : person.status === 'new' ? (
                        <NewMark />
                      ) : null
                    }
                    reason={why}
                  />
                </li>
              );
            })}
            {withoutVault.map((account) => (
              <li key={account.email}>
                <PersonChoice
                  name={account.name}
                  email={account.email}
                  disabled
                  reason="Hasn’t set up their vault yet"
                />
              </li>
            ))}
          </ul>
        )
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

/** One row of `PersonFinder`'s list: a person to pick, or why they can't be. */
function PersonChoice({
  name,
  email,
  marks,
  reason,
  disabled,
  onPick,
}: {
  name: string;
  email: string | null;
  marks?: ReactNode;
  reason: ReactNode;
  disabled: boolean;
  onPick?: (() => void) | undefined;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded-row px-2 py-1 text-left enabled:cursor-pointer enabled:hover:tint enabled:active:tint-strong"
    >
      <Avatar name={name} avatar={null} letters={1} className="size-8 text-xs" />
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={
              reason ? 'truncate text-sm text-muted-foreground' : 'truncate text-sm font-bold'
            }
          >
            <Name>{name}</Name>
          </span>
          {marks && <span className="shrink-0">{marks}</span>}
        </span>
        {email && (
          <span className="truncate text-xs text-muted-foreground">
            <Name>{email}</Name>
          </span>
        )}
        {reason && <span className="text-xs text-muted-foreground">{reason}</span>}
      </span>
    </button>
  );
}
