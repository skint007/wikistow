import type { ClientContext } from '@wikistow/client';
import type { LivePerson } from '@wikistow/client/live';
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { peopleQuery } from '../../sharing/people';
import { CARET_COLOURS, colourOf } from '../editor/source/live-colours';

// Who else has each page's draft open, as its draft view last said, for the
// toolbar, which sits outside the draft view.
const shown = new Map<string, readonly LivePerson[]>();
const listeners = new Set<() => void>();

/** The draft view of `pageId` says who else is editing it, or that it closed (`null`). */
export function showLivePeople(pageId: string, people: readonly LivePerson[] | null) {
  const before = shown.get(pageId);
  if (people === null || people.length === 0) {
    if (before === undefined) return;
    shown.delete(pageId);
  } else {
    const same =
      before?.length === people.length && before.every((person, i) => person.id === people[i]?.id);
    if (same) return;
    shown.set(pageId, people);
  }
  for (const listener of listeners) listener();
}

const NONE: readonly LivePerson[] = [];

function useLivePeople(pageId: string): readonly LivePerson[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => shown.get(pageId) ?? NONE,
  );
}

/** "Sam", "Sam and Rita", "Sam, Rita and Ola". */
export function namesSentence(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Up to two letters for a name: its first two words' first letters. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = (word: string) => {
    const code = word.codePointAt(0);
    return code === undefined ? '' : String.fromCodePoint(code);
  };
  const letters = words.slice(0, 2).map(first);
  return letters.join('').toLocaleUpperCase() || '?';
}

/**
 * The others who have the draft open, in the page's toolbar (ADR 0015
 * decision 7): their initials in their colour, their names on hover
 * ("Sam and Rita are editing"), and on phones a count. Only joins a
 * message from has verified are listed, and their pinned labels name them.
 */
export function LivePeople({ ctx, pageId }: { ctx: ClientContext; pageId: string }) {
  const people = useLivePeople(pageId);
  const { data: named } = useQuery({
    ...peopleQuery(
      ctx,
      people.map((person) => person.id),
    ),
    enabled: people.length > 0,
  });
  if (people.length === 0) return null;
  const names = people.map((person) => named?.get(person.id)?.name ?? '…');
  const sentence = `${namesSentence(names)} ${names.length === 1 ? 'is' : 'are'} editing`;
  return (
    <div role="img" aria-label={sentence} title={sentence} className="flex items-center">
      <span className="flex -space-x-1.5 max-[899px]:hidden" aria-hidden="true">
        {people.slice(0, 4).map((person, i) => (
          <span
            key={person.id}
            className="grid size-6 place-items-center rounded-full text-[11px] leading-none font-bold text-white ring-2 ring-background"
            style={{ backgroundColor: CARET_COLOURS[colourOf(person.id)] }}
          >
            {initialsOf(names[i] ?? '?')}
          </span>
        ))}
        {people.length > 4 && (
          <span className="grid size-6 place-items-center rounded-full bg-muted text-[11px] font-bold ring-2 ring-background">
            +{people.length - 4}
          </span>
        )}
      </span>
      <span
        className="hidden rounded-full bg-muted px-2 py-0.5 text-xs font-bold max-[899px]:inline"
        aria-hidden="true"
      >
        {people.length}
      </span>
    </div>
  );
}
