import type { SpaceId } from '@wikistow/client';
import { plainText } from '../components/name';
import type { ListedCopy } from '../data/queries';

/** What the person holds in the spaces copies are in, to name those whose names they can't read. */
export type Holdings = {
  /** Spaces they are in as a whole, as owner or member. */
  spaces: ReadonlySet<string>;
  /** For each space where only folders are shared with them, those folders' names (null where unreadable). */
  folders: ReadonlyMap<string, readonly (string | null)[]>;
};

/**
 * One step of a place: the app's own words, and names someone chose, kept
 * apart so each name can be shown isolated from the words around it.
 */
export type Step = (string | { name: string })[];

/**
 * Where each copy is, by the names this app can read, outermost first: the
 * space, then for a copy the person can publish at, the folders down to it.
 * A space whose name they can't read is named by the folders shared with
 * them there: a copy there from that folder down, and one they can't
 * publish at as the space holding those folders, since it is somewhere
 * else in it. A space they are in but whose name doesn't open is
 * "Unreadable space", and one they have no part in "Another space". Places
 * that would read the same are numbered by their space, so each reads
 * differently.
 */
export function placesOf(copies: readonly ListedCopy[], held: Holdings): Map<SpaceId, Step[]> {
  const taken = new Set<string>();
  return new Map(
    copies.map((published) => {
      const place = placeOf(published, held);
      const [space = [], ...rest] = place;
      let numbered = place;
      for (let n = 2; taken.has(readsAs(numbered)); n++) {
        numbered = [[...space, ` (${n})`], ...rest];
      }
      taken.add(readsAs(numbered));
      return [published.spaceId, numbered];
    }),
  );
}

/** What a place reads as on screen (`plainText` for each name), and in labels. */
export const readsAs = (place: Step[]) =>
  place
    .map((step) =>
      step.map((part) => (typeof part === 'string' ? part : plainText(part.name))).join(''),
    )
    .join(' › ');

const named = (name: string | null): Step => (name === null ? ['Unreadable folder'] : [{ name }]);

function placeOf(published: ListedCopy, held: Holdings): Step[] {
  const folders = (published.copy.state === 'live' ? published.copy.path : []).map(named);
  if (published.spaceName !== null) return [[{ name: published.spaceName }], ...folders];
  const roots = held.folders.get(published.spaceId) ?? [];
  const [first, ...rest] = folders;
  if (roots.length > 0 && !held.spaces.has(published.spaceId)) {
    if (first !== undefined) return [[...first, ' (a folder shared with you)'], ...rest];
    return [
      [
        'The space holding ',
        ...roots.flatMap((root, i) => [...(i > 0 ? [', '] : []), ...named(root)]),
        roots.length === 1 ? ' (a folder shared with you)' : ' (folders shared with you)',
      ],
    ];
  }
  if (published.copy.state === 'live' || held.spaces.has(published.spaceId)) {
    return [['Unreadable space'], ...folders];
  }
  return [['Another space']];
}
