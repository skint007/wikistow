// Public links (ADR 0005): a readable copy of a page's published version,
// which the server renders and serves at `/p/<id>`. Each call here sends
// plaintext to the server, so the app makes one only after saying so on
// screen: from the public link dialog, or a Publish that asked first.
import {
  pageRoutes,
  publicLinkRoutes,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { utf8 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import { PageId as PageIdSchema } from '../ids.ts';
import { linkKey, linkTableOf, resolveLinked, writableInLink } from '../link-table.ts';
import {
  findWikilinks,
  foldTitle,
  linkablePages,
  resolveWikilinks,
  type LinkablePage,
} from '../links.ts';
import {
  findProperty,
  markdownLiteral,
  markdownNodes,
  mayReferOtherPages,
  parseMarkdown,
  parsePropertyReference,
  propertyLabel,
  propertyText,
  readProperties,
  splitFrontmatter,
  type PropertyData,
  type ReferencedPage,
  type Wikilink,
} from '../markdown/index.ts';
import type { PagePayload } from '../payload.ts';
import {
  parsePageQuery,
  QUERY_LANGUAGE,
  runPageQuery,
  type QueryPage,
  type QueryRow,
} from '../query.ts';
import { sameRegion } from '../regions.ts';
import { attachmentsShown, bodyHtml, chooseFiles, embedHtml } from '../reader/body-html.ts';
import { readBody } from '../reader/reading.ts';
import {
  loadPage,
  openPublications,
  openRevisionOf,
  openRevisions,
  readAttachment,
  type PageRef,
} from './pages.ts';
import { nameOf } from './search.ts';
import type { ClientContext } from './session.ts';
import { loadTree } from './spaces.ts';

/** Turn the page's link on, or find the one it has: its id, for `/p/<id>`. */
export async function turnOn(ctx: ClientContext, pageId: PageId) {
  return (await ctx.api.call(publicLinkRoutes.turnOn, { params: { pageId } })).id;
}

/** Turn the page's link off. The server deletes every copy of it at once. */
export async function turnOff(ctx: ClientContext, pageId: PageId) {
  await ctx.api.call(publicLinkRoutes.turnOff, { params: { pageId } });
}

/** The space's pages with a link on, as the server tells this person (`ListedLink`). */
export async function list(ctx: ClientContext, spaceId: SpaceId) {
  return (await ctx.api.call(publicLinkRoutes.list, { params: { spaceId } })).links;
}

/**
 * The properties of the page a reference to another page's value names
 * (`` `=[[Page]].key` ``), as a public copy writes them in: that page's
 * published version's, or undefined when the link names none.
 */
export type OtherValues = (page: Wikilink) => readonly PropertyData[] | undefined;

/**
 * The Markdown a public copy holds (ADR 0006, decision 9): the page's
 * body without its frontmatter, each reference to a value written in as
 * the value's text, escaped so that it reads as just that text, never as
 * Markdown or HTML; a web or email address in it, or one it makes with the
 * text after it, is still linked, whole, as GFM links one in any text. A
 * reference to one of the page's values (`` `=servings` ``) takes it from
 * its frontmatter, and one to another page's (`` `=[[Page]].key` ``) from
 * `others`. Dates go as written, as the copy has no reader's locale, and
 * an empty value as a dash, as the reader shows it. A reference that names
 * no property, or no page `others` knows, or a page whose block doesn't
 * read, stays as written.
 *
 * A code span keeps the text either side of it apart: `<a href=` before
 * one is text, not the start of a tag. So each `<` in the text of a block
 * (a paragraph, heading or table cell) with a value written in is escaped
 * too, which leaves it the text it was.
 */
export function copyBody(
  markdown: string,
  others: OtherValues = () => undefined,
  tables: QueryTables = () => undefined,
): string {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const read = readProperties(frontmatter);
  const own = read.ok ? read.properties : [];
  if (own.length === 0 && !mayReferOtherPages(body) && !body.includes(QUERY_LANGUAGE)) return body;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const block of markdownNodes(parseMarkdown(body))) {
    if (block.type === 'code' && block.lang === QUERY_LANGUAGE) {
      const table = tables(block.value);
      const start = block.position?.start.offset;
      const end = block.position?.end.offset;
      if (table && start !== undefined && end !== undefined) {
        edits.push({ start, end, text: tableIn(body, start, end, table) });
      }
      continue;
    }
    if (block.type !== 'paragraph' && block.type !== 'heading' && block.type !== 'tableCell') {
      continue;
    }
    const inline = [...markdownNodes(block)];
    let written = false;
    for (const node of inline) {
      if (node.type !== 'inlineCode') continue;
      const reference = parsePropertyReference(node.value);
      const properties = reference?.page ? others(reference.page) : own;
      const property = reference && properties && findProperty(properties, reference.name);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (!property || start === undefined || end === undefined) continue;
      // An empty value is a dash, as the reader shows it, so no blank line is left.
      const value = propertyText(property, { dates: 'as-written' }) || '–';
      edits.push({ start, end, text: markdownLiteral(value) });
      written = true;
    }
    if (!written) continue;
    for (const node of inline) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.type !== 'text' || start === undefined || end === undefined) continue;
      // A `<` after an odd run of backslashes is escaped already.
      for (const found of body.slice(start, end).matchAll(/(?<!\\)(?:\\\\)*</g)) {
        const at = start + found.index + found[0].length - 1;
        edits.push({ start: at, end: at, text: '\\' });
      }
    }
  }
  edits.sort((a, b) => a.start - b.start);
  let copy = '';
  let at = 0;
  for (const edit of edits) {
    if (edit.start < at) continue;
    copy += body.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return copy + body.slice(at);
}

/**
 * `table`'s lines in place of the block from `start` to `end` of `body`,
 * inside whatever holds it: each line after the first starts as the
 * block's first line does before it, a list item's marker as spaces, a
 * quote's `>` kept. With a blank line before it where text ends just
 * above, and after it where text starts just below, so neither is read as
 * part of the table.
 */
function tableIn(body: string, start: number, end: number, table: readonly string[]): string {
  const lineStart = body.lastIndexOf('\n', start - 1) + 1;
  const opening = body.slice(lineStart, start);
  const prefix = opening.replace(/[^>\s]/g, ' ').replace(/\r/g, '');
  const gap = prefix.trimEnd();
  // The page's own line breaks, CRLF or LF, as the block's are.
  const eol =
    body.slice(start, end).includes('\r\n') || body.slice(end).startsWith('\r\n') ? '\r\n' : '\n';
  const blank = (line: string) => line.replace(/[>\s]/g, '') === '';
  const lineBefore =
    lineStart === 0 ? '' : body.slice(body.lastIndexOf('\n', lineStart - 2) + 1, lineStart - 1);
  const after = body.slice(end).replace(/^\r(?=\n)/, '');
  const lineAfter = after.startsWith('\n') ? (after.slice(1).split('\n', 1)[0] ?? '') : '';
  // A blank line before it only where nothing but indentation starts its line.
  const before =
    lineStart === 0 || blank(lineBefore) || opening.trim() !== '' ? '' : `${eol}${prefix}`;
  const closing = after.startsWith('\n') && !blank(lineAfter) ? `${eol}${gap}` : '';
  return `${before}${table.join(`${eol}${prefix}`)}${closing}`;
}

/** The pages a body's references to other pages' values name (`` `=[[Page]].key` ``), in order. */
function referencedPages(body: string): ReferencedPage[] {
  if (!mayReferOtherPages(body)) return [];
  const pages: ReferencedPage[] = [];
  for (const node of markdownNodes(parseMarkdown(body))) {
    if (node.type !== 'inlineCode') continue;
    const page = parsePropertyReference(node.value)?.page;
    if (page) pages.push(page);
  }
  return pages;
}

/**
 * What a public copy of `markdown` shows of other pages, which the public
 * link dialog and the Publish confirmation say anyone with the link can
 * read: `values`, when a reference in its body names another page's
 * value, and `lists`, when it holds a query table.
 */
export function fromOtherPages(markdown: string): { values: boolean; lists: boolean } {
  const { body } = splitFrontmatter(markdown);
  return { values: referencedPages(body).length > 0, lists: queryBlocks(body).length > 0 };
}

/**
 * The published properties of each page the body's references to other
 * pages' values name (ADR 0006, decision 9), each page as a reader of the
 * copied version finds it: among the published pages everyone who can
 * open that version can open, as its link table names only those (any in
 * the owner region, else those in its share, with folders from the
 * share's root), by the version's link table first, then by published
 * title, with its folders. So a copy shows no page's value its page's own
 * readers couldn't see. A draft never counts: not its value,
 * even where this person edits the page, nor its title. The tree gives a
 * page's draft title where its draft changed since it was published, so
 * those pages' publications are opened for their titles, and only when a
 * reference isn't in the table. A page whose publication can't be fetched
 * or opened names none, and the reference stays as written. A reference to
 * this page takes the version being copied.
 */
async function otherValues(
  ctx: ClientContext,
  page: PageRef,
  payload: PagePayload,
  tree: () => ReturnType<typeof loadTree>,
): Promise<OtherValues> {
  const links = referencedPages(splitFrontmatter(payload.markdown).body);
  if (links.length === 0) return () => undefined;
  const loaded = await tree();
  const opened = new Map<string, Promise<Publication | null>>();
  const open = (pageId: string) => {
    let found = opened.get(pageId);
    if (!found) opened.set(pageId, (found = publication(ctx, page, pageId, summaries)));
    return found;
  };
  const { summaries, published, folders } = audienceOf(loaded, page);
  const table = linkTableOf(payload);
  // A link whose entry names a published page goes there, as a reader's does.
  const chosen = new Map<string, string>();
  for (const link of links) {
    const entry = table.get(linkKey(link));
    if (entry !== undefined && published(entry)) chosen.set(linkKey(link), entry);
  }
  const untabled = links.filter((link) => !chosen.has(linkKey(link)));
  if (untabled.length > 0) {
    // Every page it reaches under its published title; this page under the copied version's.
    const linkable = linkablePages({ folders, pages: loaded.pages });
    const changed = loaded.pages.filter(
      (summary) =>
        summary.id !== page.pageId &&
        published(summary.id) &&
        summary.draftHead !== null &&
        summary.draftChanges,
    );
    const batch = await openPublications(
      ctx,
      page.spaceId,
      changed.flatMap(({ id, publishedHead }) => (publishedHead ? [{ id, publishedHead }] : [])),
    );
    for (const { id } of changed) {
      const payload = batch.get(id);
      opened.set(id, Promise.resolve(payload ? publicationOf(payload) : null));
    }
    const pages: LinkablePage[] = [];
    for (const [i, found] of linkable.entries()) {
      const summary = loaded.pages[i];
      const title =
        found.id === page.pageId
          ? payload.title
          : !summary || !published(summary.id)
            ? null
            : opened.has(found.id)
              ? ((await open(found.id))?.title ?? null)
              : found.title;
      pages.push({ ...found, title });
    }
    for (const link of resolveWikilinks(untabled, { pages, selfId: page.pageId })) {
      const [pageId] = link.targets;
      if (link.status === 'resolved' && pageId !== undefined) chosen.set(linkKey(link), pageId);
    }
  }
  const own = readProperties(splitFrontmatter(payload.markdown).frontmatter);
  const values = new Map<string, readonly PropertyData[]>();
  for (const [key, pageId] of chosen) {
    const found =
      pageId === page.pageId
        ? own.ok
          ? own.properties
          : undefined
        : (await open(pageId))?.properties;
    if (found) values.set(key, found);
  }
  return (link) => values.get(linkKey(link));
}

type LoadedTree = Awaited<ReturnType<typeof loadTree>>;

/**
 * What a public copy of `page` may show of other pages: those everyone
 * who can open its version can open, as its link table names only those.
 * Any page in the owner region, which only owners read, who hold every
 * key; else those in its share. `published` says whether a page is one of
 * those with a publication, or `page` itself; `folders` are the tree's,
 * starting at the share's root for a share, where its readers' start.
 */
function audienceOf(loaded: LoadedTree, page: PageRef) {
  const summaries = new Map<string, (typeof loaded.pages)[number]>(
    loaded.pages.map((summary) => [summary.id, summary]),
  );
  // The copied version's region, as its key material puts it; none where it can't be told.
  const region = summaries.get(page.pageId)?.region ?? null;
  const reached = (pageId: string) => {
    const there = summaries.get(pageId)?.region;
    return region !== null && (region.kind === 'owner' || (!!there && sameRegion(there, region)));
  };
  const published = (pageId: string) =>
    pageId === page.pageId || (!!summaries.get(pageId)?.publishedHead && reached(pageId));
  const root =
    region?.kind === 'share'
      ? loaded.shares.find(
          (share) => share.spaceId === region.spaceId && share.shareId === region.shareId,
        )?.rootId
      : undefined;
  const folders = loaded.folders.map((folder) =>
    folder.id === root ? { ...folder, parentId: null } : folder,
  );
  return { summaries, region, root, published, folders };
}

/**
 * A query table as a public copy holds it: a GFM table, the page then each
 * column, every cell written as its text (`markdownLiteral`), so a `|`, a
 * line break or any Markdown or HTML in a value is only text. A page's
 * cell is `[[Title]]` where `linked` says it may link, else its title. A
 * value is written as the rows show it, a date as written, a list
 * comma-separated; a missing one leaves its cell empty.
 */
export function queryTableMarkdown<P extends { title: string }>(
  { columns, rows }: { columns: readonly string[]; rows: readonly QueryRow<P>[] },
  linked: (page: P) => boolean,
): string[] {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [
    line(['Page', ...columns.map((column) => markdownLiteral(propertyLabel(column)))]),
    line(['---', ...columns.map(() => '---')]),
    ...rows.map(({ page, values }) =>
      line([
        linked(page) ? `[[${page.title}]]` : markdownLiteral(page.title || 'Untitled'),
        ...values.map((value) =>
          value ? markdownLiteral(propertyText(value, { dates: 'as-written' })) : '',
        ),
      ]),
    ),
  ];
}

/** A query block's text, as a public copy writes it: its table's lines, or undefined to leave it as written. */
export type QueryTables = (source: string) => string[] | undefined;

/** The query blocks in a body, by their text: fenced code labelled `wikistow-query`. */
function queryBlocks(body: string): string[] {
  if (!body.includes(QUERY_LANGUAGE)) return [];
  const sources: string[] = [];
  for (const node of markdownNodes(parseMarkdown(body))) {
    if (node.type === 'code' && node.lang === QUERY_LANGUAGE) sources.push(node.value);
  }
  return sources;
}

/**
 * Each query block of the copied version as its public copy writes it
 * (ADR 0006, decision 9): the table as it stands now, run over the
 * published versions of the pages the copy may show (`audienceOf`), opened
 * here, never a draft. A page links only to a public page: one with a link
 * of its own, named by its published title alone, which the server is
 * told as a target (`targets`), as for the body's wikilinks, unless the
 * body or another row writes that text for another page. Any other is its
 * title as text. A block that doesn't read, or can't run, stays as written.
 */
async function queryTables(
  ctx: ClientContext,
  page: PageRef,
  payload: PagePayload,
  tree: () => ReturnType<typeof loadTree>,
  body: { keys: ReadonlySet<string>; targets: ReadonlyMap<string, PageId> },
): Promise<{ tables: QueryTables; targets: { key: string; pageId: PageId }[] }> {
  const blocks = queryBlocks(splitFrontmatter(payload.markdown).body);
  if (blocks.length === 0) return { tables: () => undefined, targets: [] };
  const loaded = await tree();
  const { summaries, published, folders, root } = audienceOf(loaded, page);
  const others = loaded.pages.filter(
    (summary) => summary.id !== page.pageId && published(summary.id),
  );
  // Strict: a table missing pages that couldn't be fetched would be wrong, not empty.
  const opened = await openPublications(
    ctx,
    page.spaceId,
    others.flatMap(({ id, publishedHead }) => (publishedHead ? [{ id, publishedHead }] : [])),
    { strict: true },
  );
  // Each folder a reader of the copy sees: under the share's root, for a share.
  const parents = new Map<string, string | null>(
    folders.map((folder) => [folder.id, folder.parentId]),
  );
  const above = (id: string | null) => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (let at = id; at !== null && !seen.has(at); at = parents.get(at) ?? null) {
      seen.add(at);
      ids.unshift(at);
    }
    return ids;
  };
  const seen = (ids: readonly string[]) => root === undefined || ids[0] === root;
  const pages: (QueryPage & { pageId: PageId })[] = [];
  const own = readProperties(splitFrontmatter(payload.markdown).frontmatter);
  for (const summary of [summaries.get(page.pageId), ...others]) {
    if (!summary) continue;
    const version =
      summary.id === page.pageId
        ? { title: payload.title, properties: own.ok ? own.properties : [] }
        : (() => {
            const found = opened.get(summary.id);
            return found && publicationOf(found);
          })();
    if (version) pages.push({ pageId: summary.id, folderIds: above(summary.parentId), ...version });
  }
  // In the order the index lists them: by title, then ID.
  pages.sort(
    (a, b) =>
      a.title.localeCompare(b.title) || (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0),
  );
  const shown = folders
    .filter((folder) => seen(above(folder.id)))
    .map((folder) => ({ id: folder.id, parentId: folder.parentId, name: nameOf(folder.metadata) }));
  const linkOn = new Set((await list(ctx, page.spaceId)).map((link) => link.pageId));
  // A title two rows' pages share names neither; nor does one the body writes for another page.
  const titled = new Map<string, Set<string>>();
  for (const { title, pageId } of pages) {
    const key = foldTitle(title);
    titled.set(key, (titled.get(key) ?? new Set()).add(pageId));
  }
  const targets = new Map<string, PageId>();
  const linked = (row: { title: string; pageId: PageId }) => {
    const key = foldTitle(row.title);
    const ok =
      row.pageId !== page.pageId &&
      linkOn.has(row.pageId) &&
      writableInLink(row.title) &&
      key.length <= publicLinkRoutes.MAX_TARGET_KEY &&
      titled.get(key)?.size === 1 &&
      (body.targets.get(key) ?? row.pageId) === row.pageId &&
      (!body.keys.has(key) || body.targets.get(key) === row.pageId);
    if (ok) targets.set(key, row.pageId);
    return ok;
  };
  const written = new Map<string, string[] | undefined>();
  for (const source of blocks) {
    if (written.has(source)) continue;
    const read = parsePageQuery(source);
    const result = read.ok ? runPageQuery(read.query, { pages, folders: shown }) : null;
    written.set(source, result?.ok ? queryTableMarkdown(result, linked) : undefined);
  }
  return {
    tables: (source) => written.get(source),
    targets: [...targets].map(([key, pageId]) => ({ key, pageId })),
  };
}

/** A page's publication as a public copy reads it: its title and properties. */
type Publication = { title: string; properties: readonly PropertyData[] };

const publicationOf = (payload: PagePayload): Publication => {
  const read = readProperties(splitFrontmatter(payload.markdown).frontmatter);
  return { title: payload.title, properties: read.ok ? read.properties : [] };
};

/** `pageId`'s current publication, or null when it has none this person can open. */
async function publication(
  ctx: ClientContext,
  page: PageRef,
  pageId: string,
  summaries: ReadonlyMap<string, { publishedHead: RevisionId | null }>,
): Promise<Publication | null> {
  const head = summaries.get(pageId)?.publishedHead;
  if (!head) return null;
  const target = { spaceId: page.spaceId, pageId: PageIdSchema.parse(pageId) };
  try {
    const version = (await openRevisions(ctx, target, 'published', [head])).get(head)?.opened;
    return version?.kind === 'current' ? publicationOf(version.payload) : null;
  } catch (error) {
    // A page whose version can't be fetched, or fails its checks, shows no value.
    if (!(error instanceof ApiError) && !(error instanceof CryptoError)) throw error;
    return null;
  }
}

/** A page body's attachments it shows or links to, in the order the server's reader finds them. */
export function attachmentsUsed(body: string, attachments: PagePayload['attachments']) {
  const tree = bodyHtml(readBody(body), (link) =>
    // An embed the reader can't show stays text, as the server renders it.
    link.unsupported
      ? { type: 'text', value: link.source }
      : link.embed
        ? embedHtml(link, attachments)
        : { type: 'text', value: link.value },
  );
  // Keyed by plain string, as the tree's addresses are.
  const byId = new Map<string, (typeof attachments)[number]>(
    attachments.map((ref) => [ref.id, ref]),
  );
  return attachmentsShown(tree).flatMap((id) => byId.get(id) ?? []);
}

/**
 * Which of the page's wikilinks may lead to another public page, by key:
 * those that name, by its current published title alone, a page of the
 * space whose link is on. Each is resolved against this person's tree, as
 * a reader resolves it, its version's link table first. A link to any
 * other page, or by another title, or with a folder, is left out, so the
 * server never learns which page that text names, nor a folder's name.
 */
async function wikilinkTargets(
  ctx: ClientContext,
  page: PageRef,
  payload: PagePayload,
  loadSpace: () => ReturnType<typeof loadTree>,
): Promise<{ key: string; pageId: PageId }[]> {
  const links = findWikilinks(payload.markdown).filter((link) => !link.embed && link.target);
  if (links.length === 0) return [];
  const linked = new Set((await list(ctx, page.spaceId)).map((link) => link.pageId));
  const tree = await loadSpace();
  // The published title of each page with a link on: only those can be targets.
  const published = new Map<string, string>();
  for (const summary of tree.pages) {
    if (!linked.has(summary.id) || !summary.publishedHead) continue;
    const head = summary.publishedHead;
    const target = { spaceId: page.spaceId, pageId: summary.id };
    try {
      const version = (await openRevisions(ctx, target, 'published', [head])).get(head)?.opened;
      if (version?.kind === 'current') published.set(summary.id, version.payload.title);
    } catch (error) {
      // A page whose version can't be fetched is no target.
      if (!(error instanceof ApiError)) throw error;
    }
  }
  // Every other page counts by the title this person sees, so a title two
  // pages share resolves to neither, as it would for some reader.
  const pages = linkablePages(tree).map((linkable) => ({
    ...linkable,
    title: published.get(linkable.id) ?? linkable.title,
  }));
  const resolved = resolveLinked(links, {
    pages,
    selfId: page.pageId,
    table: linkTableOf(payload),
  });
  const targets = new Map<string, PageId>();
  for (const link of resolved) {
    const [pageId] = link.targets;
    const title = pageId === undefined ? undefined : published.get(pageId);
    if (link.status !== 'resolved' || title === undefined) continue;
    const key = linkKey(link);
    if (foldTitle(title) === key) targets.set(key, PageIdSchema.parse(pageId));
  }
  return [...targets].map(([key, pageId]) => ({ key, pageId }));
}

/**
 * Upload a readable copy of the page's published version and make it the
 * one its public link shows (ADR 0005, decision 5), while its link is on:
 * staged with its title, its Markdown without the frontmatter, the
 * attachments its body shows or links to and the wikilink targets that may
 * lead to other public pages (`wikilinkTargets`), then each file the server
 * asks for, of those only, then committed. Pass `published`, the version
 * just published and its decrypted payload, right after publishing it;
 * otherwise the published head the server names is opened, as a reader
 * opens it.
 */
export async function shareCopy(
  ctx: ClientContext,
  page: PageRef,
  { published }: { published?: { revisionId: RevisionId; payload: PagePayload } } = {},
) {
  const version = published ?? (await openPublished(ctx, page));
  const { payload, revisionId } = version;
  const { body } = splitFrontmatter(payload.markdown);
  // The space's tree, loaded once, if anything needs it.
  let loading: ReturnType<typeof loadTree> | undefined;
  const tree = () => (loading ??= loadTree(ctx, page.spaceId));
  const others = await otherValues(ctx, page, payload, tree);
  const targets = await wikilinkTargets(ctx, page, payload, tree);
  const listed = await queryTables(ctx, page, payload, tree, {
    keys: new Set(
      findWikilinks(payload.markdown)
        .filter((link) => !link.embed)
        .map(linkKey),
    ),
    targets: new Map(targets.map(({ key, pageId }) => [key, pageId])),
  });
  // Tables too large for a copy stay as written, rather than the copy failing to go up.
  const withTables = copyBody(payload.markdown, others, listed.tables);
  const fits = utf8(withTables).length <= pageRoutes.MAX_MARKDOWN_BYTES;
  const markdown = fits ? withTables : copyBody(payload.markdown, others);
  const tableTargets = fits ? listed.targets : [];
  const attachments = attachmentsUsed(body, payload.attachments);
  // Every file the copy should keep is opened before anything readable
  // goes up, so one that doesn't open sends nothing. Those left out for
  // size, as the server leaves them out, aren't opened yet.
  const kept = chooseFiles(
    attachments.map((ref) => ref.id),
    attachments,
    { fileBytes: publicLinkRoutes.MAX_FILE_BYTES, copyBytes: publicLinkRoutes.MAX_COPY_BYTES },
  );
  const bytesOf = new Map<string, Uint8Array>();
  for (const ref of attachments) {
    if (kept.some((file) => file.id === ref.id && !file.leftOut)) {
      bytesOf.set(ref.id, await readAttachment(ctx, page, 'published', ref));
    }
  }
  const { copyId, files } = await ctx.api.call(publicLinkRoutes.stage, {
    params: { pageId: page.pageId },
    body: {
      revisionId,
      title: payload.title,
      markdown,
      attachments: attachments.map(({ id, name, mediaType, size }) => ({
        id,
        name,
        mediaType,
        size,
      })),
      targets: [...targets, ...tableTargets],
    },
  });
  // Whatever the server asks for, only the files on this app's list go. One
  // it asks for that this app left out for size (its limits can be lower,
  // which keeps others) is opened now.
  const ours = new Map<string, (typeof attachments)[number]>(
    attachments.map((ref) => [ref.id, ref]),
  );
  for (const id of files) {
    const ref = ours.get(id);
    if (!ref) continue;
    const bytes = bytesOf.get(id) ?? (await readAttachment(ctx, page, 'published', ref));
    const path = publicLinkRoutes.FILE_UPLOAD_PATH.replace(
      ':copyId',
      encodeURIComponent(copyId),
    ).replace(':attachmentId', encodeURIComponent(id));
    await ctx.api.upload(path, bytes, publicLinkRoutes.FileUploadResult);
  }
  await ctx.api.call(publicLinkRoutes.commit, { params: { copyId } });
  return { copyId };
}

/**
 * The page's published head, as the server names it, opened as a reader
 * opens it. Sends nothing readable, so the app can open it before turning
 * a link on and know it can share it.
 */
export async function openPublished(ctx: ClientContext, page: PageRef) {
  const { publishedHead } = (await loadPage(ctx, page.pageId)).heads;
  if (!publishedHead) throw new ApiError(404, 'not-found', 'The page isn’t published');
  const { opened } = await openRevisionOf(ctx, page, 'published', publishedHead);
  if (opened.kind !== 'current') {
    throw new CryptoError('unsupported-format', 'A newer app published this page');
  }
  return { revisionId: publishedHead, payload: opened.payload };
}
