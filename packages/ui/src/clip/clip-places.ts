// Where a clip can go, and the folder search the extension asks for (ADR
// 0017, decision 6): every place this person can make pages, by its path,
// searched by what they type, at most 50, with the five clips went to last.
// Pure, so it is table-tested.
import type { ClipFolder } from '@wikistow/contracts';
import type { FolderId, SpaceId } from '@wikistow/client';
import { copyDestinations } from '../page/move-model';
import { nameOf, type Tree } from '../sharing/names';

/** A folder, or the top of a space (`folderId` null), with its names from the space's. */
export type ClipPlace = { spaceId: SpaceId; folderId: FolderId | null; path: string[] };

/** A place as the extension sees it, its path one line. */
export const clipFolder = (place: ClipPlace): ClipFolder => ({
  spaceId: place.spaceId,
  folderId: place.folderId,
  path: place.path.join(' / '),
});

export const samePlace = (
  a: { spaceId: string; folderId: string | null },
  b: { spaceId: string; folderId: string | null },
) => a.spaceId === b.spaceId && a.folderId === b.folderId;

/**
 * Every place in `trees` the person can make pages: by the share that
 * covers it, or their role in the space (`copyDestinations`), each led by
 * its space's name. One held only through folders shared with them starts
 * at those folders, as the space's name isn't theirs to see.
 */
export function clipPlaces(trees: readonly { spaceId: SpaceId; tree: Tree }[]): ClipPlace[] {
  return trees.flatMap(({ spaceId, tree }) => {
    const space = tree.space ? (nameOf(tree.space.metadata) ?? 'Space') : null;
    const places = copyDestinations({
      space: tree.space && { role: tree.space.role, opened: tree.space.metadata !== null },
      shares: tree.shares,
      folders: tree.folders.map((f) => ({
        id: f.id,
        parentId: f.parentId,
        name: nameOf(f.metadata),
      })),
    });
    return places.map(({ parentId, path }) => ({
      spaceId,
      folderId: parentId,
      path: space === null ? path : [space, ...path],
    }));
  });
}

/** Text as search compares it: no case, accents or extra spaces. */
const folded = (text: string) =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** Most matches a search answers. */
export const MAX_MATCHES = 50;
/** Places clips went last, kept and answered. */
export const RECENT_PLACES = 5;

/**
 * The places matching `query`: each of its words somewhere in the path,
 * those whose own name starts with it first, then whose own name has
 * them, then the rest, each in path order; at most 50. An empty query
 * matches nothing, so no name crosses but what the person typed for.
 * `recent` are the places clips went last that are still places, in order.
 */
export function searchPlaces(
  places: readonly ClipPlace[],
  query: string,
  recent: readonly { spaceId: string; folderId: string | null }[],
): { recent: ClipPlace[]; matches: ClipPlace[] } {
  const words = folded(query).split(' ').filter(Boolean);
  const rank = (place: ClipPlace) => {
    const own = folded(place.path.at(-1) ?? '');
    if (own.startsWith(folded(query))) return 0;
    return words.every((word) => own.includes(word)) ? 1 : 2;
  };
  const matches =
    words.length === 0
      ? []
      : places
          .filter((place) => {
            const path = folded(place.path.join(' / '));
            return words.every((word) => path.includes(word));
          })
          .map((place, order) => ({ place, order, rank: rank(place) }))
          .sort((a, b) => a.rank - b.rank || a.order - b.order)
          .slice(0, MAX_MATCHES)
          .map(({ place }) => place);
  const found = recent
    .map((wanted) => places.find((place) => samePlace(place, wanted)))
    .filter((place): place is ClipPlace => place !== undefined)
    .slice(0, RECENT_PLACES);
  return { recent: found, matches };
}

/** `recent` with `place` first, each once, five at most. */
export function rememberedPlaces<P extends { spaceId: string; folderId: string | null }>(
  recent: readonly P[],
  place: P,
): P[] {
  return [place, ...recent.filter((other) => !samePlace(other, place))].slice(0, RECENT_PLACES);
}
