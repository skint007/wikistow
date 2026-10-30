// Publishing chosen versions of a page into a page in another space
// (protocol section 13). The publisher's app opens the source version,
// copies its text and the attachments the person chose into a payload for
// the destination, each attachment under a fresh key, and seals it there as
// a published version, wrapped only with the destination's published key
// or sealed to its owners. Which page it came from is written only inside
// that encrypted payload.
import {
  publicationRoutes,
  type Audience,
  type FolderId,
  type IdentityId,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { coverLeftBehind, reviseCover } from '../cover.ts';
import { hash, Hash32 } from '../encoding.ts';
import { CryptoError } from '../errors.ts';
import {
  newId,
  PageId as PageIdSchema,
  RevisionId as RevisionIdSchema,
  SpaceId as SpaceIdSchema,
} from '../ids.ts';
import { repairText } from '../json.ts';
import { LINKS_NAMESPACE } from '../link-table.ts';
import { findLinks, foldTitle, type FoundLinks } from '../links.ts';
import {
  checkPayloadSize,
  newPayload,
  revisePayload,
  type AttachmentRef,
  type PagePayload,
} from '../payload.ts';
import { writeRegion, type Region } from '../regions.ts';
import { resealAttachment, revisionRecordBytes, revisionRecordV2Bytes } from '../revision.ts';
import { spaceKeys } from './keys.ts';
import { audienceOf, type Reach } from './moves.ts';
import {
  attachmentTarget,
  commitFor,
  cacheWritten,
  downloadBlob,
  loadHistory,
  loadPage,
  openRevisionOf,
  uploadBlob,
  type OpenedRevision,
  type PageRef,
} from './pages.ts';
import { newNodeTarget, treeTarget, withFreshKeys } from './records.ts';
import { nameOf, unreachable } from './search.ts';
import type { ClientContext } from './session.ts';
import { loadStructure } from './spaces.ts';

/** The extension namespace a copy names its source in (section 13). */
export const PUBLICATION_NAMESPACE = 'wikistow.publication';

/**
 * Where a published copy came from, as its publisher's app wrote it inside
 * the encrypted payload. Readers of the copy can't check it against the
 * source, so it is a label, never a link (section 13).
 */
export const Provenance = z.looseObject({
  format: z.literal(1),
  sourceSpaceId: SpaceIdSchema,
  sourcePageId: PageIdSchema,
  sourceRevisionId: RevisionIdSchema,
  sourceAudience: z.enum(['draft', 'published']),
  sourceRecordHash: Hash32,
});
export type Provenance = z.infer<typeof Provenance>;

/** A payload's provenance, or null when it is no copy, or names its source in a shape this app doesn't know. */
export function provenanceOf(payload: PagePayload): Provenance | null {
  const parsed = Provenance.safeParse(payload.extensions[PUBLICATION_NAMESPACE]);
  return parsed.success ? parsed.data : null;
}

/**
 * Who can read the copy at the destination: in the owner region, the
 * space's sealing owners; in a share, everyone whose envelopes of its
 * current version this app verified, with how much they hold, which only an
 * owner's app can see (`complete`). Anyone else's app sees just the owners
 * and itself, and says the share has others; an agent's, nobody. Either
 * way it is at least these people: a server can hide envelopes (section 10).
 */
export type DestinationAudience = {
  region: 'owner' | 'share';
  people: { identityId: IdentityId; reach: Reach }[];
  complete: boolean;
};

/**
 * A page the copy links to that readers at the destination may not be able
 * to open, listed once however many links (`count`) point at it. `page`
 * names it among links of its kind: a wikilink's target as titles match, a
 * page link's space and page ID, or a folder link's space and folder ID (a
 * move's copy, `copyOperations.previewCopy`, alone lists those).
 */
export type ClosedLink = {
  kind: 'wikilink' | 'page-link' | 'folder-link';
  page: string;
  text: string;
  count: number;
};

/** A publication worked out for the person to confirm. Nothing is sealed or sent yet. */
export type PublicationPreview = {
  source: PageRef;
  sourceRevisionId: RevisionId;
  sourceAudience: Audience;
  /** The source version as this app opened and checked it. */
  opened: OpenedRevision;
  title: string;
  /** Every attachment the version lists; the person picks which go. */
  attachments: AttachmentRef[];
  /** Null when the Markdown couldn't be read for links (nested thousands deep, say). */
  links: ClosedLink[] | null;
  destination: {
    spaceId: SpaceId;
    pageId: PageId;
    parentId: FolderId | null;
    /**
     * `new`: no publication there yet, or only one opened in another folder
     * whose first version never arrived, which this replaces; `pending`:
     * one opened in the chosen folder whose first version never arrived;
     * `existing`: the next version of a page already published there,
     * which stays where it is.
     */
    state: 'new' | 'pending' | 'existing';
    publishedHead: RevisionId | null;
    /** The permission version the first request carries: the parent's for a new page, else the page's. */
    permissionVersion: number;
    region: Region;
  };
  audience: DestinationAudience;
};

/**
 * The page is already published into that space, at a page this person
 * can't publish at. It goes there again only once that publication ends
 * (`endPublication`), which leaves the copy there as a page of its own.
 */
export class PublishedElsewhere extends Error {
  constructor() {
    super('This page is already published into that space, somewhere you can’t publish');
    this.name = 'PublishedElsewhere';
  }
}

/**
 * Work out publishing the version `revisionId` (of `audience`) of `source`
 * into `spaceId`, as a new page under `parentId` there, or as the next
 * version of the page it was published to before, wherever that is now.
 * Opens and checks the source version, so it needs a key for it, and only
 * someone who can publish the source may (the server refuses anyone else,
 * `forbidden`). Refuses the source's own space (`forbidden`), a version in
 * a format newer than this app's (`unsupported-format`), a destination
 * whose region this app's records and the server's tree disagree on
 * (`region-mismatch`), a page there the server names as its copy whose
 * latest version doesn't name this page as its source (`binding-mismatch`),
 * and a space the page is already published into somewhere this person
 * can't publish (`PublishedElsewhere`). Its links are read with `read`, by
 * default here (`findLinks`); the web app reads them in a worker with a
 * time limit. If that fails, the preview says they couldn't be read.
 */
export async function previewPublication(
  ctx: ClientContext,
  {
    source,
    revisionId,
    audience,
    spaceId,
    parentId,
    read = async (markdown) => findLinks(markdown),
  }: {
    source: PageRef;
    revisionId: RevisionId;
    audience: Audience;
    spaceId: SpaceId;
    parentId: FolderId | null;
    read?: (markdown: string) => Promise<FoundLinks>;
  },
): Promise<PublicationPreview> {
  if (spaceId === source.spaceId) {
    throw new ApiError(403, 'forbidden', 'A page publishes only into another space');
  }
  const opened = await openRevisionOf(ctx, source, audience, revisionId);
  const payload = revisePayload(opened.opened, {});
  const { publication } = await ctx.api.call(publicationRoutes.lookup, {
    params: { pageId: source.pageId, spaceId },
  });
  const destination = await destinationFor(ctx, { source, spaceId, parentId, publication });
  return {
    source,
    sourceRevisionId: revisionId,
    sourceAudience: audience,
    opened,
    title: payload.title,
    attachments: payload.attachments,
    // Once the rest is worked out, so a refusal leaves no read running.
    links: closedLinks(await read(payload.markdown).catch(() => null), spaceId),
    destination,
    audience: await destinationAudience(ctx, spaceId, destination.region),
  };
}

async function destinationFor(
  ctx: ClientContext,
  {
    source,
    spaceId,
    parentId,
    publication,
  }: {
    source: PageRef;
    spaceId: SpaceId;
    parentId: FolderId | null;
    publication: z.infer<typeof publicationRoutes.Publication> | null;
  },
): Promise<PublicationPreview['destination']> {
  if (publication?.state === 'blocked') throw new PublishedElsewhere();
  if (publication?.state === 'live') {
    const page = { spaceId, pageId: publication.pageId };
    const info = await loadPage(ctx, page.pageId);
    if (info.spaceId !== spaceId) {
      throw new CryptoError('binding-mismatch', 'The server puts that page in another space');
    }
    // Its region is that of its latest publication: it has no draft.
    const latest = info.heads.publishedHead ?? (await loadHistory(ctx, page))[0]?.revisionId;
    if (!latest) throw new ApiError(404, 'not-found', 'That page has no published version');
    const published = await openRevisionOf(ctx, page, 'published', latest, { fresh: true });
    // The server names the page; only the page itself, as its publisher
    // signed it, says it is a copy of this one.
    const copied =
      published.opened.kind === 'current' ? provenanceOf(published.opened.payload) : null;
    if (copied?.sourcePageId !== source.pageId || copied.sourceSpaceId !== source.spaceId) {
      throw new CryptoError(
        'binding-mismatch',
        'The page the server names there isn’t a copy of this one',
      );
    }
    return {
      spaceId,
      pageId: publication.pageId,
      parentId: info.parentId,
      state: 'existing',
      publishedHead: info.heads.publishedHead,
      permissionVersion: info.permissionVersion,
      region: writeRegion({ kind: 'existing-page', draft: null, published: published.region }),
    };
  }
  // One opened and never sent is resumed only in the folder the person
  // chose; anywhere else, opening a new one replaces it.
  if (publication?.state === 'pending' && publication.parentId === parentId) {
    // Nothing sent yet: it takes the region of its folder.
    const target = await newNodeTarget(ctx, spaceId, publication.parentId);
    const at = await treeTarget(ctx, spaceId, publication.pageId);
    return {
      spaceId,
      pageId: publication.pageId,
      parentId: publication.parentId,
      state: 'pending',
      publishedHead: null,
      permissionVersion: at.permissionVersion,
      region: target.region,
    };
  }
  const target = await newNodeTarget(ctx, spaceId, parentId);
  return {
    spaceId,
    pageId: newId(PageIdSchema),
    parentId,
    state: 'new',
    publishedHead: null,
    permissionVersion: target.permissionVersion,
    region: target.region,
  };
}

async function destinationAudience(
  ctx: ClientContext,
  spaceId: SpaceId,
  region: Region,
): Promise<DestinationAudience> {
  // An agent's app works out no owners of its own (section 9.3), so it
  // names nobody.
  if (ctx.agent) return { region: region.kind, people: [], complete: false };
  const keys = await spaceKeys(ctx, spaceId);
  const self = ctx.identity.public;
  const owner = keys.listed.some((o) => o.identity.id === self.id) && keys.owners.opens(self);
  const people = (held: Map<IdentityId, Reach>) =>
    [...held].map(([identityId, reach]) => ({ identityId, reach }));
  if (region.kind === 'owner' || owner) {
    return {
      region: region.kind,
      people: people(await audienceOf(ctx, keys, region)),
      complete: true,
    };
  }
  const held = new Map<IdentityId, Reach>(
    keys.owners.sealingOwners().map((o) => [o.id, 'drafts'] as const),
  );
  held.set(self.id, held.get(self.id) ?? 'drafts');
  return { region: 'share', people: people(held), complete: false };
}

/**
 * Pages readers at the destination may not be able to open, each once,
 * where it is first linked: every page a wikilink names, which is one of
 * the source's space, then every page of a space other than the
 * destination a page link points at. Embeds of the page's own files go
 * with the attachments the person picks, and `[[#Heading]]` is the copy
 * itself.
 */
function closedLinks(links: FoundLinks | null, spaceId: SpaceId): ClosedLink[] | null {
  // Too deeply nested to read, or too slow: the preview says so rather than failing.
  if (!links) return null;
  const found = [
    ...links.wikilinks
      .filter((link) => !link.embed && link.target !== '')
      .map((link) => ({
        kind: 'wikilink' as const,
        page: foldTitle(link.target),
        text: link.target,
      })),
    ...links.pageLinks
      .filter((link) => link.spaceId !== spaceId)
      .map((link) => ({
        kind: 'page-link' as const,
        page: `${link.spaceId}/${link.pageId}`,
        text: link.text || link.source,
      })),
  ];
  const pages = new Map<string, ClosedLink>();
  for (const link of found) {
    const key = `${link.kind} ${link.page}`;
    const seen = pages.get(key);
    if (seen) seen.count += 1;
    else pages.set(key, { ...link, count: 1 });
  }
  return [...pages.values()];
}

/** The hash of a record's own signed bytes, v1 or v2, which a copy names its source by. */
const recordHash = (record: OpenedRevision['record']) =>
  hash(record.protocol === 1 ? revisionRecordBytes(record) : revisionRecordV2Bytes(record));

/**
 * Publish a previewed version the person confirmed, with the attachments
 * they picked (`attachmentIds`; the rest are left out). Opens the
 * publication first if it is new. Each picked attachment is downloaded,
 * opened with the source's key, and sealed again under a fresh key for the
 * destination page, never reused (section 13). The copy goes out as the
 * destination's next published version, with the published key of its
 * share or sealed to its owners: no draft key is ever used. If someone
 * published there since the preview, the server answers `stale-head`; if
 * access there changed, `permission-version`; either way nothing is
 * published, and the person looks again. A request lost on the way can be
 * sent again as it was (its revision ID is its idempotency key). A broken
 * character from a Milestone 1 client is written as U+FFFD, and `repaired`
 * says so.
 */
export async function publishToSpace(
  ctx: ClientContext,
  { preview, attachmentIds }: { preview: PublicationPreview; attachmentIds: ReadonlySet<string> },
): Promise<{ pageId: PageId; revisionId: RevisionId; repaired: boolean }> {
  const generation = ctx.revisions.generation;
  const { source, destination } = preview;
  const page = { spaceId: destination.spaceId, pageId: destination.pageId };
  const { value: original, repaired } = repairText(revisePayload(preview.opened.opened, {}));
  // Before the publication is opened and its attachments copied.
  checkPayloadSize({ markdown: original.markdown });
  if (destination.state === 'new') {
    await ctx.api.call(
      publicationRoutes.open,
      {
        body: {
          sourcePageId: source.pageId,
          destinationSpaceId: page.spaceId,
          pageId: page.pageId,
          parentId: destination.parentId,
          permissionVersion: destination.permissionVersion,
        },
      },
      { idempotencyKey: page.pageId },
    );
  }
  const attachments = [];
  for (const ref of original.attachments) {
    if (!attachmentIds.has(ref.id)) continue;
    const resealed = resealAttachment({
      from: attachmentTarget(ctx, source, preview.sourceAudience),
      to: attachmentTarget(ctx, page, 'published'),
      ref,
      blob: await downloadBlob(ctx, ref.blobHash),
    });
    await uploadBlob(ctx, page, 'published', resealed.blob);
    attachments.push(resealed.ref);
  }
  const provenance = {
    format: 1,
    sourceSpaceId: source.spaceId,
    sourcePageId: source.pageId,
    sourceRevisionId: preview.sourceRevisionId,
    sourceAudience: preview.sourceAudience,
    sourceRecordHash: recordHash(preview.opened.record),
  } satisfies Provenance;
  // A banner image or icon left behind would name an attachment the copy
  // doesn't list, so the copy shows the theme gradient, or no icon, instead.
  const behind = coverLeftBehind(original.extensions, new Set(attachments.map((ref) => ref.id)));
  const cover = Object.keys(behind).length > 0 ? reviseCover(original.extensions, behind) : {};
  // The source's link table names pages of its own space: the copy has
  // none, and its readers resolve its links by title in their own tree.
  const { [LINKS_NAMESPACE]: _links, ...extensions } = original.extensions;
  const payload = newPayload({
    title: original.title,
    markdown: original.markdown,
    extensions: { ...extensions, ...cover, [PUBLICATION_NAMESPACE]: provenance },
    attachments,
  });
  const { revisionId } = await withFreshKeys(ctx, page.spaceId, async (keys) => {
    const target = await treeTarget(ctx, page.spaceId, page.pageId);
    // Under the permission version of the preview, so a change of who has
    // access there since the person looked is refused, not published past.
    const commit = commitFor(ctx, keys, page, {
      audience: 'published',
      basedOn: null,
      payload,
      region: destination.region,
      target: { ...target, permissionVersion: destination.permissionVersion },
    });
    const result = await ctx.api.call(
      publicationRoutes.send,
      {
        params: { pageId: page.pageId },
        body: {
          ...commit,
          sourceRevisionId: preview.sourceRevisionId,
          expectedPublishedHead: destination.publishedHead,
        },
      },
      { idempotencyKey: commit.revision.record.revisionId },
    );
    cacheWritten(ctx, commit, payload, generation);
    return result;
  });
  return { pageId: page.pageId, revisionId, repaired };
}

/**
 * Make a page published from another page independent (section 13): its
 * first draft is its latest publication, with the source's name and any
 * link table taken out and its attachments sealed again for drafts. From then on it is edited
 * here, and the source's publisher can no longer send it versions. Needs
 * publish rights on the page. A broken character from a Milestone 1 client
 * is written as U+FFFD, and `repaired` says so.
 */
export async function detachPublication(
  ctx: ClientContext,
  page: PageRef,
): Promise<{ revisionId: RevisionId; repaired: boolean }> {
  const generation = ctx.revisions.generation;
  const info = await loadPage(ctx, page.pageId);
  if (info.heads.draftHead) {
    throw new ApiError(409, 'stale-head', 'This page has a draft already', info.heads);
  }
  const latest = info.heads.publishedHead ?? (await loadHistory(ctx, page))[0]?.revisionId;
  if (!latest) throw new ApiError(404, 'not-found', 'This page has no published version');
  const published = await openRevisionOf(ctx, page, 'published', latest, { fresh: true });
  const { value: payload, repaired } = repairText(revisePayload(published.opened, {}));
  // Before its attachments are sealed again for drafts.
  checkPayloadSize({ markdown: payload.markdown });
  // A copy made before copies left out the source's link table may hold one.
  const {
    [PUBLICATION_NAMESPACE]: _source,
    [LINKS_NAMESPACE]: _links,
    ...extensions
  } = payload.extensions;
  const attachments = [];
  for (const ref of payload.attachments) {
    const resealed = resealAttachment({
      from: attachmentTarget(ctx, page, 'published'),
      to: attachmentTarget(ctx, page, 'draft'),
      ref,
      blob: await downloadBlob(ctx, ref.blobHash),
    });
    await uploadBlob(ctx, page, 'draft', resealed.blob);
    attachments.push(resealed.ref);
  }
  const draft = { ...payload, extensions, attachments };
  const region = writeRegion({ kind: 'existing-page', draft: null, published: published.region });
  const { revisionId } = await withFreshKeys(ctx, page.spaceId, async (keys) => {
    const target = await treeTarget(ctx, page.spaceId, page.pageId);
    const commit = commitFor(ctx, keys, page, {
      audience: 'draft',
      basedOn: null,
      payload: draft,
      region,
      target,
    });
    const result = await ctx.api.call(
      publicationRoutes.detach,
      { params: { pageId: page.pageId }, body: commit },
      { idempotencyKey: commit.revision.record.revisionId },
    );
    cacheWritten(ctx, commit, draft, generation);
    return result;
  });
  return { revisionId, repaired };
}

/**
 * End the publication of `source` in `spaceId`, for someone who can publish
 * the source, wherever its copy is there: the copy stays as a page of its
 * own, which its publishers there detach to edit, and the next publication
 * of the source there makes a new page. Whether there was one to end.
 */
export async function endPublication(
  ctx: ClientContext,
  { source, spaceId }: { source: PageRef; spaceId: SpaceId },
): Promise<boolean> {
  const { ended } = await ctx.api.call(publicationRoutes.end, {
    params: { pageId: source.pageId, spaceId },
  });
  return ended;
}

/**
 * One of a page's live copies in another space, named as far as this
 * person's app can read: the space's name, and for a copy they can publish
 * at, the names of the folders down to it, outermost first, from the top
 * of the space or of the share they are in (for an agent, its pick). A
 * name it can't open is null.
 * A `pending` copy was opened and never got a version, so nobody sees it;
 * of a `blocked` one, somewhere they can't publish, they learn only the
 * space (section 13).
 */
export type PublishedCopy = {
  spaceId: SpaceId;
  spaceName: string | null;
  copy:
    | { state: 'live' | 'pending'; pageId: PageId; path: (string | null)[] }
    | { state: 'blocked' };
};

/**
 * Where `source` is published in other spaces (`PublishedCopy`), for
 * someone who can publish it; the server refuses anyone else (`forbidden`).
 * Each one ends with `endPublication`. Which page is the copy is the
 * server's word: this only shows it, and publishing there checks it.
 */
export async function publishedCopies(
  ctx: ClientContext,
  source: PageRef,
): Promise<PublishedCopy[]> {
  const { publications } = await ctx.api.call(publicationRoutes.list, {
    params: { pageId: source.pageId },
  });
  return Promise.all(
    publications.map(async (listed): Promise<PublishedCopy> => {
      const structure = await loadStructure(ctx, listed.spaceId).catch((error: unknown) => {
        // A space they can't open, or whose names don't check, is named as unreadable.
        if (unreachable(error) || error instanceof CryptoError) return null;
        throw error;
      });
      const spaceName = nameOf(structure?.space?.metadata ?? null);
      if (listed.state === 'blocked') {
        return { spaceId: listed.spaceId, spaceName, copy: { state: 'blocked' } };
      }
      const folders = new Map(structure?.folders.map((f) => [f.id as string, f]));
      const path: (string | null)[] = [];
      for (let at = listed.parentId; at !== null && path.length < folders.size;) {
        const folder = folders.get(at);
        if (!folder) break;
        path.unshift(nameOf(folder.metadata));
        at = folder.parentId;
      }
      // A folder the tree doesn't list is one they can't read.
      if (listed.parentId !== null && path.length === 0) path.push(null);
      return {
        spaceId: listed.spaceId,
        spaceName,
        copy: { state: listed.state, pageId: listed.pageId, path },
      };
    }),
  );
}

/**
 * The source page's title, for the "Published from" label, once this
 * person's app has checked the copy's claim: the source version it names
 * opens for them, its signed record hashes to `sourceRecordHash`, and its
 * title and text are the copy's. Then the source's current title: its
 * draft's for an editor, its publication's for a reader. Null when they
 * can't read that version, or anything doesn't match, since anyone who
 * publishes at the copy could have written any source into it.
 */
export async function sourceTitle(
  ctx: ClientContext,
  { provenance, copy }: { provenance: Provenance; copy: PagePayload },
): Promise<string | null> {
  const source = { spaceId: provenance.sourceSpaceId, pageId: provenance.sourcePageId };
  try {
    const info = await loadPage(ctx, source.pageId);
    if (info.spaceId !== source.spaceId) return null;
    const claimed = await openRevisionOf(
      ctx,
      source,
      provenance.sourceAudience,
      provenance.sourceRevisionId,
    );
    if (
      recordHash(claimed.record) !== provenance.sourceRecordHash ||
      claimed.opened.kind !== 'current'
    ) {
      return null;
    }
    // The copy holds the source's text with any broken character repaired (`publishToSpace`).
    const { title, markdown } = claimed.opened.payload;
    const { value: sent } = repairText({ title, markdown });
    if (sent.title !== copy.title || sent.markdown !== copy.markdown) return null;
    const [head, audience] = info.heads.draftHead
      ? [info.heads.draftHead, 'draft' as const]
      : [info.heads.publishedHead, 'published' as const];
    if (!head) return null;
    const { opened } = await openRevisionOf(ctx, source, audience, head);
    return opened.kind === 'current' ? opened.payload.title : null;
  } catch (error) {
    if (error instanceof ApiError || error instanceof CryptoError) return null;
    throw error;
  }
}
