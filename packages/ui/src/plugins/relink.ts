import {
  linkKey,
  pageIndex,
  pagesTitled,
  relinkMarkdown,
  RelinkUnwritable,
  writableInLink,
  type LinkablePage,
  type LinkPointing,
  type PageIndex as LinkIndex,
} from '@wikistow/client';
import { PluginError, RELINK_LIMIT, type LinkMove } from '@wikistow/plugin-sdk';

// What `host.pages.relink` (#404) works out, the same for the app's pages
// and the workshop's samples: which links on a page name the pages moved
// from, and the text naming each page moved to.

/** The pages of a space as links resolve there: each with its title and folders, and by title. */
export type Linkable = { pages: readonly LinkablePage[]; index: LinkIndex };

/** `pages` as `relink` reads links among them. */
export const linkableAs = (pages: readonly LinkablePage[]): Linkable => ({
  pages,
  index: pageIndex(pages),
});

/** Check what `relink` was asked, before reading anything: its size, space and headings. */
export function checkMoves(moves: readonly LinkMove[]): void {
  if (moves.length > RELINK_LIMIT)
    throw new PluginError('invalid', `At most ${RELINK_LIMIT} moves at a time`);
  const spaceId = moves[0]?.from.page.spaceId;
  if (moves.some(({ from, to }) => from.page.spaceId !== spaceId || to.page.spaceId !== spaceId))
    throw new PluginError('invalid', 'Links stay in one space');
  for (const { from, to } of moves) {
    for (const heading of [from.heading, to.heading])
      if (heading !== undefined && !writableInLink(heading))
        throw new PluginError('invalid', `“${heading}” can’t be written into a link`);
  }
}

/**
 * The text naming each page `moves` go to, as anyone in the space
 * resolves it: its title, else with as many of its folders as tell it
 * apart. `invalid` for one a link can't name.
 */
export function moveTargets(moves: readonly LinkMove[], { pages, index }: Linkable): string[] {
  return moves.map(({ to }) => {
    const page = pages.find(({ id }) => id === to.page.pageId);
    const title = page?.title ?? null;
    if (title === null || !writableInLink(title))
      throw new PluginError('invalid', 'That page’s title can’t be written into a link');
    const folders = page?.folders ?? [];
    for (let n = 0; n <= folders.length; n++) {
      const above = folders.slice(folders.length - n);
      if (!above.every(writableInLink)) break;
      const [only, ...more] = pagesTitled([...above, title].join('/'), pages, index);
      if (only === to.page.pageId && more.length === 0) return [...above, title].join('/');
    }
    throw new PluginError('invalid', `“${title}” names several pages; give it a title of its own`);
  });
}

/**
 * Page `pageId`'s Markdown with its links pointed as `moves` say, or null
 * if none of its links go there. A link names a page by the page's link
 * table (`table`) where that holds an entry for it, else by title among
 * `linkable`. `targets` are `moveTargets`'. `invalid` for a link it can't
 * write so.
 */
export function relinkPage(
  markdown: string,
  pageId: string,
  table: ReadonlyMap<string, string>,
  moves: readonly LinkMove[],
  targets: readonly string[],
  { pages, index }: Linkable,
): string | null {
  const names =
    (fromId: string): LinkPointing['names'] =>
    (link) => {
      if (link.target === '') return pageId === fromId;
      const entry = table.get(linkKey(link));
      if (entry !== undefined && index.titles.has(entry)) return entry === fromId;
      const [only, ...more] = pagesTitled(link.target, pages, index);
      return only === fromId && more.length === 0;
    };
  try {
    return relinkMarkdown(
      markdown,
      moves.map(({ from, to }, i) => ({
        names: names(from.page.pageId),
        heading: from.heading ?? null,
        to: {
          // On the page moved to, a link to one of its headings needs no title.
          target: to.page.pageId === pageId && to.heading !== undefined ? '' : (targets[i] ?? ''),
          heading: to.heading ?? null,
        },
      })),
    );
  } catch (error) {
    throw new PluginError(
      'invalid',
      error instanceof RelinkUnwritable ? error.message : 'Its links didn’t read back as pointed',
    );
  }
}
