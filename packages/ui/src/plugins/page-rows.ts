import {
  parsePageQuery,
  runPageQuery,
  tagProperties,
  type PageQuery as ReadQuery,
  type PropertyData,
  type QueryFolder,
  type searchOperations,
} from '@wikistow/client';
import {
  PluginError,
  QUERY_LIMIT,
  type PageQuery,
  type PageQueryResult,
  type PageRow,
} from '@wikistow/plugin-sdk';
import { blockProperties } from './block-properties';

// What `host.pages.index` and `host.pages.query` give a plugin (#401): the
// pages of one space it can read, as the person's search index holds them,
// with their properties, and what a `wikistow-query` block of a query
// would list among them. Pure, and linear in the space's pages, as query
// tables are, so they never read a page again.

type Entry = searchOperations.IndexedEntry;

/**
 * What a plugin can read of one space: its pages, as the index holds them,
 * by title, its folders, by the app's tree, each with its name, and the
 * folder each page is in, by the tree too.
 */
export type ReadableSpace = {
  pages: readonly Entry[];
  folders: readonly QueryFolder[];
  parents: ReadonlyMap<string, string | null>;
};

/**
 * The pages and folders of a space the plugin can read (`readable`, by a
 * node's ID): `entries`, the space's pages in the index, among `tree`'s, so
 * a page the tree no longer holds there is left out, and `tree`'s folders.
 * A copy unpublished where it is, which `read` can't open, is left out too.
 */
export function readableSpace(
  entries: readonly Entry[],
  tree: {
    folders: readonly { id: string; parentId: string | null; name: string | null }[];
    pages: readonly { id: string; parentId: string | null }[];
  },
  readable: (nodeId: string) => boolean,
): ReadableSpace {
  const parents = new Map(tree.pages.map(({ id, parentId }) => [id, parentId]));
  return {
    pages: entries.filter(
      (entry) => parents.has(entry.pageId) && !entry.unpublished && readable(entry.pageId),
    ),
    folders: tree.folders
      .filter((folder) => readable(folder.id))
      .map(({ id, parentId, name }) => ({ id, parentId, name })),
    parents,
  };
}

/** A page's tags, as `PageRow.tags` gives them. */
function tagsOf(properties: readonly Readonly<PropertyData>[]): string[] {
  const [property] = tagProperties(properties);
  if (!property) return [];
  const { value } = property;
  const items: unknown[] = Array.isArray(value) ? value.flat() : [value];
  const tags = new Map<string, string>();
  for (const item of items) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') continue;
    const tag = String(item).trim().replace(/^#/, '');
    const folded = tag.toLocaleLowerCase('en');
    if (tag !== '' && !tags.has(folded)) tags.set(folded, tag);
  }
  return [...tags.values()];
}

/**
 * `entry` as a plugin gets it, in the folder `parentId` the tree has it
 * in, its path through `folders`, those it can read.
 */
export function pageRow(
  entry: Entry,
  folders: ReadonlyMap<string, QueryFolder>,
  parentId: string | null,
): PageRow {
  const path: (string | null)[] = [];
  const seen = new Set<string>();
  for (let id = parentId; id !== null && !seen.has(id);) {
    seen.add(id);
    const folder = folders.get(id);
    if (!folder) break;
    path.unshift(folder.name);
    id = folder.parentId;
  }
  return {
    page: { spaceId: entry.spaceId, pageId: entry.pageId },
    title: entry.title,
    folderId: parentId,
    path,
    tags: tagsOf(entry.properties),
    properties: blockProperties(entry.properties) ?? {},
    revision: entry.revisionId,
    draft: entry.draft,
  };
}

/** Every page of `space` as a row, by title, as `host.pages.index` gives them. */
export function pageRows(space: ReadableSpace): PageRow[] {
  const folders = new Map(space.folders.map((folder) => [folder.id, folder]));
  return space.pages.map((entry) =>
    pageRow(entry, folders, space.parents.get(entry.pageId) ?? null),
  );
}

const PARTS = ['from', 'where', 'sort'] as const;

/**
 * `query` as a block's lines read it, or `invalid` saying why it doesn't
 * read, as the block would. App code's arguments come unchecked, so each
 * part is checked here.
 */
export function readPluginQuery(query: PageQuery): ReadQuery {
  if (typeof query !== 'object' || query === null) {
    throw new PluginError('invalid', 'A query is an object');
  }
  const lines: string[] = [];
  for (const name of PARTS) {
    const part: unknown = query[name];
    if (part === undefined) continue;
    if (typeof part !== 'string' || /[\r\n]/.test(part)) {
      throw new PluginError('invalid', `${name} is one line of text`);
    }
    lines.push(`${name}: ${part}`);
  }
  const limit: unknown = query.limit;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > QUERY_LIMIT) {
      throw new PluginError('invalid', `limit is a whole number from 1 to ${QUERY_LIMIT}`);
    }
    lines.push(`limit: ${limit}`);
  }
  const read = parsePageQuery(lines.join('\n'));
  if (!read.ok) throw new PluginError('invalid', read.error);
  return read.query;
}

/**
 * The rows `query` lists in `space`, as a `wikistow-query` block of it
 * lists them there, or `invalid` saying why it can't run, such as a `from`
 * naming no folder the plugin can read.
 */
export function queryRows(query: ReadQuery, space: ReadableSpace): PageQueryResult {
  const result = runPageQuery(query, space);
  if (!result.ok) throw new PluginError('invalid', result.error);
  const folders = new Map(space.folders.map((folder) => [folder.id, folder]));
  return {
    rows: result.rows.map(({ page }) =>
      pageRow(page, folders, space.parents.get(page.pageId) ?? null),
    ),
    total: result.total,
  };
}

/** A page whose row changed, or was added or removed: where it is, or was. */
export type IndexChange = { spaceId: string; folderIds: readonly string[] };

const key = (doc: { spaceId: string; pageId: string }) => `${doc.spaceId}/${doc.pageId}`;

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * The pages whose rows may differ between `before` and `after`, each where
 * it is in either: a page in only one of them, another version of it, or
 * one moved, or whose folders were renamed. Linear in their pages; a page
 * held as it was, as an index derived from another keeps it, costs nothing.
 */
export function indexChanges(
  before: searchOperations.PageIndex | undefined,
  after: searchOperations.PageIndex,
): IndexChange[] {
  type Held = ReturnType<searchOperations.PageIndex['pages']>[number];
  const was = new Map<string, Held>((before?.pages() ?? []).map((page) => [key(page.doc), page]));
  const changes: IndexChange[] = [];
  for (const page of after.pages()) {
    const k = key(page.doc);
    const old = was.get(k);
    was.delete(k);
    if (old === page) continue;
    const { doc } = page;
    // A copy unpublished where it is is in no row (`readableSpace`), before or after.
    if (doc.unpublished && (!old || old.doc.unpublished)) continue;
    if (
      old &&
      old.doc.revisionId === doc.revisionId &&
      old.doc.parentId === doc.parentId &&
      old.doc.draft === doc.draft &&
      old.doc.unpublished === doc.unpublished &&
      sameList(old.doc.folderIds, doc.folderIds) &&
      sameList(old.doc.path, doc.path)
    )
      continue;
    changes.push({ spaceId: doc.spaceId, folderIds: doc.folderIds });
    if (old && !sameList(old.doc.folderIds, doc.folderIds))
      changes.push({ spaceId: old.doc.spaceId, folderIds: old.doc.folderIds });
  }
  for (const { doc } of was.values())
    if (!doc.unpublished) changes.push({ spaceId: doc.spaceId, folderIds: doc.folderIds });
  return changes;
}
