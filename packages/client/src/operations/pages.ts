import {
  pageRoutes,
  structureRoutes,
  type Audience,
  type FolderId,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import type { z } from 'zod';
import { ApiError } from '../api/client.ts';
import { CHANGE_NAMESPACE, changeOf, withoutChange, type ChangeSummary } from '../change.ts';
import { COVER_NAMESPACE, coverLeftBehind, coverOf, reviseCover } from '../cover.ts';
import { CryptoError } from '../errors.ts';
import { setPageProperty, type PropertyValue } from '../markdown/properties.ts';
import { newId, PageId as PageIdSchema, RevisionId as RevisionIdSchema } from '../ids.ts';
import { agentIdentityId } from '../identity.ts';
import { repairText } from '../json.ts';
import {
  LINKS_NAMESPACE,
  linkTableOf,
  withoutLinkTable,
  writeLinks,
  type LinkTree,
  type LinkWrite,
  type OpenedPublication,
  type ReadWikilinks,
  type RenamedLink,
} from '../link-table.ts';
import {
  checkPayloadSize,
  newPayload,
  revisePayload,
  type AttachmentRef,
  type PagePayload,
  type PayloadChanges,
} from '../payload.ts';
import { OWNER_REGION, sameRegion, writeRegion, type Region } from '../regions.ts';
import {
  openAttachment,
  resealAttachment,
  sealAttachment,
  sealRevisionV2,
  verifyRevisionRecord,
  verifyRevisionRecordV2,
  type AttachmentTarget,
} from '../revision.ts';
import { pinAuthors, spaceKeys, type SpaceKeys } from './keys.ts';
import {
  keysFor,
  keyTargetFor,
  newNodeTarget,
  openServedRevision,
  treeTarget,
  withFreshKeys,
  type OpenedRevision,
} from './records.ts';
import type { ClientContext } from './session.ts';
import { loadTree } from './spaces.ts';

type PageSummary = z.output<typeof structureRoutes.PageSummary>;

/** Which page an operation is about. Every revision is checked against it. */
export type PageRef = { spaceId: SpaceId; pageId: PageId };

export type { OpenedRevision };

/**
 * A version just written, and the payload it holds. `repaired` is true
 * when it carried text from a Milestone 1 client with a broken character,
 * written as U+FFFD instead (`repairText`): the app can say "A broken
 * character was replaced". Its Markdown may differ from what was asked for
 * where a link now names its page's published title (`writeLinks`):
 * `renamed` lists those. `inUse` is `payload` with only the table entries
 * its links use, which an editor's next save builds on (`linksInUse`).
 * `linksKept` is true when the links weren't worked out again, as the
 * space's tree couldn't be loaded or the links couldn't be read: the table
 * was carried as it was (`writeLinks`), and no link renamed.
 */
export type Written = {
  revisionId: RevisionId;
  repaired: boolean;
  region: Region;
  payload: PagePayload;
  inUse: PagePayload;
  renamed: RenamedLink[];
  linksKept: boolean;
};

// A tree listing no page: every entry counts as one whose page the writer doesn't see.
const NO_PAGES: LinkTree = { shares: [], folders: [], pages: [] };

/**
 * The tree a write's link table is worked out from: `tree` if the caller
 * has one, else loaded once, only if the table needs it.
 */
function linkTreeFor(
  ctx: ClientContext,
  spaceId: SpaceId,
  tree?: LinkTree,
): () => Promise<LinkTree> {
  let loading: Promise<LinkTree> | undefined;
  return () => (loading ??= tree ? Promise.resolve(tree) : loadTree(ctx, spaceId));
}

export const attachmentTarget = (
  ctx: ClientContext,
  { spaceId, pageId }: PageRef,
  audience: Audience,
): AttachmentTarget => ({ installationId: ctx.installationId, spaceId, pageId, audience });

/**
 * Seal `payload` as the next version, in `region`, and the commit fields
 * every write route takes. Where the server says the page is (`share`) must
 * be that region: a wrap under the share's key version that counts for
 * writing, or envelopes to the space's sealing owners (section 6.8). A
 * payload larger than a version may hold is refused (`PageTooLarge`). The
 * version's ID is new, or `revisionId` for a payload that names it.
 */
export function commitFor(
  ctx: ClientContext,
  keys: SpaceKeys,
  page: PageRef,
  {
    audience,
    basedOn,
    payload,
    region,
    target,
    revisionId = newId(RevisionIdSchema),
  }: {
    audience: Audience;
    basedOn: RevisionId | null;
    payload: PagePayload;
    region: Region;
    target: Awaited<ReturnType<typeof treeTarget>>;
    revisionId?: RevisionId;
  },
) {
  checkPayloadSize(payload);
  const { revision, envelopes, wrap } = sealRevisionV2({
    author: ctx.identity,
    target: {
      installationId: ctx.installationId,
      ...page,
      revisionId,
      audience,
      basedOn,
    },
    payload,
    ...keyTargetFor(ctx, keys, region, target.share),
  });
  return {
    revision,
    envelopes,
    wrap,
    blobRefs: payload.attachments.map((ref) => ref.blobHash),
    permissionVersion: target.permissionVersion,
  };
}

/** Seed only a confirmed write, using the exact payload and key material sealed in its commit. */
export function cacheWritten(
  ctx: ClientContext,
  commit: ReturnType<typeof commitFor>,
  payload: PagePayload,
  generation: number,
): void {
  const { record } = commit.revision;
  ctx.revisions.put(
    {
      record,
      opened: { kind: 'current', payload },
      region: commit.wrap
        ? { kind: 'share', spaceId: record.spaceId, shareId: commit.wrap.shareId }
        : OWNER_REGION,
      keyVersion: commit.wrap?.keyVersion ?? null,
    },
    generation,
  );
}

/**
 * Seal and send a write of `page` in `region` with the space's keys, and
 * once more with fresh ones if the server's key version or owners moved on
 * (`withFreshKeys`). Attachments are already uploaded, so only the record is
 * sealed again.
 */
const writePage = <T>(
  ctx: ClientContext,
  page: PageRef,
  write: (keys: SpaceKeys, target: Awaited<ReturnType<typeof treeTarget>>) => Promise<T>,
) =>
  withFreshKeys(ctx, page.spaceId, async (keys) =>
    write(keys, await treeTarget(ctx, page.spaceId, page.pageId)),
  );

/**
 * A new page with its first draft, at the space root or inside a folder,
 * with a link table worked out from `tree`, the space as the caller sees
 * it, or loaded if its links need one.
 */
export async function createPage(
  ctx: ClientContext,
  {
    spaceId,
    parentId,
    title,
    markdown = '',
    extensions = {},
    tree,
  }: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    title: string;
    markdown?: string;
    extensions?: PagePayload['extensions'];
    tree?: LinkTree;
  },
): Promise<PageId> {
  const pageId = newId(PageIdSchema);
  const linkTree = linkTreeFor(ctx, spaceId, tree);
  // Before reading its links, which takes longest on a page too large to save.
  const content = newPayload({ title, markdown, extensions });
  checkPayloadSize(content);
  await withFreshKeys(ctx, spaceId, async (keys) => {
    const target = await newNodeTarget(ctx, spaceId, parentId);
    const { payload } = await writeLinks(content, {
      page: { id: pageId, parentId },
      audience: 'draft',
      region: target.region,
      tree: linkTree,
      published: publicationsFor(ctx, spaceId),
    });
    const commit = commitFor(
      ctx,
      keys,
      { spaceId, pageId },
      {
        audience: 'draft',
        basedOn: null,
        payload,
        region: target.region,
        target,
      },
    );
    await ctx.api.call(pageRoutes.createPage, {
      params: { spaceId },
      body: { pageId, parentId, ...commit },
    });
  });
  return pageId;
}

/**
 * A new page made from `template`, the version of a template page this
 * person sees (`shownVersions`), with its `title` and `markdown` already
 * filled in (`fillTemplate`). It takes the template's cover and its
 * attachments, encrypted again for the new page's draft. Uploading needs
 * the page, so one with attachments is made first without them, and with
 * no image banner or icon, then saved again with them. Its link table
 * comes too, so a link to a page renamed since the template was saved
 * still names it: `writeLinks` keeps an entry only for a page this person
 * sees and everyone who opens the new page can open. The template's other
 * extensions, such as where a published copy came from, stay behind.
 */
export async function createFromTemplate(
  ctx: ClientContext,
  {
    spaceId,
    parentId,
    template,
    title,
    markdown,
  }: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    template: OpenedRevision;
    title: string;
    markdown: string;
  },
): Promise<PageId> {
  const source = current(template);
  const { [COVER_NAMESPACE]: cover, [LINKS_NAMESPACE]: links } = source.extensions;
  const covered = cover === undefined ? {} : { [COVER_NAMESPACE]: cover };
  const linked = links === undefined ? {} : { [LINKS_NAMESPACE]: links };
  const made = (extensions: PagePayload['extensions']) =>
    createPage(ctx, {
      spaceId,
      parentId,
      title,
      markdown,
      extensions: { ...linked, ...extensions },
    });
  if (source.attachments.length === 0) return made(covered);
  const pageId = await made(
    cover === undefined ? {} : reviseCover(covered, coverLeftBehind(covered, new Set())),
  );
  const page = { spaceId, pageId };
  const { record } = template;
  const from = attachmentTarget(ctx, record, record.audience);
  const attachments = [];
  for (const ref of source.attachments) {
    const resealed = resealAttachment({
      from,
      to: attachmentTarget(ctx, page, 'draft'),
      ref,
      blob: await downloadBlob(ctx, ref.blobHash),
    });
    await uploadBlob(ctx, page, 'draft', resealed.blob);
    attachments.push(resealed.ref);
  }
  await editDraft(ctx, page, { attachments, extensions: covered });
  return pageId;
}

export const loadPage = (ctx: ClientContext, pageId: PageId) =>
  ctx.api.call(pageRoutes.getPage, { params: { pageId } });

/**
 * Published versions of a page, newest first. Each is checked against its
 * signed record, so the server can't credit a version to someone who didn't
 * publish it or list another page's. The publisher's name is the server's
 * account name for that identity; only the identity is signed. An agent's
 * `personId` is kept only if the agent's pinned keys make its ID with that
 * person as owner, so the server can't say it published for someone else;
 * otherwise it is null.
 */
export async function loadHistory(ctx: ClientContext, page: PageRef) {
  const { versions } = await ctx.api.call(pageRoutes.history, {
    params: { pageId: page.pageId },
  });
  await pinAuthors(
    ctx,
    versions.map(({ record }) => record),
  );
  const keys = await spaceKeys(ctx, page.spaceId);
  return versions.map(({ record, signature, ...version }) => {
    const args = {
      trust: ctx.trust,
      signed: { record, signature },
      expect: {
        installationId: ctx.installationId,
        ...page,
        revisionId: version.revisionId,
        audience: 'published' as const,
      },
    };
    // A v1 record counts only from an accepted owner (section 5.7).
    const signed =
      record.protocol === 1
        ? verifyRevisionRecord({ ...args, owners: keys.owners.opens })
        : verifyRevisionRecordV2(args);
    // Readers aren't told which draft a version came from.
    const basedOnMatches = version.basedOn === null || version.basedOn === signed.basedOn;
    if (version.publisher.identityId !== signed.authorId || !basedOnMatches) {
      throw new CryptoError('binding-mismatch', 'History does not match the signed version');
    }
    const author = ctx.trust.require(record.authorId, record.authorKeyVersion);
    const { personId } = version.publisher;
    const forPerson =
      personId !== null &&
      author.kind === 'agent' &&
      agentIdentityId({ installationId: ctx.installationId, ownerId: personId, ...author }) ===
        author.id;
    return {
      ...version,
      publisher: { ...version.publisher, personId: forPerson ? personId : null },
    };
  });
}

/**
 * What each of a page's published versions `ids` changed while reading
 * (`changeOf`), or null for one that isn't such a version or doesn't open.
 * Opened through the revision cache, in as few requests as
 * `fetchRevisions` makes.
 */
export async function versionChanges(
  ctx: ClientContext,
  page: PageRef,
  ids: readonly RevisionId[],
): Promise<Map<RevisionId, ChangeSummary | null>> {
  const wanted: Wanted = { pageId: page.pageId, audience: 'published' };
  const fetched = await fetchRevisions(ctx, page.spaceId, new Map(ids.map((id) => [id, wanted])));
  return new Map(
    ids.map((id) => {
      const open = fetched.get(id);
      const version = open && checkedFor(open, { spaceId: page.spaceId, ...wanted });
      return [id, version ? changeOf(version) : null];
    }),
  );
}

const BATCH = 200;
/** Batches asked for at once, so later ones download while earlier ones are opened. */
const IN_FLIGHT = 3;

/** What a fetched revision must be: a version of this page, for this audience. */
export type Wanted = { pageId: PageId; audience: Audience };

/** Open now, but throw only to whoever asks for this one. */
function openedNow(open: () => OpenedRevision): () => OpenedRevision {
  try {
    const opened = open();
    return () => opened;
  } catch (error) {
    return () => {
      throw error;
    };
  }
}

/**
 * Fetch revisions, each checked against what it was asked for, a few
 * batches at a time. Each is opened as its batch arrives, and a failure is
 * thrown only when that one is asked for, so one bad revision needn't hide
 * the others. Answers nobody asked for in that batch are dropped rather
 * than trusted. Ones the server deferred to keep its answer small are asked
 * for again, for as long as each answer brings something new.
 */
export async function fetchRevisions(
  ctx: ClientContext,
  spaceId: SpaceId,
  wanted: ReadonlyMap<RevisionId, Wanted>,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<Map<RevisionId, () => OpenedRevision>> {
  const fetched = new Map<RevisionId, () => OpenedRevision>();
  const generation = ctx.revisions.generation;
  for (const [revisionId, expected] of wanted) {
    const cached = fresh ? undefined : ctx.revisions.get({ spaceId, revisionId, ...expected });
    if (cached) fetched.set(revisionId, () => cached);
  }
  const queue = [...wanted.keys()].filter((id) => !fetched.has(id));
  const requests: {
    asked: ReadonlySet<RevisionId>;
    answer: Promise<z.output<typeof pageRoutes.fetchRevisions.response>>;
  }[] = [];
  const send = () => {
    while (requests.length < IN_FLIGHT && queue.length > 0) {
      const ids = queue.splice(0, BATCH);
      const answer = ctx.api.call(pageRoutes.fetchRevisions, { body: { ids } });
      // A later batch failing while an earlier one is opened is left for its turn.
      answer.catch(() => {});
      requests.push({ asked: new Set(ids), answer });
    }
  };
  send();
  for (let request = requests.shift(); request; request = requests.shift()) {
    const { asked } = request;
    const { revisions, deferred } = await request.answer;
    const before = fetched.size;
    const answered = revisions.filter(({ revision }) => asked.has(revision.record.revisionId));
    await pinAuthors(
      ctx,
      answered.map(({ revision }) => revision.record),
    );
    const keys = await keysFor(
      ctx,
      spaceId,
      answered.map(({ wrap, revision }) => ({ wrap, audienceClass: revision.record.audience })),
    );
    for (const served of answered) {
      const revisionId = served.revision.record.revisionId;
      const expected = wanted.get(revisionId);
      if (expected === undefined) continue;
      fetched.set(
        revisionId,
        openedNow(() => {
          const opened = openServedRevision(ctx, keys, served, {
            installationId: ctx.installationId,
            spaceId,
            revisionId,
            ...expected,
          });
          ctx.revisions.put(opened, generation);
          return opened;
        }),
      );
    }
    if (fetched.size > before) {
      queue.unshift(...new Set(deferred.filter((id) => asked.has(id) && !fetched.has(id))));
    }
    send();
  }
  return fetched;
}

/**
 * Fetch and open revisions of one page and audience, so a server can't pass
 * a draft off as a publication. Unavailable uncached versions are absent.
 * Pass `fresh` when using a region or keyVersion for a write: wraps can change.
 */
export async function openRevisions(
  ctx: ClientContext,
  page: PageRef,
  audience: Audience,
  ids: readonly RevisionId[],
  options: { fresh?: boolean } = {},
): Promise<Map<RevisionId, OpenedRevision>> {
  const fetched = await fetchRevisions(
    ctx,
    page.spaceId,
    new Map(ids.map((id) => [id, { pageId: page.pageId, audience }])),
    options,
  );
  return new Map([...fetched].map(([id, open]) => [id, open()]));
}

/**
 * The version of each page this person sees, opened: the draft for editors,
 * the publication for readers, and for a copy of another page unpublished
 * here, which has neither and only editors see, its last publication
 * (section 13). Its region, from its key material, is what `writeLinks`
 * goes by rather than the tree. Null when there is none or it can't be
 * opened. `fresh` opens them again rather than from memory.
 */
export async function shownVersions(
  ctx: ClientContext,
  spaceId: SpaceId,
  pages: readonly PageSummary[],
  options: { fresh?: boolean } = {},
): Promise<Map<PageId, OpenedRevision | null>> {
  const shown = new Map<PageId, RevisionId>();
  for (const page of pages) {
    const head =
      page.draftHead ??
      page.publishedHead ??
      (await lastPublished(ctx, { spaceId, pageId: page.id }));
    if (head) shown.set(page.id, head);
  }
  const heads = new Map<RevisionId, Wanted>();
  for (const page of pages) {
    const head = shown.get(page.id);
    const audience = page.draftHead === null ? 'published' : 'draft';
    if (head) heads.set(head, { pageId: page.id, audience });
  }
  const fetched = await fetchRevisions(ctx, spaceId, heads, options);
  const versions = new Map<PageId, OpenedRevision | null>();
  for (const page of pages) {
    const head = shown.get(page.id);
    const open = head === undefined ? undefined : fetched.get(head);
    versions.set(
      page.id,
      open
        ? checkedFor(open, {
            spaceId,
            pageId: page.id,
            audience: page.draftHead === null ? 'published' : 'draft',
          })
        : null,
    );
  }
  return versions;
}

/**
 * A page's image icon as a list shows it: the attachment the version's
 * cover names, and the audience of that version, to download it from.
 */
export type PageIcon = { ref: AttachmentRef; audience: Audience };

/** The parts of a page's label its cover gives (`PageLabel`), from one version. */
export function labelCover(
  payload: Pick<PagePayload, 'extensions' | 'attachments'>,
  audience: Audience,
): Pick<PageLabel, 'emoji' | 'icon' | 'symbol'> {
  const cover = coverOf(payload);
  const ref = payload.attachments.find((attachment) => attachment.id === cover.icon?.attachmentId);
  return {
    emoji: cover.emoji,
    icon: ref ? { ref, audience } : null,
    symbol: cover.symbol?.name ?? null,
  };
}

/**
 * What a page is listed by: its title, and its emoji, image icon and icon
 * set name (`ShownCover`) if it has them, and the region its version's key material puts it in, which
 * `writeLinks` goes by rather than the tree. All of them come from the one
 * version opened. One in a format this app doesn't know has a region but
 * no title, emoji or icons.
 */
export type PageLabel = {
  title: string | null;
  emoji: string | null;
  icon: PageIcon | null;
  symbol: string | null;
  region: Region;
};

/**
 * Each page's label from the version this person sees (`shownVersions`),
 * or null when none opens. `fresh` opens them again rather than from memory.
 */
export async function pageLabels(
  ctx: ClientContext,
  spaceId: SpaceId,
  pages: readonly PageSummary[],
  options: { fresh?: boolean } = {},
): Promise<Map<PageId, PageLabel | null>> {
  const versions = await shownVersions(ctx, spaceId, pages, options);
  return new Map(
    pages.map((page) => {
      const version = versions.get(page.id);
      if (!version) return [page.id, null];
      const { opened, region } = version;
      const audience = page.draftHead === null ? 'published' : 'draft';
      return [
        page.id,
        opened.kind === 'current'
          ? {
              title: opened.payload.title,
              ...labelCover(opened.payload, audience),
              region,
            }
          : { title: null, emoji: null, icon: null, symbol: null, region },
      ];
    }),
  );
}

/**
 * Each page's current publication as `writeLinks` asks for it, opened
 * through the revision cache, and again fresh if remembered in another
 * region than the page's shown version: from before a share or move. One
 * that doesn't open, or binds another page, is left out, as is every one
 * when they can't be fetched: a link then gets no entry, or keeps its text.
 */
export const publicationsFor =
  (ctx: ClientContext, spaceId: SpaceId): LinkWrite['published'] =>
  async (pages) => {
    const open = async (asked: typeof pages, fresh: boolean) => {
      const wanted = new Map<RevisionId, Wanted>(
        asked.map((page) => [page.publishedHead, { pageId: page.id, audience: 'published' }]),
      );
      const opened = new Map<PageId, OpenedPublication>();
      let fetched: Map<RevisionId, () => OpenedRevision>;
      try {
        fetched = await fetchRevisions(ctx, spaceId, wanted, { fresh });
      } catch (error) {
        if (error instanceof ApiError || error instanceof CryptoError) return opened;
        throw error;
      }
      for (const page of asked) {
        const found = fetched.get(page.publishedHead);
        const checked =
          found && checkedFor(found, { spaceId, pageId: page.id, audience: 'published' });
        const title = checked?.opened.kind === 'current' ? checked.opened.payload.title : null;
        if (checked && title) opened.set(page.id, { title, region: checked.region });
      }
      return opened;
    };
    const opened = await open(pages, false);
    const moved = pages.filter((page) => {
      const found = opened.get(page.id);
      return found !== undefined && !sameRegion(found.region, page.region);
    });
    if (moved.length === 0) return opened;
    const again = await open(moved, true);
    for (const { id } of moved) {
      const found = again.get(id);
      if (found) opened.set(id, found);
      else opened.delete(id);
    }
    return opened;
  };

/**
 * Each page's current publication, opened through the revision cache, in
 * as few requests as `fetchRevisions` makes: those that don't open, are in
 * a newer format, or bind another page are left out, and every one when
 * they can't be fetched, unless `strict`, which throws then instead.
 */
export async function openPublications(
  ctx: ClientContext,
  spaceId: SpaceId,
  pages: readonly { id: PageId; publishedHead: RevisionId }[],
  { strict = false }: { strict?: boolean } = {},
): Promise<Map<PageId, PagePayload>> {
  const opened = new Map<PageId, PagePayload>();
  if (pages.length === 0) return opened;
  const wanted = new Map<RevisionId, Wanted>(
    pages.map((page) => [page.publishedHead, { pageId: page.id, audience: 'published' }]),
  );
  let fetched: Map<RevisionId, () => OpenedRevision>;
  try {
    fetched = await fetchRevisions(ctx, spaceId, wanted);
  } catch (error) {
    if (!strict && (error instanceof ApiError || error instanceof CryptoError)) return opened;
    throw error;
  }
  for (const page of pages) {
    const found = fetched.get(page.publishedHead);
    const checked = found && checkedFor(found, { spaceId, pageId: page.id, audience: 'published' });
    if (checked?.opened.kind === 'current') opened.set(page.id, checked.opened.payload);
  }
  return opened;
}

// The newest version in a page's history, or null when there is none or it doesn't check out.
async function lastPublished(ctx: ClientContext, page: PageRef): Promise<RevisionId | null> {
  try {
    return (await loadHistory(ctx, page))[0]?.revisionId ?? null;
  } catch (error) {
    if (error instanceof ApiError || error instanceof CryptoError) return null;
    throw error;
  }
}

function checkedFor(
  open: () => OpenedRevision,
  wanted: Wanted & { spaceId: SpaceId },
): OpenedRevision | null {
  try {
    const opened = open();
    const { record } = opened;
    // A lying tree may put the same head on two pages; each version still binds its own page.
    if (
      record.spaceId !== wanted.spaceId ||
      record.pageId !== wanted.pageId ||
      record.audience !== wanted.audience
    )
      return null;
    return opened;
  } catch (error) {
    if (error instanceof CryptoError) return null;
    throw error;
  }
}

/** Open immutable content from memory, or fetch fresh when its write region matters. */
export async function openRevisionOf(
  ctx: ClientContext,
  page: PageRef,
  audience: Audience,
  revisionId: RevisionId,
  options: { fresh?: boolean } = {},
): Promise<OpenedRevision> {
  const opened = (await openRevisions(ctx, page, audience, [revisionId], options)).get(revisionId);
  if (!opened) throw new ApiError(404, 'not-found', 'That version is not available');
  return opened;
}

function current(revision: OpenedRevision): PagePayload {
  // revisePayload refuses newer formats with a clear error.
  return revisePayload(revision.opened, {});
}

/**
 * Save `payload` as a new draft on top of `basedOn`, its broken characters
 * repaired and its link table worked out afresh (`writeLinks`) from `tree`,
 * the space as the caller sees it, or loaded if its links need one. The
 * table's entries are carried only if it came from a version in the
 * write's region: `tableRegion`, by default `basedOnRegion` or the region
 * `basedOn` opens in. If the tree is needed and can't be loaded, the draft
 * is still saved, with its table carried and no link renamed (`linksKept`).
 * Its links are read with `read`, by default here (`tableWikilinks`); the
 * web app reads them in a worker with a time limit. If that fails, the
 * draft is saved the same way. It is saved in the region of `basedOn` as
 * this app opens it (section 6.1): pass `basedOnRegion` if it was just
 * opened or written, or it is opened here. A share or move made elsewhere can leave `basedOnRegion` behind; the
 * write is then refused (`region-mismatch`) and tried once more with `basedOn`
 * opened fresh (`baseRegion`). If someone saved since, the server answers
 * `stale-head` and nothing is overwritten. `linkChoices` are the pages the
 * writer picked for ambiguous links, by key (`LinkWrite.chosen`). A draft
 * larger than a version may hold is refused before anything else
 * (`PageTooLarge`). No draft holds what changes made while reading changed
 * (`wikistow.change`), which only their publication says (ADR 0008).
 */
export async function saveDraft(
  ctx: ClientContext,
  {
    page,
    basedOn,
    basedOnRegion,
    payload,
    restoredFrom = null,
    tree,
    tableRegion,
    linkChoices,
    read,
  }: {
    page: PageRef;
    basedOn: RevisionId;
    basedOnRegion?: Region;
    payload: PagePayload;
    restoredFrom?: RevisionId | null;
    tree?: LinkTree;
    tableRegion?: Region;
    linkChoices?: ReadonlyMap<string, PageId>;
    read?: ReadWikilinks;
  },
): Promise<Written> {
  const generation = ctx.revisions.generation;
  const { value: repairedPayload, repaired } = repairText(withoutChange(payload));
  checkPayloadSize(withoutLinkTable(repairedPayload));
  const linkTree = linkTreeFor(ctx, page.spaceId, tree);
  let linksKept = false;
  const treeOrNone = async () => {
    try {
      return await linkTree();
    } catch (error) {
      if (!(error instanceof ApiError || error instanceof CryptoError)) throw error;
      linksKept = true;
      return NO_PAGES;
    }
  };
  // After a share or move, the region given is still the one the table came from.
  const tableFrom = tableRegion ?? basedOnRegion;
  const save = async (basedOnRegion: Region): Promise<Written> => {
    const region = writeRegion({ kind: 'based-on', basedOn: basedOnRegion });
    const {
      payload: linked,
      inUse,
      renamed,
      kept,
    } = await writeLinks(repairedPayload, {
      page: { id: page.pageId },
      audience: 'draft',
      region,
      tableRegion: tableFrom ?? region,
      tree: treeOrNone,
      published: publicationsFor(ctx, page.spaceId),
      ...(linkChoices ? { chosen: linkChoices } : {}),
      ...(read ? { read } : {}),
    });
    const { revisionId } = await writePage(ctx, page, async (keys, target) => {
      const commit = commitFor(ctx, keys, page, {
        audience: 'draft',
        basedOn,
        payload: linked,
        region,
        target,
      });
      const result = await ctx.api.call(pageRoutes.saveDraft, {
        params: { pageId: page.pageId },
        body: { ...commit, restoredFrom },
      });
      cacheWritten(ctx, commit, linked, generation);
      return result;
    });
    return {
      revisionId,
      repaired,
      region,
      payload: linked,
      inUse,
      renamed,
      linksKept: linksKept || kept,
    };
  };
  if (basedOnRegion) {
    try {
      return await save(basedOnRegion);
    } catch (error) {
      // The region given is only a shortcut: the server and `requireRegion` check every write.
      const moved =
        (error instanceof ApiError || error instanceof CryptoError) &&
        error.code === 'region-mismatch';
      if (!moved) throw error;
    }
  }
  return save(await baseRegion(ctx, page, basedOn));
}

/**
 * The region of the draft `basedOn`. One no longer there was saved over long
 * ago, and draft retention removed it: that is `stale-head` with the page's
 * heads, as for any save on an old base, so the editor offers to keep both.
 * A page out of reach stays `not-found`.
 */
async function baseRegion(ctx: ClientContext, page: PageRef, basedOn: RevisionId) {
  try {
    return (await openRevisionOf(ctx, page, 'draft', basedOn, { fresh: true })).region;
  } catch (error) {
    if (!(error instanceof ApiError && error.code === 'not-found')) throw error;
    const { draftHead, publishedHead } = (await loadPage(ctx, page.pageId)).heads;
    // No draft to see (a reader's), or the head itself unreadable: not a conflict.
    if (draftHead === null || draftHead === basedOn) throw error;
    throw new ApiError(409, 'stale-head', 'Someone saved since you loaded the page', {
      draftHead,
      publishedHead,
    });
  }
}

/** Open the current draft, apply `changes`, and save the result on top of it. */
export async function editDraft(
  ctx: ClientContext,
  page: PageRef,
  changes: PayloadChanges,
): Promise<Written> {
  const { heads } = await loadPage(ctx, page.pageId);
  if (!heads.draftHead) throw new ApiError(404, 'not-found', 'There is no draft to edit');
  const draft = await openRevisionOf(ctx, page, 'draft', heads.draftHead, { fresh: true });
  return saveDraft(ctx, {
    page,
    basedOn: heads.draftHead,
    basedOnRegion: draft.region,
    payload: revisePayload(draft.opened, changes),
  });
}

/** A property set in a draft (`setDraftProperty`): the version written, or why it wasn't. */
export type PropertySet = { ok: true; written: Written | null } | { ok: false; reason: string };

/**
 * The draft `basedOn` with its property `key` (exactly as written) set to
 * `value`, saved on top of it, as a folder's table cell saves one (ADR
 * 0006, decisions 3 and 8): only that value's characters change in the
 * block, or a line is added for a key it hasn't, and a page with no block
 * gets one. If someone saved since, the server answers `stale-head` and
 * nothing is overwritten. A value that can't be changed in place, or a
 * block that doesn't read as properties, is refused with why, and nothing
 * is saved; so is nothing when `value` is the one the draft has
 * (`written: null`).
 */
export async function setDraftProperty(
  ctx: ClientContext,
  {
    page,
    basedOn,
    key,
    value,
    read,
  }: {
    page: PageRef;
    basedOn: RevisionId;
    key: string;
    value: PropertyValue;
    read?: ReadWikilinks;
  },
): Promise<PropertySet> {
  const draft = await openRevisionOf(ctx, page, 'draft', basedOn);
  const previous = current(draft);
  const edit = setPageProperty(previous.markdown, key, value);
  if (!edit.ok) return edit;
  if (edit.markdown === previous.markdown) return { ok: true, written: null };
  const written = await saveDraft(ctx, {
    page,
    basedOn,
    basedOnRegion: draft.region,
    payload: { ...previous, markdown: edit.markdown },
    ...(read ? { read } : {}),
  });
  return { ok: true, written };
}

export async function uploadBlob(
  ctx: ClientContext,
  page: PageRef,
  audience: Audience,
  blob: Uint8Array,
) {
  const path = pageRoutes.BLOB_UPLOAD_PATH.replace(':pageId', encodeURIComponent(page.pageId));
  await ctx.api.upload(`${path}?audience=${audience}`, blob, pageRoutes.BlobUploadResult);
}

export const downloadBlob = (ctx: ClientContext, blobHash: string) =>
  ctx.api.download(pageRoutes.BLOB_DOWNLOAD_PATH.replace(':hash', encodeURIComponent(blobHash)));

/** Encrypt and upload a file. Add the returned ref to a draft's attachments to keep it. */
export async function uploadAttachment(
  ctx: ClientContext,
  page: PageRef,
  file: { name: string; mediaType: string; bytes: Uint8Array },
): Promise<AttachmentRef> {
  const { ref, blob } = sealAttachment({ target: attachmentTarget(ctx, page, 'draft'), ...file });
  await uploadBlob(ctx, page, 'draft', blob);
  return ref;
}

/** Download and decrypt an attachment listed in a revision of `audience`. */
export async function readAttachment(
  ctx: ClientContext,
  page: PageRef,
  audience: Audience,
  ref: AttachmentRef,
): Promise<Uint8Array> {
  const blob = await downloadBlob(ctx, ref.blobHash);
  return openAttachment({ target: attachmentTarget(ctx, page, audience), ref, blob });
}

/** Open an earlier copy fresh: attachment reuse checks its current region and key version. */
async function openIfReadable(
  ctx: ClientContext,
  page: PageRef,
  audience: Audience,
  revisionId: RevisionId,
): Promise<OpenedRevision | null> {
  try {
    return (
      (await openRevisions(ctx, page, audience, [revisionId], { fresh: true })).get(revisionId) ??
      null
    );
  } catch (error) {
    if (error instanceof CryptoError) return null;
    throw error;
  }
}

/**
 * Where a write's content key goes, for deciding which earlier copies of
 * attachments it may list: its region, and in a share the key version it
 * is wrapped under.
 */
type Writing = { region: Region; keyVersion: number | null };

/**
 * Whether `copy`, listed by `earlier`, may stand in for `ref` in a write of
 * `audience` (section 12.2): the same attachment with the same plaintext
 * hash, in a version of that audience in the write's region. In a share it
 * must also be under the key version the write goes under: every removal
 * rotates the keys, so a copy from before one is never carried to people
 * who stayed, under a key the removed person holds (#18).
 */
const mayReuse = (
  ref: AttachmentRef,
  copy: AttachmentRef | undefined,
  { earlier, audience, writing }: { earlier: OpenedRevision; audience: Audience; writing: Writing },
): copy is AttachmentRef & { plainHash: string } =>
  copy !== undefined &&
  copy.plainHash !== undefined &&
  copy.plainHash === ref.plainHash &&
  earlier.record.audience === audience &&
  sameRegion(earlier.region, writing.region) &&
  earlier.keyVersion === writing.keyVersion;

/**
 * Re-encrypt each attachment for another audience under a fresh key and
 * upload it, so a key in one audience never opens the other's blobs. An
 * attachment `earlier`, a version of the target audience, already holds is
 * listed with that copy instead when `mayReuse` allows it and the copy
 * checks out here: downloaded, its hash and plaintext hash recomputed
 * (section 12.2). A copy that doesn't check out is resealed like any other.
 */
async function resealAll(
  ctx: ClientContext,
  page: PageRef,
  payload: PagePayload,
  {
    from,
    to,
    earlier,
    writing,
  }: { from: Audience; to: Audience; earlier: OpenedRevision | null; writing: Writing },
): Promise<PagePayload> {
  const copies = new Map(
    earlier?.opened.kind === 'current'
      ? earlier.opened.payload.attachments.map((ref) => [ref.id, ref])
      : [],
  );
  const attachments = [];
  for (const ref of payload.attachments) {
    const copy = copies.get(ref.id);
    if (
      earlier &&
      mayReuse(ref, copy, { earlier, audience: to, writing }) &&
      (await checksOut(ctx, page, to, copy))
    ) {
      // Its name or other details may have changed; its bytes haven't.
      const { size, key, blobHash, plainHash } = copy;
      attachments.push({ ...ref, size, key, blobHash, plainHash });
      continue;
    }
    const resealed = resealAttachment({
      from: attachmentTarget(ctx, page, from),
      to: attachmentTarget(ctx, page, to),
      ref,
      blob: await downloadBlob(ctx, ref.blobHash),
    });
    await uploadBlob(ctx, page, to, resealed.blob);
    attachments.push(resealed.ref);
  }
  return { ...payload, attachments };
}

// Whether an earlier copy decrypts here to the plaintext its hash names.
async function checksOut(
  ctx: ClientContext,
  page: PageRef,
  audience: Audience,
  copy: AttachmentRef & { plainHash: string },
): Promise<boolean> {
  try {
    // Checks the blob's hash, decrypts it, and recomputes its plaintext hash.
    openAttachment({
      target: attachmentTarget(ctx, page, audience),
      ref: copy,
      blob: await downloadBlob(ctx, copy.blobHash),
    });
    return true;
  } catch (error) {
    if (error instanceof CryptoError) return false;
    throw error;
  }
}

/**
 * Publish the current draft as a separately encrypted version for readers,
 * its broken characters repaired. Its link table is worked out again for
 * readers from this person's tree, loaded now: they may see less than
 * whoever wrote the draft (`writeLinks`). In a share it goes only by what
 * readers there already read: published titles, and the entries of the
 * publication it replaces. Attachments keep the last
 * publication's copies where `resealAll` allows it. If someone published or saved since
 * `heads` were loaded, the server answers `stale-head`.
 *
 * A caller that showed one draft and publication, as the CLI's `--revision`
 * and `--base-published` do, passes them as `expected`: the draft published
 * is that one, and the server refuses with `stale-head` unless both are
 * still the page's heads. With the `permissionVersion` it saw too, as the
 * CLI's `--permission-version`, the server refuses with `permission-version`
 * if who can read the page changed since. Its links are read with `read`,
 * as for `saveDraft`; if that fails, the publication keeps the table
 * readers already read (`writeLinks`). Given `change`, what changes made
 * while reading changed, it says so (`wikistow.change`, naming itself), as
 * their flush's publication does; any other leaves it out (ADR 0008).
 */
export async function publishPage(
  ctx: ClientContext,
  page: PageRef,
  {
    expected,
    read,
    change,
  }: {
    expected?: {
      draftHead: RevisionId;
      publishedHead: RevisionId | null;
      permissionVersion?: number;
    };
    read?: ReadWikilinks;
    change?: ChangeSummary;
  } = {},
): Promise<Written> {
  const generation = ctx.revisions.generation;
  const loaded = (await loadPage(ctx, page.pageId)).heads;
  const heads = expected ?? loaded;
  if (!heads.draftHead) throw new ApiError(404, 'not-found', 'There is no draft to publish');
  const opened = await openRevisionOf(ctx, page, 'draft', heads.draftHead, { fresh: true });
  const { value: draft, repaired } = repairText(withoutChange(current(opened)));
  // Before its links are read and its attachments sealed again.
  checkPayloadSize({ markdown: draft.markdown });
  const previous =
    heads.publishedHead === null
      ? null
      : await openIfReadable(ctx, page, 'published', heads.publishedHead);
  const region = writeRegion({ kind: 'based-on', basedOn: opened.region });
  const {
    payload: linked,
    inUse,
    kept,
  } = await writeLinks(draft, {
    page: { id: page.pageId },
    audience: 'published',
    region,
    // What readers already read: a publication into a share keeps its entries.
    ...(previous?.opened.kind === 'current'
      ? { publication: { table: linkTableOf(previous.opened.payload), region: previous.region } }
      : {}),
    tree: linkTreeFor(ctx, page.spaceId),
    published: publicationsFor(ctx, page.spaceId),
    ...(read ? { read } : {}),
  });
  // Resealed with the keys of each try, so a copy is reused only under the
  // key version the publication goes under.
  const written = await writePage(ctx, page, async (keys, target) => {
    const resealed = await resealAll(ctx, page, linked, {
      from: 'draft',
      to: 'published',
      earlier: previous,
      writing: writingFor(ctx, keys, region, target),
    });
    // What it changed names the version it is in, so no copy of it counts.
    const revisionId = newId(RevisionIdSchema);
    const payload: PagePayload = change
      ? {
          ...resealed,
          extensions: {
            ...resealed.extensions,
            [CHANGE_NAMESPACE]: { format: 1, revision: revisionId, ...change },
          },
        }
      : resealed;
    const seen = expected?.permissionVersion;
    const commit = commitFor(ctx, keys, page, {
      audience: 'published',
      basedOn: heads.draftHead,
      payload,
      region,
      target: seen === undefined ? target : { ...target, permissionVersion: seen },
      revisionId,
    });
    const result = await ctx.api.call(pageRoutes.publish, {
      params: { pageId: page.pageId },
      body: { ...commit, expectedPublishedHead: heads.publishedHead },
    });
    cacheWritten(ctx, commit, payload, generation);
    return { ...result, payload };
  });
  return {
    revisionId: written.revisionId,
    repaired,
    region,
    payload: written.payload,
    // Resealing changes only its attachments.
    inUse: { ...written.payload, extensions: inUse.extensions },
    renamed: [],
    linksKept: kept,
  };
}

/** The region and key version a write in `region` goes under (`keyTargetFor`). */
function writingFor(
  ctx: ClientContext,
  keys: SpaceKeys,
  region: Region,
  target: Awaited<ReturnType<typeof treeTarget>>,
): Writing {
  return {
    region,
    keyVersion: keyTargetFor(ctx, keys, region, target.share).share?.keyVersion ?? null,
  };
}

/**
 * Hide the page from readers (section 11): it stays, with its whole history,
 * for editors and owners, and readers get not-found for it, its history and
 * its attachments. No keys change, so what readers already downloaded stays
 * theirs. Pass the published head and permission version this person saw:
 * if someone published or unpublished since, the server answers
 * `stale-head`, and if access changed, `permission-version`; either way
 * nothing changes. The next publish starts a new reader history.
 */
export async function unpublishPage(
  ctx: ClientContext,
  page: PageRef,
  seen: { publishedHead: RevisionId; permissionVersion: number },
): Promise<void> {
  await ctx.api.call(pageRoutes.unpublish, {
    params: { pageId: page.pageId },
    body: { expectedPublishedHead: seen.publishedHead, permissionVersion: seen.permissionVersion },
  });
}

/**
 * Make an earlier published version the new draft, listing the draft copies
 * of attachments it was published from, without what changes made while
 * reading changed (`withoutChange`). Nothing is published until Publish.
 * Its link table is worked out again for the draft (`writeLinks`), and its
 * entries carried only if the publication is in the draft's region. Its
 * links are read with `read`, as for `saveDraft`.
 */
export async function restorePublished(
  ctx: ClientContext,
  page: PageRef,
  publishedId: RevisionId,
  { read }: { read?: ReadWikilinks } = {},
): Promise<Written> {
  const generation = ctx.revisions.generation;
  const { heads } = await loadPage(ctx, page.pageId);
  if (!heads.draftHead) throw new ApiError(404, 'not-found', 'There is no draft to restore into');
  const published = await openRevisionOf(ctx, page, 'published', publishedId);
  const draft = await openRevisionOf(ctx, page, 'draft', heads.draftHead, { fresh: true });
  // The draft it was published from may still hold draft copies to list.
  const source = published.record.basedOn;
  const earlier = source === null ? null : await openIfReadable(ctx, page, 'draft', source);
  const { value: repairedPayload, repaired } = repairText(withoutChange(current(published)));
  checkPayloadSize({ markdown: repairedPayload.markdown });
  const region = draft.region;
  const {
    payload,
    inUse,
    renamed,
    kept: linksKept,
  } = await writeLinks(repairedPayload, {
    page: { id: page.pageId },
    audience: 'draft',
    region,
    tableRegion: published.region,
    tree: linkTreeFor(ctx, page.spaceId),
    published: publicationsFor(ctx, page.spaceId),
    ...(read ? { read } : {}),
  });
  const written = await writePage(ctx, page, async (keys, target) => {
    const restored = await resealAll(ctx, page, payload, {
      from: 'published',
      to: 'draft',
      earlier,
      writing: writingFor(ctx, keys, region, target),
    });
    const commit = commitFor(ctx, keys, page, {
      audience: 'draft',
      basedOn: heads.draftHead,
      payload: restored,
      region,
      target,
    });
    const result = await ctx.api.call(pageRoutes.saveDraft, {
      params: { pageId: page.pageId },
      body: { ...commit, restoredFrom: publishedId },
    });
    cacheWritten(ctx, commit, restored, generation);
    return { ...result, payload: restored };
  });
  return {
    revisionId: written.revisionId,
    repaired,
    region,
    payload: written.payload,
    // Resealing changes only its attachments.
    inUse: { ...written.payload, extensions: inUse.extensions },
    renamed,
    linksKept,
  };
}

/** Delete a folder or page and everything beneath it. */
export async function deleteNode(
  ctx: ClientContext,
  { spaceId, nodeId }: { spaceId: SpaceId; nodeId: FolderId | PageId },
): Promise<void> {
  await ctx.api.call(pageRoutes.deleteNode, { params: { spaceId, nodeId } });
}
