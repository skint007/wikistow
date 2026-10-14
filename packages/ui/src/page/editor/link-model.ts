import {
  foldTitle,
  linkKey,
  resolveWikilinks,
  writableInLink,
  type LinkablePage,
  type PlacedWikilink,
} from '@wikistow/client';

// What the editors work out about wikilinks, against the pages the person
// can open and the link table the next save starts from.

export type LinkScope = {
  pages: readonly LinkablePage[];
  /** key → page ID */
  table: ReadonlyMap<string, string>;
  selfId: string;
};

/** Where a page sits, to tell it from others with its title. */
export const folderPath = (page: LinkablePage) =>
  page.folders.length === 0 ? 'Top level' : page.folders.join(' / ');

/** One page to offer after `[[`. */
export type TitleOption = {
  page: LinkablePage & { title: string };
  /** The target to write: the title, with the folders above it it takes to tell it from the others offered. */
  text: string;
  /** Where the page sits, when another page has its title. */
  detail: string | null;
  /**
   * The text names other pages the person sees as well, so accepting it
   * records the pick in the link table.
   */
  pick: boolean;
};

/**
 * The pages to offer after `[[`: every page but this one whose title can be
 * written into a link, of those a link here may name (`targets`, all when
 * null). A title shared by several of those is written with as many of
 * its folders as it takes to tell it from them, so it never names a folder
 * of a page the draft's readers can't open. A title shared with any page
 * the person sees comes with the page's folders.
 */
export function titleOptions({
  pages,
  selfId,
  targets,
}: Omit<LinkScope, 'table'> & { targets: ReadonlySet<string> | null }): TitleOption[] {
  const nameable = targets === null ? pages : pages.filter((page) => targets.has(page.id));
  // This page counts too: a link with its title names it as well.
  const titled = (list: readonly LinkablePage[]) =>
    list.filter(
      (page): page is TitleOption['page'] => page.title !== null && writableInLink(page.title),
    );
  const counts = titleCounts(titled(pages));
  const nameableCounts = titleCounts(titled(nameable));
  return titled(nameable).flatMap((page) => {
    if (page.id === selfId) return [];
    const key = foldTitle(page.title);
    const text =
      (nameableCounts.get(key) ?? 0) < 2
        ? page.title
        : (shortestTarget(page, nameable, selfId) ?? page.title);
    const [found] = resolveWikilinks([wikilink(text)], { pages, selfId });
    const named = found?.status === 'resolved' && found.targets[0] === page.id;
    const shared = (counts.get(key) ?? 0) > 1;
    return [{ page, text, detail: shared ? folderPath(page) : null, pick: !named }];
  });
}

function titleCounts(pages: readonly (LinkablePage & { title: string })[]) {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const key = foldTitle(page.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// `Folder/Title` with the fewest folders that names only `page` among
// `pages`, or null. Pages in one share differ below its root, if anywhere,
// so a folder above the root is never needed.
function shortestTarget(
  page: TitleOption['page'],
  pages: readonly LinkablePage[],
  selfId: string,
): string | null {
  for (let n = 1; n <= page.folders.length; n++) {
    const folders = page.folders.slice(-n);
    if (!folders.every((name) => writableInLink(name) && !name.includes('/'))) return null;
    const target = [...folders, page.title].join('/');
    const [found] = resolveWikilinks([wikilink(target)], { pages, selfId });
    if (found?.status === 'resolved' && found.targets[0] === page.id) return target;
  }
  return null;
}

const wikilink = (target: string) => ({
  source: `[[${target}]]`,
  target,
  heading: null,
  shown: null,
  embed: false,
});

/**
 * The page a link's target names for this person: the table's entry when
 * its page is one they can open, else the one page with that title. Null
 * when no page or several do; an empty target is this page.
 */
export function linkedPage(target: string, { pages, table, selfId }: LinkScope): string | null {
  if (target === '') return selfId;
  const entry = table.get(linkKey({ target }));
  if (entry !== undefined && pages.some((page) => page.id === entry)) return entry;
  const [found] = resolveWikilinks([wikilink(target)], { pages, selfId });
  return found?.status === 'resolved' ? (found.targets[0] ?? null) : null;
}

/** The pages a link's target could mean: each with its title, and folders if it names any. */
export function candidatesFor(
  target: string,
  { pages, selfId }: Omit<LinkScope, 'table'>,
): LinkablePage[] {
  const [found] = resolveWikilinks([wikilink(target)], { pages, selfId });
  const ids = new Set(found?.targets ?? []);
  return pages.filter((page) => ids.has(page.id));
}

/** A link several of the person's pages have the title of. */
export type AmbiguousLink = {
  from: number;
  to: number;
  key: string;
  target: string;
  candidates: LinkablePage[];
  /** The page the table names for it, if it's one the person can open. */
  chosen: string | null;
};

/** Each of `links`, as `placedWikilinks` finds them, whose title several pages have. */
export function ambiguousAmong(
  placed: readonly PlacedWikilink[],
  { pages, table, selfId }: LinkScope,
): AmbiguousLink[] {
  const links = placed.filter((link) => !link.embed && link.target !== '');
  const byId = new Map(pages.map((page) => [page.id, page]));
  const found: AmbiguousLink[] = [];
  resolveWikilinks(links, { pages, selfId }).forEach((resolved, i) => {
    const link = links[i];
    if (resolved.status !== 'ambiguous' || !link) return;
    const entry = table.get(linkKey(link));
    found.push({
      from: link.start,
      to: link.end,
      key: linkKey(link),
      target: link.target,
      candidates: resolved.targets.flatMap((id) => byId.get(id) ?? []),
      chosen: entry !== undefined && byId.has(entry) ? entry : null,
    });
  });
  return found;
}

/** The headings a link can name, of a page's in order (`headingTexts`), each once. */
export const linkHeadings = (texts: readonly string[]): string[] => [
  ...new Set(texts.filter(writableInLink)),
];
