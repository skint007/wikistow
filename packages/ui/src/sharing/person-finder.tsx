import { sharingOperations, type Lookup } from '@wikistow/client';
import type { GroupId } from '@wikistow/contracts';
import { Users } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Picker } from '@/components/ui/picker';
import { useClient } from '../vault/store';
import { needsKeyReview, type KeyOutcome } from './key-change';
import { sharingMessage } from './messages';
import { ACCESS_LABELS, isAccess, type Access } from './model';
import { describePerson, type Person } from './people';

/** A person found by exact email, whose key may be sealed to. */
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

/**
 * Find someone by the exact email of their account (protocol section 7.3).
 * The typed email travels with them, so a key that differs from the pin or
 * from that email's label is a key change, which `review` must clear first.
 * With `withAccess`, the owner also picks their access. With `groups`, the
 * space's groups whose names hold what is typed are offered beside it, and
 * `onGroup` hears which one is chosen, with the access.
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
  const [access, setAccess] = useState<Access>('reader');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  // One lookup at a time, even for a second click before `busy` renders.
  const looking = useRef(false);

  // A plain submit handler, not a form action: React resets a form after
  // its action, which would clear the email after every failed lookup.
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = email.trim();
    if (!typed || looking.current) return;
    looking.current = true;
    setBusy(true);
    setError(null);
    try {
      const lookup = await sharingOperations.findPerson(ctx, typed);
      if (!lookup) {
        setError('No one with a vault uses that email. They need to set up their vault first.');
        return;
      }
      const seen = () => describePerson(ctx, lookup.identity.id, lookup, typed);
      let person = seen();
      if (person.self) {
        setError('That’s you.');
        return;
      }
      if (person.nameless) {
        setError(
          person.pinnedKey
            ? 'Your contacts have no usable name for this person, so they can’t be chosen here.'
            : 'Their account has no name this app can show safely, so they can’t be chosen here.',
        );
        return;
      }
      const why = exclude?.(person);
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
    } catch (caught) {
      setError(sharingMessage(caught));
    } finally {
      looking.current = false;
      setBusy(false);
    }
  }

  const typed = email.trim().toLocaleLowerCase();
  const offered = onGroup
    ? groups.filter((group) => group.name.toLocaleLowerCase().includes(typed))
    : [];

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-2">
      <Label htmlFor={`${id}-email`}>
        {onGroup && groups.length > 0 ? 'Email or group' : 'Email'}
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={`${id}-email`}
          name="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="off"
          placeholder="name@example.com"
          className="min-w-48 flex-1"
        />
        {withAccess && <AccessSelect id={`${id}-access`} value={access} onChange={setAccess} />}
        <Button type="submit" disabled={busy}>
          {busy ? 'Looking…' : submitLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Type their whole email address. Only an exact match finds someone.
      </p>
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
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
