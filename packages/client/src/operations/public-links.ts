// Public links (ADR 0005): a readable copy of a page's published version,
// which the server renders and serves at `/p/<id>`. Each call here sends
// plaintext to the server, so the app makes one only after saying so on
// screen: from the public link dialog, or a Publish that asked first.
import { publicLinkRoutes, type PageId, type RevisionId, type SpaceId } from '@wikistow/contracts';
import { ApiError } from '../api/client.ts';
import { CryptoError } from '../errors.ts';
import { PageId as PageIdSchema } from '../ids.ts';
import { linkKey, linkTableOf, resolveLinked } from '../link-table.ts';
import { findWikilinks, foldTitle, linkablePages } from '../links.ts';
import { splitFrontmatter } from '../markdown/index.ts';
import type { PagePayload } from '../payload.ts';
import { attachmentsShown, bodyHtml, embedHtml } from '../reader/body-html.ts';
import { readBody } from '../reader/reading.ts';
import { loadPage, openRevisionOf, openRevisions, readAttachment, type PageRef } from './pages.ts';
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

/** A page body's attachments it shows or links to, as the server's reader finds them. */
export function attachmentsUsed(body: string, attachments: PagePayload['attachments']) {
  const tree = bodyHtml(readBody(body), (link) =>
    // An embed the reader can't show stays text, as the server renders it.
    link.unsupported
      ? { type: 'text', value: link.source }
      : link.embed
        ? embedHtml(link, attachments)
        : { type: 'text', value: link.value },
  );
  const used = new Set(attachmentsShown(tree));
  return attachments.filter((ref) => used.has(ref.id));
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
): Promise<{ key: string; pageId: PageId }[]> {
  const links = findWikilinks(payload.markdown).filter((link) => !link.embed && link.target);
  if (links.length === 0) return [];
  const linked = new Set((await list(ctx, page.spaceId)).map((link) => link.pageId));
  const tree = await loadTree(ctx, page.spaceId);
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
  const attachments = attachmentsUsed(body, payload.attachments);
  const { copyId, files } = await ctx.api.call(publicLinkRoutes.stage, {
    params: { pageId: page.pageId },
    body: {
      revisionId,
      title: payload.title,
      markdown: body,
      attachments: attachments.map(({ id, name, mediaType, size }) => ({
        id,
        name,
        mediaType,
        size,
      })),
      targets: await wikilinkTargets(ctx, page, payload),
    },
  });
  // Whatever the server asks for, only the files this app chose go.
  const ours = new Map(attachments.map((ref) => [ref.id, ref]));
  for (const id of files) {
    const ref = ours.get(id);
    if (!ref) continue;
    const bytes = await readAttachment(ctx, page, 'published', ref);
    const path = publicLinkRoutes.FILE_UPLOAD_PATH.replace(
      ':copyId',
      encodeURIComponent(copyId),
    ).replace(':attachmentId', encodeURIComponent(id));
    await ctx.api.upload(path, bytes, publicLinkRoutes.FileUploadResult);
  }
  await ctx.api.call(publicLinkRoutes.commit, { params: { copyId } });
  return { copyId };
}

// The page's published head, as the server names it, opened as a reader opens it.
async function openPublished(ctx: ClientContext, page: PageRef) {
  const { publishedHead } = (await loadPage(ctx, page.pageId)).heads;
  if (!publishedHead) throw new ApiError(404, 'not-found', 'The page isn’t published');
  const { opened } = await openRevisionOf(ctx, page, 'published', publishedHead);
  if (opened.kind !== 'current') {
    throw new CryptoError('unsupported-format', 'A newer app published this page');
  }
  return { revisionId: publishedHead, payload: opened.payload };
}
