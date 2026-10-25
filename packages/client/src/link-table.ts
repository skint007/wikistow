// The link table (wikistow.md, Wikilinks; protocol section 5.5): an
// extension of each revision mapping a wikilink's target text to the page
// it names, so a link follows its page through a rename. It names only
// pages everyone who can open that version can open too; any other link
// has no entry, and each viewer resolves it by title in their own tree.
// Its links are the body's, a property's value that is one wikilink, and
// the page a reference to another page's value names (`tableWikilinks`).

import type { Audience, FolderId, PageId, RevisionId, ShareId, SpaceId } from '@wikistow/contracts';
import { z } from 'zod';
import { PageId as PageIdSchema } from './ids.ts';
import {
  foldTitle,
  linkablePages,
  resolveWikilinks,
  tableWikilinks,
  type LinkablePage,
  type PageIndex,
  type PlacedWikilink,
  type ResolvedLink,
} from './links.ts';
import { setProperty, splitFrontmatter, type Wikilink } from './markdown/index.ts';
import type { OpenedMetadata } from './metadata.ts';
import type { PagePayload } from './payload.ts';
import { regionInTree, sameRegion, type Region } from './regions.ts';

/** The extension namespace the table lives in. */
export const LINKS_NAMESPACE = 'wikistow.links';

/** Format 1: one entry per target text, folded as titles match (`linkKey`). */
export const LinkTable = z.looseObject({
  format: z.literal(1),
  links: z.array(z.looseObject({ key: z.string(), pageId: PageIdSchema })),
});
export type LinkTable = z.infer<typeof LinkTable>;

/** A link's entry key: its target as written, `Folder/` included, folded. */
export const linkKey = (link: { target: string }) => foldTitle(link.target);

/**
 * A payload's table as key → page ID. Empty when it has none, or one in a
 * shape this app doesn't know.
 */
export function linkTableOf(payload: PagePayload): ReadonlyMap<string, PageId> {
  const parsed = LinkTable.safeParse(payload.extensions[LINKS_NAMESPACE]);
  return new Map(parsed.success ? parsed.data.links.map((link) => [link.key, link.pageId]) : []);
}

/**
 * `payload` without its link table: what a save can measure before
 * `writeLinks` works the table out afresh, which may be much smaller.
 */
export function withoutLinkTable(payload: PagePayload): PagePayload {
  const { [LINKS_NAMESPACE]: _links, ...extensions } = payload.extensions;
  return { ...payload, extensions };
}

/**
 * `payload` with only the table entries its links use. An editor builds its
 * next save on this: the old keys a rename keeps (`writeLinks`) are for
 * others' copies of the text from before, and would take a link it types
 * next with the old text, for a page not made yet, as the renamed page's.
 * Its links are read with `read`, as `writeLinks` does; if that fails, it
 * is `payload` as it is.
 */
export async function linksInUse(
  payload: PagePayload,
  read: ReadWikilinks = readHere,
): Promise<PagePayload> {
  const parsed = LinkTable.safeParse(payload.extensions[LINKS_NAMESPACE]);
  if (!parsed.success) return payload;
  let used: Set<string>;
  try {
    used = new Set((await read(payload.markdown)).map(linkKey));
  } catch {
    return payload;
  }
  const links = parsed.data.links.filter((link) => used.has(link.key));
  if (links.length === parsed.data.links.length) return payload;
  const { [LINKS_NAMESPACE]: _links, ...others } = payload.extensions;
  // As `writeLinks` writes it; the next save works it out afresh anyway.
  const table = tableOf(links.map(({ key, pageId }) => [key, pageId] as const));
  return {
    ...payload,
    extensions: links.length === 0 ? others : { ...others, [LINKS_NAMESPACE]: table },
  };
}

/**
 * How each link resolves for a viewer: a page link through `table` when
 * its entry names one of `pages` whose title the viewer's app opened, so it
 * follows a rename, else as `resolveWikilinks` does, `index` too. An
 * entry naming any other page counts for nothing.
 */
export function resolveLinked(
  links: readonly Wikilink[],
  scope: {
    pages: readonly LinkablePage[];
    selfId: string;
    table: ReadonlyMap<string, string>;
    attachments?: readonly { id: string; name: string }[];
    index?: PageIndex;
  },
): ResolvedLink[] {
  const titled = (id: string) =>
    scope.index
      ? scope.index.titles.has(id)
      : scope.pages.some((page) => page.id === id && page.title !== null);
  return resolveWikilinks(links, scope).map((found) => {
    const entry = found.embed || found.target === '' ? undefined : scope.table.get(linkKey(found));
    const followed = entry !== undefined && titled(entry);
    return followed ? { ...found, status: 'resolved', targets: [entry] } : found;
  });
}

/**
 * What the table is worked out from: the writer's tree of the space, as
 * `loadTree` gives it. A page's `region` is that of the version its title
 * was opened from, by its key material, or null when none was. The tree is
 * the server's: it only places pages, and one it places in another region
 * than its key material counts for nothing.
 */
export type LinkTree = {
  shares: readonly { spaceId: SpaceId; shareId: ShareId; rootId: string | null }[];
  folders: readonly {
    id: FolderId;
    parentId: FolderId | null;
    metadata: { opened: OpenedMetadata } | null;
  }[];
  pages: readonly {
    id: PageId;
    parentId: FolderId | null;
    title: string | null;
    region: Region | null;
    publishedHead: RevisionId | null;
  }[];
};

/** A page's current publication as this app opened it: its title, and its key material's region. */
export type OpenedPublication = { title: string; region: Region };

/** The version being written, and where. */
export type LinkWrite = {
  /** The page written; its folder counts when the tree doesn't list it yet (a new page). */
  page: { id: PageId; parentId?: FolderId | null };
  audience: Audience;
  /** The write's region, from the records this app opened (`writeRegion`). */
  region: Region;
  /**
   * The region of the version the payload's table came from, as this app
   * opened it; none for a payload that didn't come with one. Only a table
   * from this write's region is carried (`writeLinks`).
   */
  tableRegion?: Region;
  /**
   * For a publication: the page's current publication as this app opened
   * it, its table and region. A publication into a share keeps the
   * entries its readers there already read (`writeLinks`).
   */
  publication?: { table: ReadonlyMap<string, PageId>; region: Region };
  /** Called only when the Markdown has page links to work out. */
  tree: () => LinkTree | Promise<LinkTree>;
  /**
   * Each page's current publication, opened; asked only for the pages a
   * publication into a share could name, or a rename in a draft would take
   * the title of, with the region the page's shown version opened in. A
   * page left out of the answer has none this app opened.
   */
  published: (
    pages: readonly { id: PageId; publishedHead: RevisionId; region: Region }[],
  ) => Promise<ReadonlyMap<PageId, OpenedPublication>>;
  /**
   * The page the writer picked for an ambiguous link, by key. A pick of a
   * page the writer sees, which everyone who can open this version can
   * open (`opensFor`), replaces the link's earlier entry; any other pick
   * counts for nothing. A publication into a share ignores picks, as it
   * does the draft's entries (`forReaders`).
   */
  chosen?: ReadonlyMap<string, PageId>;
  /**
   * How the Markdown's wikilinks are read, by default here
   * (`tableWikilinks`). Some text takes that far longer than its size
   * suggests (#47), so the web app reads them in a worker with a time
   * limit. If the read fails, the table is kept as it was (`writeLinks`).
   */
  read?: ReadWikilinks;
};

/** Reads a page's wikilinks as `tableWikilinks` does, maybe somewhere it can end. */
export type ReadWikilinks = (markdown: string) => Promise<PlacedWikilink[]>;

// Reading them here, on this thread.
const readHere: ReadWikilinks = async (markdown) => tableWikilinks(markdown);

/** A payload as `writeLinks` wrote it. */
export type Linked = {
  payload: PagePayload;
  /**
   * `payload` with only the table entries its links use: what an editor's
   * next save builds on (`linksInUse`). When `kept`, `payload` itself.
   */
  inUse: PagePayload;
  /** Each target text the write renamed, once (`renamedLinks`). */
  renamed: RenamedLink[];
  /** The links couldn't be read: the table was kept as it was, and nothing renamed. */
  kept: boolean;
};

/**
 * A page the writer sees. Its region is its key material's, or null when
 * the tree places it elsewhere: then no entry names it.
 */
type Target = LinkablePage & {
  id: PageId;
  region: Region | null;
  publishedHead: RevisionId | null;
};

/** One page link's outcome: the page its entry names, if kept, and its target text rewritten. */
type Decision = { link: PlacedWikilink; pageId: PageId | null; renamed: string | null };

/**
 * `payload` as written for `write`, with its table worked out afresh:
 *
 * - a page the writer just picked for a link (`chosen`) replaces the link's
 *   entry from the payload's table, when everyone who can open this
 *   version can open it; else the entry stands;
 * - in a draft, or a publication in the owner region, a link's entry from
 *   the payload's table is followed when the writer sees its page; else
 *   the link resolves by title among the pages the writer sees, and only a
 *   single match counts (an ambiguous link gets an entry only from an
 *   earlier choice). When a page this version could name is titled as the
 *   link's text and the entry names another, the title wins: the text may
 *   be newly typed for that page;
 * - a publication into a share goes the same way, but only by what its
 *   readers there can already read (`forReaders`): its pages' publications
 *   there, by their titles, and this page's current publication there, as
 *   the earlier choice. Neither the draft's entries, the writer's picks,
 *   nor any other page's draft title counts;
 * - an entry is kept only when everyone who can open this version can open
 *   its page (`opensFor`), and for a publication into a share, only when
 *   this app opened the page's publication in that share;
 * - a draft keeps an earlier entry whose page the writer doesn't see, while
 *   its text is unchanged and the table came from this write's region
 *   (`tableRegion`): an agent sees only its picks, and an editor may see
 *   less than an earlier writer. Everyone who opened that version opens
 *   this one;
 * - in a draft, a link without its own text whose entry is kept names its
 *   page's published title in the source (`[[Old]]` becomes `[[New]]`,
 *   in a property's value through `setProperty`, changing only its
 *   characters), when that publication is in this write's region
 *   (`renameTo`). The
 *   entry keeps its old key too, for this version, so text from before
 *   the rename still names the page, unless the old text is the title of
 *   another page this version could name.
 *
 * A table in a format this app doesn't know is kept as it is in a draft in
 * the region it came from; else it is worked out afresh in format 1.
 * Markdown whose links can't be read, in time or at all (`read`), keeps
 * its table as it was (`keptTable`).
 */
export async function writeLinks(payload: PagePayload, write: LinkWrite): Promise<Linked> {
  const { [LINKS_NAMESPACE]: stored, ...others } = payload.extensions;
  const without: PagePayload = { ...payload, extensions: others };
  const carries = write.tableRegion !== undefined && sameRegion(write.tableRegion, write.region);
  const newer = stored !== undefined && newerTable(stored);
  const as = (written: PagePayload): Linked => ({
    payload: written,
    inUse: written,
    renamed: [],
    kept: false,
  });
  if (newer && carries && write.audience === 'draft') return as(payload);
  const read = write.read ?? readHere;
  let links: PlacedWikilink[];
  try {
    links = (await read(payload.markdown)).filter((link) => !link.embed && link.target !== '');
  } catch {
    return { ...as(keptTable(payload, write, carries)), kept: true };
  }
  if (links.length === 0) return as(without);
  const readers = write.audience === 'published' && write.region.kind === 'share';
  const targets = targetsOf(await write.tree(), payload.title, write, readers);
  const previous = newer ? new Map<string, PageId>() : linkTableOf(payload);
  const decisions = readers
    ? await forReaders(links, targets, write)
    : await decide(links, previous, targets, { ...write, carries });
  const { markdown, keyed, formerly, renames } = await renamed(payload.markdown, decisions, read);
  const entries = new Map<string, PageId>();
  for (const { key, pageId } of [...keyed, ...formerly]) {
    if (pageId && !entries.has(key)) entries.set(key, pageId);
  }
  const used = new Set(keyed.map(({ key }) => key));
  const withEntries = (pairs: [string, PageId][]): PagePayload => ({
    ...payload,
    markdown,
    extensions: pairs.length === 0 ? others : { ...others, [LINKS_NAMESPACE]: tableOf(pairs) },
  });
  return {
    payload: withEntries([...entries]),
    inUse: withEntries([...entries].filter(([key]) => used.has(key))),
    renamed: renames,
    kept: false,
  };
}

// The table, in format 1, holding `pairs` of key and page ID.
const tableOf = (pairs: Iterable<readonly [string, PageId]>) =>
  ({
    format: 1,
    links: [...pairs].map(([key, pageId]) => ({ key, pageId })),
  }) satisfies LinkTable;

/**
 * `payload` with the table it keeps when its links can't be read: in a
 * draft, its own, when that came from this write's region (`carries`); in
 * a publication, the one readers there already read, the page's current
 * publication's. Everyone who can open this version could open the one the
 * table came from, so it names nothing new to them. Else none: it may name
 * pages this version's readers can't open.
 */
function keptTable(payload: PagePayload, write: LinkWrite, carries: boolean): PagePayload {
  const { [LINKS_NAMESPACE]: _stored, ...others } = payload.extensions;
  if (write.audience === 'draft') return carries ? payload : { ...payload, extensions: others };
  const read = write.publication;
  const kept =
    read && sameRegion(read.region, write.region) ? read.table : new Map<string, PageId>();
  return {
    ...payload,
    extensions: kept.size === 0 ? others : { ...others, [LINKS_NAMESPACE]: tableOf(kept) },
  };
}

// A table whose format is a number other than 1: a newer client's.
const newerTable = (stored: unknown) => {
  const format = z.object({ format: z.number() }).safeParse(stored);
  return format.success && format.data.format !== 1;
};

/**
 * Each page of `tree` the writer sees, as a link target, with this page
 * under its title as written now. A page the tree can't place (one whose
 * folders don't reach its share or the top), or whose version this app
 * didn't open, counts as one the writer doesn't see. For a publication
 * into a share (`readers`), a page's folders start at the share's root:
 * its readers see none above it.
 */
function targetsOf(
  tree: LinkTree,
  title: string,
  write: LinkWrite,
  readers: boolean,
): Map<string, Target> {
  const self = (page: { id: PageId }) => page.id === write.page.id;
  const listed = tree.pages.some(self);
  const pages = [
    ...tree.pages.map((page) => (self(page) ? { ...page, title, region: write.region } : page)),
    ...(listed
      ? []
      : [
          {
            id: write.page.id,
            parentId: write.page.parentId ?? null,
            title,
            region: write.region,
            publishedHead: null,
          },
        ]),
  ];
  const parents = new Map<string, string | null>([
    ...tree.folders.map((folder) => [folder.id, folder.parentId] as const),
    ...pages.map((page) => [page.id, page.parentId] as const),
  ]);
  const placed = (nodeId: string): Region | null => {
    try {
      return regionInTree({
        subject: { kind: 'node', nodeId },
        parentOf: (id) => parents.get(id),
        shares: tree.shares,
      });
    } catch {
      // A tree that doesn't reach the page's share or the top can't place it.
      return null;
    }
  };
  const root = readers
    ? tree.shares.find((share) =>
        sameRegion({ kind: 'share', spaceId: share.spaceId, shareId: share.shareId }, write.region),
      )?.rootId
    : undefined;
  const folders = tree.folders.map((folder) =>
    folder.id === root ? { ...folder, parentId: null } : folder,
  );
  const linkable = linkablePages({ folders, pages });
  const targets = new Map<string, Target>();
  pages.forEach((page, i) => {
    let region: Region | null = page.region;
    if (!self(page)) {
      const inTree = placed(page.id);
      if (inTree === null || page.region === null) return;
      // The tree is only compared with the key material, never trusted over it.
      if (!sameRegion(inTree, page.region)) region = null;
    }
    targets.set(page.id, {
      title: page.title,
      folders: linkable[i]?.folders ?? [],
      id: page.id,
      region,
      publishedHead: page.publishedHead,
    });
  });
  return targets;
}

/**
 * Whether everyone who can open a version of `write` can open `target`:
 * the page itself; any page of the space when the version is in the owner
 * region, which only sealing owners open and they hold every key; else a
 * page in the same share. A publication into a share also needs the page's
 * publication there (`forReaders`).
 */
const opensFor = (target: Target, write: LinkWrite): boolean =>
  target.id === write.page.id ||
  (target.region !== null &&
    (write.region.kind === 'owner' || sameRegion(target.region, write.region)));

/**
 * Each page's current publication in this write's region, opened, among
 * `wanted`: the rest have none this app opened there.
 */
async function publicationsIn(
  wanted: readonly Target[],
  write: LinkWrite,
): Promise<ReadonlyMap<PageId, OpenedPublication>> {
  const asked = new Map<PageId, { id: PageId; publishedHead: RevisionId; region: Region }>();
  for (const { id, publishedHead, region } of wanted) {
    if (publishedHead && region) asked.set(id, { id, publishedHead, region });
  }
  if (asked.size === 0) return new Map();
  const opened = await write.published([...asked.values()]);
  return new Map([...opened].filter(([, found]) => sameRegion(found.region, write.region)));
}

/** How a draft, or a publication in the owner region, decides its links. */
async function decide(
  links: readonly PlacedWikilink[],
  previous: ReadonlyMap<string, PageId>,
  targets: ReadonlyMap<string, Target>,
  write: LinkWrite & { carries: boolean },
): Promise<Decision[]> {
  const pages = [...targets.values()];
  const self = (target: Target) => target.id === write.page.id;
  const chosen = links.map((link) => {
    const [resolved] = resolveWikilinks([link], { pages, selfId: write.page.id });
    const byTitle = (resolved?.targets ?? []).flatMap((id) => targets.get(id) ?? []);
    // A page the writer just picked replaces the earlier entry. A pick the
    // audience rule refuses leaves the earlier entry as it was.
    const choice = write.chosen?.get(linkKey(link));
    const picked = choice === undefined ? undefined : targets.get(choice);
    const held = picked && opensFor(picked, write) ? picked : undefined;
    const stored = held?.id ?? previous.get(linkKey(link));
    // An entry gives way to a page titled as the link that this version
    // could name: the text may be newly typed for it.
    const titled = byTitle.some((target) => target.id === stored);
    const giveWay = byTitle.some((target) => opensFor(target, write)) && !titled;
    const entry = giveWay ? undefined : stored;
    const seen = entry === undefined ? undefined : targets.get(entry);
    if (entry !== undefined && seen === undefined) return { link, carried: entry };
    const target = seen ?? (byTitle.length === 1 ? byTitle[0] : undefined);
    return target && opensFor(target, write) ? { link, target } : { link };
  });
  // Only a page in this write's region may lend its title; and only when it
  // isn't already the link's text, as far as the writer's tree shows.
  const mayRename = (link: PlacedWikilink, target: Target) =>
    write.audience === 'draft' &&
    link.shown === null &&
    !self(target) &&
    target.region !== null &&
    sameRegion(target.region, write.region) &&
    renamedTarget(link, target) !== null;
  const opened = await publicationsIn(
    chosen.flatMap(({ link, target }) => (target && mayRename(link, target) ? [target] : [])),
    write,
  );
  return chosen.map(({ link, carried, target }) => {
    if (carried !== undefined) {
      const kept = write.audience === 'draft' && write.carries;
      return { link, pageId: kept ? carried : null, renamed: null };
    }
    if (!target) return { link, pageId: null, renamed: null };
    const title = self(target)
      ? target.title
      : mayRename(link, target)
        ? opened.get(target.id)?.title
        : undefined;
    const renamed =
      write.audience === 'draft' && link.shown === null && title
        ? renameTo(link, { ...target, title }, pages, write.page.id)
        : null;
    return { link, pageId: target.id, renamed };
  });
}

/**
 * How a publication into a share decides its links: only from what its
 * readers there can already read, so it shows them nothing new of drafts.
 * Each page it could name counts under its publication's title there, and
 * this page under the title written. The title wins: a link resolving by
 * title to one page names it. Else it keeps the entry this page's current
 * publication there has for it, when that page is one of the matches, or
 * there are none: so a link follows a page renamed since. Else it has no
 * entry. Nothing is renamed.
 *
 * A link without its own text matching none doesn't keep its entry when
 * another link names that page by title. This is a heuristic: it takes the
 * link as newly typed, maybe for a page not made yet, so a renamed page's
 * old text typed again doesn't name that page for readers. A save renames
 * such a link when it can, but not always, so this also drops an entry
 * readers were following whenever a save kept the entry without renaming
 * the link: say the writer doesn't see the page, the save had no tree, the
 * page's draft is still titled as the link, its publication wasn't yet
 * under the new title or didn't open, or the rename was blocked. Readers
 * then resolve the link by title
 * until a save renames it and this page is published again.
 */
async function forReaders(
  links: readonly PlacedWikilink[],
  targets: ReadonlyMap<string, Target>,
  write: LinkWrite,
): Promise<Decision[]> {
  const self = (target: Target) => target.id === write.page.id;
  const candidates = [...targets.values()].filter((target) => opensFor(target, write));
  const opened = await publicationsIn(
    candidates.filter((target) => !self(target)),
    write,
  );
  const pages = candidates.flatMap((target) => {
    const title = self(target) ? target.title : opened.get(target.id)?.title;
    return title ? [{ ...target, title }] : [];
  });
  const read =
    write.publication && sameRegion(write.publication.region, write.region)
      ? write.publication.table
      : new Map<string, PageId>();
  const matches = links.map(
    (link) => resolveWikilinks([link], { pages, selfId: write.page.id })[0]?.targets ?? [],
  );
  const titled = new Set(matches.flatMap((byTitle) => (byTitle.length === 1 ? byTitle : [])));
  return links.map((link, i) => {
    const byTitle = matches[i] ?? [];
    const entry = read.get(linkKey(link));
    const kept =
      entry !== undefined &&
      pages.some((page) => page.id === entry) &&
      (byTitle.length === 0 ? link.shown !== null || !titled.has(entry) : byTitle.includes(entry));
    const pageId = kept ? entry : byTitle.length === 1 ? targets.get(byTitle[0] ?? '')?.id : null;
    return { link, pageId: pageId ?? null, renamed: null };
  });
}

/**
 * The pages a draft of `page`, titled `title`, may name in its table, of
 * those `tree` lists, for the region the tree's version of the page opened
 * in. Saving works it out again; this tells the writer beforehand which
 * picks will hold.
 */
export function draftLinkTargets(
  tree: LinkTree,
  page: LinkWrite['page'],
  title: string,
): ReadonlySet<PageId> {
  const region = tree.pages.find((p) => p.id === page.id)?.region;
  if (!region) return new Set([page.id]);
  const write: LinkWrite = {
    page,
    audience: 'draft',
    region,
    tree: () => tree,
    published: async () => new Map(),
  };
  const targets = targetsOf(tree, title, write, false);
  return new Set([...targets.values()].filter((t) => opensFor(t, write)).map((t) => t.id));
}

// What a link names that can't stand in a title written into one: its
// brackets, alias bar and heading mark, a line break, and what could start
// a code span, tag or escape inside it.
const UNWRITABLE = /[[\]|#\r\n`<\\]/;

/** Whether `text` can be written as a link's target or heading as it is. */
export const writableInLink = (text: string) =>
  text !== '' && text === text.trim() && !UNWRITABLE.test(text);

/**
 * The target text naming `target` by `title`, or null when the link
 * already names it so, the title can't be written into a link, or the text
 * would resolve by title to another page, or to none, among the pages the
 * writer sees: anyone without the entry resolves it that way.
 */
function renameTo(
  link: PlacedWikilink,
  target: Target & { title: string },
  pages: readonly Target[],
  selfId: PageId,
): string | null {
  const text = renamedTarget(link, target);
  if (text === null) return null;
  const titled = pages.map((page) => (page.id === target.id ? target : page));
  const [found] = resolveWikilinks([{ ...link, target: text }], { pages: titled, selfId });
  return found?.status === 'resolved' && found.targets[0] === target.id ? text : null;
}

/**
 * The target text naming `target` by its title, keeping a folder prefix
 * that still names folders above it, or null when the link already names
 * it by that title, or the title can't be written into a link. A page only
 * moved, its title the same, keeps its link as written.
 */
function renamedTarget(link: PlacedWikilink, target: LinkablePage): string | null {
  const { title } = target;
  if (!title || !writableInLink(title)) return null;
  if (foldTitle(link.target) === foldTitle(title)) return null;
  const slash = link.target.lastIndexOf('/');
  if (slash < 0) return title;
  if (foldTitle(link.target.slice(slash + 1).trim()) === foldTitle(title)) return null;
  const prefix = link.target.slice(0, slash + 1);
  const parts = prefix
    .slice(0, -1)
    .split('/')
    .map((part) => foldTitle(part.trim()));
  const above = target.folders.map(foldTitle);
  const stillAbove =
    parts.length <= above.length &&
    parts.every((part, i) => above[above.length - parts.length + i] === part);
  return stillAbove && !title.includes('/') ? `${prefix}${title}` : title;
}

type Keyed = { key: string; pageId: PageId | null };

/**
 * `markdown` with each rename written into its link's source, the key and
 * page each link ends with, the old key of each renamed link, and each
 * target text renamed, once. A link that is a property's value is
 * rewritten with `setProperty`, which changes only that value's characters
 * and refuses a value it can't change so. A rename onto a key another link
 * names differently is skipped, so no link changes meaning; if the result
 * doesn't read back (`read`) as the same links with the new targets, none
 * is written.
 */
async function renamed(
  markdown: string,
  decisions: readonly Decision[],
  read: ReadWikilinks,
): Promise<{ markdown: string; keyed: Keyed[]; formerly: Keyed[]; renames: RenamedLink[] }> {
  const named = new Map<string, PageId | null>();
  for (const { link, pageId } of decisions) {
    const key = linkKey(link);
    if (!named.has(key)) named.set(key, pageId);
  }
  const unchanged = {
    markdown,
    keyed: decisions.map(({ link, pageId }) => ({ key: linkKey(link), pageId })),
    formerly: [],
    renames: [],
  };
  // Properties' links are in the frontmatter, written first; the body's
  // are written into the text after it.
  const block = splitFrontmatter(markdown).frontmatter;
  let frontmatter = block;
  let next = '';
  let at = block?.length ?? 0;
  let changed = false;
  const keyed: Keyed[] = [];
  const formerly: Keyed[] = [];
  for (const { link, pageId, renamed } of decisions) {
    const key = renamed === null ? null : foldTitle(renamed);
    const free = key !== null && (!named.has(key) || named.get(key) === pageId);
    if (renamed === null || key === null || !free) {
      keyed.push({ key: linkKey(link), pageId });
      continue;
    }
    if (link.property !== undefined) {
      const edit =
        frontmatter === null
          ? null
          : setProperty(frontmatter, link.property, withTarget(link.source, renamed));
      if (!edit?.ok) {
        keyed.push({ key: linkKey(link), pageId });
        continue;
      }
      frontmatter = edit.frontmatter;
    } else {
      const source = markdown.slice(link.start, link.end);
      if (source !== link.source || link.start < at) {
        keyed.push({ key: linkKey(link), pageId });
        continue;
      }
      next += markdown.slice(at, link.start) + withTarget(source, renamed);
      at = link.end;
    }
    changed = true;
    named.set(key, pageId);
    keyed.push({ key, pageId });
    // No other page this version could name has the old text as its title,
    // or the title would have won over the entry (`decide`): it still names
    // this one.
    formerly.push({ key: linkKey(link), pageId });
  }
  if (!changed) return unchanged;
  next = (frontmatter ?? '') + next + markdown.slice(at);
  // Read back: the same links, in order, now with the new targets.
  let back: PlacedWikilink[];
  try {
    back = (await read(next)).filter((link) => !link.embed && link.target !== '');
  } catch {
    return unchanged;
  }
  const same =
    back.length === keyed.length && back.every((link, i) => linkKey(link) === keyed[i]?.key);
  if (!same) return unchanged;
  const renames = new Map<string, RenamedLink>();
  decisions.forEach(({ link }, i) => {
    const to = back[i]?.target;
    if (to !== undefined && to !== link.target) {
      renames.set(`${link.target}\0${to}`, { from: link.target, to });
    }
  });
  return { markdown: next, keyed, formerly, renames: [...renames.values()] };
}

/** A link whose target a save rewrote to its page's new title. */
export type RenamedLink = { from: string; to: string };

/**
 * Each target text in `sent` that `saved`, the Markdown a save wrote from
 * it, names by another, once. None when the links can't be read, or don't
 * line up.
 */
export function renamedLinks(sent: string, saved: string): RenamedLink[] {
  if (saved === sent) return [];
  try {
    const [before, after] = [tableWikilinks(sent), tableWikilinks(saved)];
    if (before.length !== after.length) return [];
    const renamed = new Map<string, RenamedLink>();
    before.forEach((link, i) => {
      const to = after[i]?.target;
      if (to !== undefined && to !== link.target) {
        renamed.set(`${link.target}\0${to}`, { from: link.target, to });
      }
    });
    return [...renamed.values()];
  } catch {
    return [];
  }
}

/** `[[target#heading]]` with its target text replaced, whitespace and heading kept as written. */
function withTarget(source: string, target: string): string {
  const ref = source.slice(2, -2);
  const hash = ref.indexOf('#');
  const written = hash < 0 ? ref : ref.slice(0, hash);
  const lead = written.length - written.trimStart().length;
  const trail = written.length - written.trimEnd().length;
  return `[[${written.slice(0, lead)}${target}${written.slice(written.length - trail)}${hash < 0 ? '' : ref.slice(hash)}]]`;
}
