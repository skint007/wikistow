// Public links (ADR 0005): turning a page's link on and off, staging and
// committing its readable copy, listing a space's links, and opening a
// public page for anyone with its link.
//
// Turning on, staging, committing and turning off take publishing's locks
// in its order: the space (key share), the share, the page, then its heads
// row (`lockPage`). Then account rows, in order of ID, each checked for
// suspension; then link rows in order of page ID, the page's own and, for
// staging and committing, those of the pages its gaps lead to; then
// copies; then target rows (`endings.ts`).
import { publicLinkRoutes } from '@wikistow/contracts';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../admin/audit.ts';
import type { Database } from '../db/client.ts';
import {
  nodes,
  pageHeads,
  publicCopies,
  publicFiles,
  publicLinks,
  publicTargets,
  users,
} from '../db/schema/index.ts';
import {
  accessTo,
  accessToPages,
  canEdit,
  lockShare,
  lockSpaceOf,
  shareAt,
  treesSeenBy,
  type Access,
} from '../content/access.ts';
import { ContentError } from '../content/errors.ts';
import { currentIdentity, humanActor, requireCaller, type Caller } from '../content/identities.ts';
import { requirePage, requirePageAccess } from '../content/pages.ts';
import { charge } from '../content/quota.ts';
import { endCopies, endLinkFor } from './endings.ts';
import { escapeHtml } from './page.ts';
import type { ListedFile } from './render.ts';
import type { Renderer } from './renderer.ts';
import { pageOfKey, READER_VERSION, Segment } from './segments.ts';

const publishes = (access: Access | null) => canEdit(access) && access?.canPublish === true;

/** The most a copy's file may be, here: `MAX_FILE_BYTES`, or the upload limit if lower. */
export const fileLimit = (uploadBytes: number) =>
  Math.min(publicLinkRoutes.MAX_FILE_BYTES, uploadBytes);

const noLink = () => new ContentError('not-found', 'This page has no public link');

/**
 * Whether an account can publish a page now: not suspended, with a vault,
 * and edit access with publish rights there, as an owner or a member.
 */
async function personPublishes(db: Database, accountId: string, pageId: string) {
  const [user] = await db
    .select({ suspendedAt: users.suspendedAt })
    .from(users)
    .where(eq(users.id, accountId));
  if (!user || user.suspendedAt) return false;
  const identity = await currentIdentity(db, accountId);
  if (!identity) return false;
  return callerPublishes(db, { accountId, identity, personId: null }, pageId);
}

/** Whether `caller` can publish the page `pageId`, in whichever space it is. */
async function callerPublishes(db: Database, caller: Caller, pageId: string) {
  const [page] = await db
    .select({ spaceId: nodes.spaceId })
    .from(nodes)
    .where(and(eq(nodes.id, pageId), eq(nodes.kind, 'page')));
  return (
    page !== undefined &&
    publishes(await accessTo(db, caller, { spaceId: page.spaceId, nodeId: pageId }))
  );
}

/**
 * Take a page's locks as publishing does, and answer its row and heads.
 * With `caller`, they must be able to publish it: not-found if they can't
 * edit it, forbidden if they can but can't publish.
 */
async function lockPage(tx: Database, pageId: string, caller: Caller | null) {
  await lockSpaceOf(tx, pageId);
  const page = await requirePage(tx, pageId);
  if (caller) {
    const access = await requirePageAccess(tx, caller, page);
    if (!canEdit(access)) throw new ContentError('not-found');
    if (!access.canPublish) throw new ContentError('forbidden');
    await lockShare(tx, access.share);
  } else {
    await shareAt(tx, page.spaceId, page.id, { lock: 'share' });
  }
  await requirePage(tx, pageId, { lock: true });
  const [heads] = await tx
    .select()
    .from(pageHeads)
    .where(eq(pageHeads.pageId, pageId))
    .for('update');
  if (!heads) throw new ContentError('not-found');
  return { page, heads };
}

/** Lock account rows, in order of ID, as suspension does; with `active`, none may be suspended. */
async function lockAccounts(tx: Database, ids: readonly string[], { active = true } = {}) {
  const rows = await tx
    .select({ id: users.id, suspendedAt: users.suspendedAt })
    .from(users)
    .where(sql`${users.id} = any(${sql.param([...new Set(ids)])}::uuid[])`)
    .orderBy(users.id)
    .for('share');
  if (active && (rows.length !== new Set(ids).size || rows.some((row) => row.suspendedAt))) {
    throw new ContentError('forbidden', 'This account is suspended');
  }
}

/** Lock link rows, in order of page ID, and answer them. */
function lockLinks(tx: Database, pageIds: readonly string[], mode: 'share' | 'update') {
  return tx
    .select()
    .from(publicLinks)
    .where(sql`${publicLinks.pageId} = any(${sql.param([...new Set(pageIds)])}::text[])`)
    .orderBy(publicLinks.pageId)
    .for(mode);
}

/**
 * Turn the page's link on, with a new id, or answer the one it has: for a
 * person who can publish it, not suspended, while it is published.
 */
export async function turnOnLink(db: Database, accountId: string, pageId: string) {
  return db.transaction(async (tx) => {
    const caller = await requireCaller(tx, humanActor(accountId));
    const { page, heads } = await lockPage(tx, pageId, caller);
    if (!heads.publishedHead) {
      throw new ContentError('not-found', 'Only a published page can have a public link');
    }
    await lockAccounts(tx, [accountId]);
    const [link] = await lockLinks(tx, [pageId], 'update');
    if (link) return { id: link.id };
    const id = randomBytes(16).toString('base64url');
    await tx.insert(publicLinks).values({ pageId, id, sharedBy: accountId });
    await audit(tx, {
      actor: accountId,
      action: 'node.public-link-on',
      target: { kind: 'node', id: pageId },
      details: { spaceId: page.spaceId },
    });
    return { id };
  });
}

/**
 * Turn the page's link off, with every copy of it and every target row
 * naming it, for a person who can publish it. No error if it is off.
 */
export async function turnOffLink(db: Database, accountId: string, pageId: string) {
  await db.transaction(async (tx) => {
    const caller = await requireCaller(tx, humanActor(accountId));
    const { page } = await lockPage(tx, pageId, caller);
    await endLinkFor(tx, page, { actor: accountId, reason: 'turned-off' });
  });
}

type StageInput = {
  accountId: string;
  pageId: string;
  revisionId: string;
  title: string;
  markdown: string;
  attachments: readonly ListedFile[];
  targets: readonly { key: string; pageId: string }[];
  uploadBytes: number;
};

/**
 * Stage a copy of the page's published head (ADR 0005, decision 5, step 1):
 * check publish rights, the head and the link without locks, render the
 * body with none held, then check again under the locks and store the copy
 * with its files still to come, and a target row for each gap that leads
 * to a page whose link is on and the uploader can publish. Which files it
 * needs: the attachments its body uses, but those left out for size.
 */
export async function stageCopy(db: Database, renderer: Renderer, input: StageInput) {
  const { accountId, pageId, revisionId } = input;
  const caller = await requireCaller(db, humanActor(accountId));
  const page = await requirePage(db, pageId);
  const access = await requirePageAccess(db, caller, page);
  if (!canEdit(access)) throw new ContentError('not-found');
  if (!access.canPublish) throw new ContentError('forbidden');
  const [link] = await db.select().from(publicLinks).where(eq(publicLinks.pageId, pageId));
  if (!link) throw noLink();
  const rendered = await renderer.render(accountId, {
    markdown: input.markdown,
    linkId: link.id,
    attachments: input.attachments,
    limits: {
      fileBytes: fileLimit(input.uploadBytes),
      copyBytes: publicLinkRoutes.MAX_COPY_BYTES,
    },
  });
  return db.transaction(async (tx) => {
    const { heads } = await lockPage(tx, pageId, await requireCaller(tx, humanActor(accountId)));
    if (heads.publishedHead !== revisionId) {
      throw new ContentError('stale-head', 'That isn’t the page’s published version', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    await lockAccounts(tx, [accountId]);
    // Each gap's page: a wikilink's as the app named it, an address's its own.
    const named = new Map(input.targets.map((target) => [target.key, target.pageId]));
    // At most `MAX_TARGET_PAGES` pages, since every visit checks the
    // uploader can still publish each; links to any past that stay text.
    const leadsTo = new Map<string, string>();
    const pages = new Set<string>();
    for (const segment of rendered.segments) {
      if (typeof segment === 'string') continue;
      const target = pageOfKey(segment.key) ?? named.get(segment.key);
      if (!target || (!pages.has(target) && pages.size >= MAX_TARGET_PAGES)) continue;
      pages.add(target);
      leadsTo.set(segment.key, target);
    }
    const links = await lockLinks(tx, [pageId, ...leadsTo.values()], 'share');
    if (links.find((row) => row.pageId === pageId)?.id !== link.id) throw noLink();
    const linked = new Set(links.map((row) => row.pageId));
    const reachable = new Set<string>();
    for (const target of new Set(leadsTo.values())) {
      if (linked.has(target) && (await callerPublishes(tx, caller, target))) reachable.add(target);
    }
    // A person stages one copy of a page at a time: a new one replaces
    // any they staged before, so staging again and again can't pile up
    // readable copies until the sweep.
    const earlier = await tx
      .select({ id: publicCopies.id })
      .from(publicCopies)
      .where(
        and(
          eq(publicCopies.pageId, pageId),
          eq(publicCopies.uploadedBy, accountId),
          eq(publicCopies.live, false),
        ),
      );
    await endCopies(
      tx,
      pageId,
      earlier.map((copy) => copy.id),
    );
    const [copy] = await tx
      .insert(publicCopies)
      .values({
        pageId,
        revisionId,
        title: input.title,
        markdown: input.markdown,
        rendering: rendered.segments,
        readerVersion: READER_VERSION,
        uploadedBy: accountId,
      })
      .returning({ id: publicCopies.id });
    if (!copy) throw new Error('the copy was not stored');
    const listed = new Map(input.attachments.map((file) => [file.id, file]));
    const files = rendered.files.flatMap(({ id, leftOut }) => {
      const file = listed.get(id);
      if (!file) return [];
      const { name, mediaType, size } = file;
      return [{ copyId: copy.id, attachmentId: id, name, mediaType, size, leftOut }];
    });
    if (files.length > 0) await tx.insert(publicFiles).values(files);
    const targets = [...leadsTo].filter(([, target]) => reachable.has(target));
    if (targets.length > 0) {
      await tx
        .insert(publicTargets)
        .values(targets.map(([key, targetPageId]) => ({ copyId: copy.id, key, targetPageId })));
    }
    return {
      copyId: copy.id,
      files: files.flatMap((file) => (file.leftOut ? [] : [file.attachmentId])),
    };
  });
}

// A copy as its uploader finds it to add to or commit: not-found for
// anyone else, so nobody learns of another's.
async function uploadersCopy(db: Database, accountId: string, copyId: string) {
  const [copy] = await db
    .select({
      pageId: publicCopies.pageId,
      uploadedBy: publicCopies.uploadedBy,
      revisionId: publicCopies.revisionId,
    })
    .from(publicCopies)
    .where(eq(publicCopies.id, copyId));
  if (!copy || copy.uploadedBy !== accountId) throw new ContentError('not-found');
  return copy;
}

/**
 * Store one file of a staged copy (decision 5, step 2), at most its
 * declared size, for the person who staged it while they can publish the
 * page, charged to their storage.
 */
export async function uploadCopyFile(
  db: Database,
  input: {
    accountId: string;
    copyId: string;
    attachmentId: string;
    bytes: Uint8Array;
    storageBytes: number;
  },
) {
  const { accountId, copyId } = input;
  const { pageId } = await uploadersCopy(db, accountId, copyId);
  await db.transaction(async (tx) => {
    await lockPage(tx, pageId, await requireCaller(tx, humanActor(accountId)));
    await lockAccounts(tx, [accountId]);
    if ((await lockLinks(tx, [pageId], 'share')).length === 0) throw noLink();
    const [copy] = await tx
      .select({ live: publicCopies.live })
      .from(publicCopies)
      .where(eq(publicCopies.id, copyId))
      .for('update');
    if (!copy || copy.live) throw new ContentError('not-found', 'That copy isn’t staged');
    const [file] = await tx
      .select({
        size: publicFiles.size,
        leftOut: publicFiles.leftOut,
        stored: sql<number>`coalesce(octet_length(${publicFiles.bytes}), 0)`.mapWith(Number),
      })
      .from(publicFiles)
      .where(and(eq(publicFiles.copyId, copyId), eq(publicFiles.attachmentId, input.attachmentId)))
      .for('update');
    if (!file || file.leftOut) throw new ContentError('not-found', 'That copy needs no such file');
    if (input.bytes.byteLength > file.size) {
      throw new ContentError('too-large', 'The file is larger than its staging said');
    }
    await charge(tx, accountId, input.bytes.byteLength - file.stored, input.storageBytes);
    await tx
      .update(publicFiles)
      .set({ bytes: input.bytes })
      .where(and(eq(publicFiles.copyId, copyId), eq(publicFiles.attachmentId, input.attachmentId)));
    await tx
      .update(publicCopies)
      .set({ touchedAt: sql`now()` })
      .where(eq(publicCopies.id, copyId));
  });
}

/**
 * Make a staged copy live (decision 5, step 3): every check of staging
 * again, every file it needs arrived, then the page's other copies go. A
 * retry of one already live is no error.
 */
export async function commitCopy(db: Database, accountId: string, copyId: string) {
  const { pageId, revisionId } = await uploadersCopy(db, accountId, copyId);
  await db.transaction(async (tx) => {
    const { heads } = await lockPage(tx, pageId, await requireCaller(tx, humanActor(accountId)));
    if (heads.publishedHead !== revisionId) {
      throw new ContentError('stale-head', 'The page was published again since', {
        draftHead: heads.draftHead,
        publishedHead: heads.publishedHead,
      });
    }
    // Read under the heads row, which turning a link on or off takes too.
    const [link] = await tx.select().from(publicLinks).where(eq(publicLinks.pageId, pageId));
    if (!link) throw noLink();
    await lockAccounts(tx, [link.sharedBy, accountId]);
    const targets = await tx
      .selectDistinct({ pageId: publicTargets.targetPageId })
      .from(publicTargets)
      .where(eq(publicTargets.copyId, copyId));
    const links = await lockLinks(tx, [pageId, ...targets.map((t) => t.pageId)], 'share');
    if (links.find((row) => row.pageId === pageId)?.id !== link.id) throw noLink();
    const copies = await tx
      .select({ id: publicCopies.id, live: publicCopies.live })
      .from(publicCopies)
      .where(eq(publicCopies.pageId, pageId))
      .orderBy(publicCopies.id)
      .for('update');
    const mine = copies.find((copy) => copy.id === copyId);
    if (!mine) throw new ContentError('not-found', 'That copy is gone; share it again');
    if (mine.live) return;
    const [missing] = await tx
      .select({ id: publicFiles.attachmentId })
      .from(publicFiles)
      .where(
        and(
          eq(publicFiles.copyId, copyId),
          eq(publicFiles.leftOut, false),
          sql`${publicFiles.bytes} is null`,
        ),
      )
      .limit(1);
    if (missing) throw new ContentError('missing-blob', 'A file of the copy hasn’t arrived');
    await endCopies(
      tx,
      pageId,
      copies.flatMap((copy) => (copy.id === copyId ? [] : [copy.id])),
    );
    await tx
      .update(publicCopies)
      .set({ live: true, touchedAt: sql`now()` })
      .where(eq(publicCopies.id, copyId));
  });
}

/**
 * The space's pages with a link on that the caller sees, for a person who
 * sees some of its tree: each link's id only where they can publish the
 * page, and whether a copy is live.
 */
export async function listLinks(db: Database, accountId: string, spaceId: string) {
  const caller = await requireCaller(db, humanActor(accountId));
  if (!(await treesSeenBy(db, accountId, [spaceId])).has(spaceId)) {
    throw new ContentError('not-found');
  }
  const rows = await db
    .select({
      pageId: publicLinks.pageId,
      id: publicLinks.id,
      live: sql<boolean>`exists (select 1 from ${publicCopies} where ${publicCopies.pageId} = ${publicLinks.pageId} and ${publicCopies.live})`,
    })
    .from(publicLinks)
    .innerJoin(nodes, eq(nodes.id, publicLinks.pageId))
    .where(eq(nodes.spaceId, spaceId))
    .orderBy(publicLinks.pageId);
  const access = await accessToPages(
    db,
    caller,
    spaceId,
    rows.map((row) => row.pageId),
  );
  return rows.flatMap((row) => {
    const at = access.get(row.pageId) ?? null;
    if (!at) return [];
    return [{ pageId: row.pageId, id: publishes(at) ? row.id : null, live: row.live }];
  });
}

/**
 * End what has lapsed of a page's link (decision 8): the link, with every
 * copy, if who turned it on can no longer publish the page, else each copy
 * whose uploader can't. Under the page's locks and its people's account
 * rows, so it sees every copy, and checks again what it ends.
 */
export async function endLapsed(db: Database, pageId: string) {
  return db.transaction(async (tx) => {
    const ended = { links: 0, copies: 0 };
    const page = await lockPage(tx, pageId, null).then(
      (locked) => locked.page,
      (error: unknown) => {
        if (error instanceof ContentError && error.code === 'not-found') return null;
        throw error;
      },
    );
    if (!page) return ended;
    // Read under the heads row, which every change of these takes.
    const [link] = await tx.select().from(publicLinks).where(eq(publicLinks.pageId, pageId));
    if (!link) return ended;
    const copies = await tx
      .select({ id: publicCopies.id, uploadedBy: publicCopies.uploadedBy })
      .from(publicCopies)
      .where(eq(publicCopies.pageId, pageId));
    await lockAccounts(tx, [link.sharedBy, ...copies.map((copy) => copy.uploadedBy)], {
      active: false,
    });
    if (!(await personPublishes(tx, link.sharedBy, pageId))) {
      await endLinkFor(tx, page, { actor: null, reason: 'lost-publish-rights' });
      return { links: 1, copies: copies.length };
    }
    const lapsed = [];
    for (const copy of copies) {
      if (!(await personPublishes(tx, copy.uploadedBy, pageId))) lapsed.push(copy.id);
    }
    ended.copies = await endCopies(tx, pageId, lapsed);
    return ended;
  });
}

/** The most other pages a copy links to; see `stageCopy`. */
const MAX_TARGET_PAGES = 50;

/** How long a staged copy waits for its next request before the sweep deletes it. */
const STAGED_FOR_MS = 10 * 60 * 1000;

/**
 * Delete staged copies nothing has touched for `STAGED_FOR_MS`, then, as a
 * backstop for any path that missed one, end each link and copy whose
 * sharer or uploader can no longer publish its page (`endLapsed`).
 */
export async function sweepPublicLinks(db: Database) {
  const cutoff = new Date(Date.now() - STAGED_FOR_MS);
  const stale = and(eq(publicCopies.live, false), sql`${publicCopies.touchedAt} < ${cutoff}`);
  let staged = 0;
  for (const { id } of await db.select({ id: publicCopies.id }).from(publicCopies).where(stale)) {
    staged += await db.transaction(async (tx) => {
      const [copy] = await tx
        .select({ pageId: publicCopies.pageId })
        .from(publicCopies)
        .where(and(eq(publicCopies.id, id), stale))
        .for('update');
      return copy ? endCopies(tx, copy.pageId, [id]) : 0;
    });
  }
  const people = [
    ...(await db
      .select({ pageId: publicLinks.pageId, accountId: publicLinks.sharedBy })
      .from(publicLinks)),
    ...(await db
      .selectDistinct({ pageId: publicCopies.pageId, accountId: publicCopies.uploadedBy })
      .from(publicCopies)),
  ];
  const pages = new Set<string>();
  for (const { pageId, accountId } of people) {
    if (!pages.has(pageId) && !(await personPublishes(db, accountId, pageId))) pages.add(pageId);
  }
  let links = 0;
  let copies = staged;
  for (const pageId of pages) {
    const ended = await endLapsed(db, pageId);
    links += ended.links;
    copies += ended.copies;
  }
  return { staged, links, copies };
}

const Rendering = z.array(Segment);

/** What `/p/<id>` shows: a page, a note that it is being updated, or nothing. */
export type PublicPage =
  | { kind: 'page'; title: string; body: string }
  | { kind: 'updating' }
  | { kind: 'not-found' };

// The link with this id, and its live copy, once its sharer and the copy's
// uploader are both checked: a lapsed one is ended first (`endLapsed`).
async function liveCopyOf(db: Database, id: string) {
  const find = () =>
    db
      .select({
        pageId: publicLinks.pageId,
        sharedBy: publicLinks.sharedBy,
        copy: {
          id: publicCopies.id,
          title: publicCopies.title,
          rendering: publicCopies.rendering,
          readerVersion: publicCopies.readerVersion,
          uploadedBy: publicCopies.uploadedBy,
        },
      })
      .from(publicLinks)
      .leftJoin(
        publicCopies,
        and(eq(publicCopies.pageId, publicLinks.pageId), eq(publicCopies.live, true)),
      )
      .where(eq(publicLinks.id, id));
  let [found] = await find();
  if (!found) return null;
  const lapsed =
    !(await personPublishes(db, found.sharedBy, found.pageId)) ||
    (found.copy !== null && !(await personPublishes(db, found.copy.uploadedBy, found.pageId)));
  if (lapsed) {
    await endLapsed(db, found.pageId);
    [found] = await find();
  }
  return found ?? null;
}

/**
 * The public page `/p/<id>` shows (ADR 0005, decision 7): its live copy,
 * each gap a link to its target's public page while the target row is
 * there and the uploader can still publish that page, else its text.
 */
export async function openPublicPage(db: Database, id: string): Promise<PublicPage> {
  const found = publicLinkRoutes.LinkId.safeParse(id).success ? await liveCopyOf(db, id) : null;
  if (!found) return { kind: 'not-found' };
  const { copy } = found;
  const rendering = Rendering.safeParse(copy?.rendering);
  if (!copy || copy.readerVersion !== READER_VERSION || !rendering.success) {
    return { kind: 'updating' };
  }
  const targets = new Map(
    (
      await db
        .select({ key: publicTargets.key, pageId: publicTargets.targetPageId, id: publicLinks.id })
        .from(publicTargets)
        .innerJoin(publicLinks, eq(publicLinks.pageId, publicTargets.targetPageId))
        .where(eq(publicTargets.copyId, copy.id))
    ).map((target) => [target.key, target]),
  );
  const reachable = new Map<string, Promise<boolean>>();
  const parts = [];
  for (const segment of rendering.data) {
    if (typeof segment === 'string') {
      parts.push(segment);
      continue;
    }
    const target = targets.get(segment.key);
    let open = target && reachable.get(target.pageId);
    if (target && !open) {
      open = personPublishes(db, copy.uploadedBy, target.pageId);
      reachable.set(target.pageId, open);
    }
    const text = escapeHtml(segment.text);
    parts.push(
      target && (await open)
        ? `<a href="/p/${target.id}${segment.hash ? `#${encodeURIComponent(segment.hash)}` : ''}">${text}</a>`
        : text,
    );
  }
  return { kind: 'page', title: copy.title, body: parts.join('') };
}

/**
 * A file of the link's live copy (decision 7), with the same checks as
 * its page: its type, name and size, or null.
 */
export async function openPublicFile(db: Database, id: string, attachmentId: string) {
  const found = publicLinkRoutes.LinkId.safeParse(id).success ? await liveCopyOf(db, id) : null;
  if (!found?.copy) return null;
  const [file] = await db
    .select({
      copyId: publicFiles.copyId,
      name: publicFiles.name,
      mediaType: publicFiles.mediaType,
      size: sql`octet_length(${publicFiles.bytes})`.mapWith(Number),
    })
    .from(publicFiles)
    .where(
      and(
        eq(publicFiles.copyId, found.copy.id),
        eq(publicFiles.attachmentId, attachmentId),
        isNotNull(publicFiles.bytes),
      ),
    );
  return file ?? null;
}

/**
 * Up to `length` of a copy's file from `offset`, or null once it is gone.
 * The column is stored uncompressed, so Postgres reads only this part.
 */
export async function publicFilePart(
  db: Database,
  file: { copyId: string; attachmentId: string },
  offset: number,
  length: number,
) {
  const [row] = await db
    .select({
      part: sql`substring(${publicFiles.bytes} from ${offset + 1} for ${length})`.mapWith(
        publicFiles.bytes,
      ),
    })
    .from(publicFiles)
    .where(
      and(eq(publicFiles.copyId, file.copyId), eq(publicFiles.attachmentId, file.attachmentId)),
    );
  return row?.part ?? null;
}

/**
 * Render again every copy a different version of the reader rendered, as
 * it was staged, keeping its files. Each one's page says it's being
 * updated until then. Run in the background after the server starts.
 */
export async function rerenderCopies(db: Database, renderer: Renderer) {
  const old = await db
    .select({
      id: publicCopies.id,
      markdown: publicCopies.markdown,
      readerVersion: publicCopies.readerVersion,
      linkId: publicLinks.id,
    })
    .from(publicCopies)
    .innerJoin(publicLinks, eq(publicLinks.pageId, publicCopies.pageId))
    .where(ne(publicCopies.readerVersion, READER_VERSION));
  let rendered = 0;
  for (const copy of old) {
    const files = await db
      .select({
        id: publicFiles.attachmentId,
        name: publicFiles.name,
        mediaType: publicFiles.mediaType,
        size: publicFiles.size,
        leftOut: publicFiles.leftOut,
      })
      .from(publicFiles)
      .where(eq(publicFiles.copyId, copy.id));
    const input = {
      markdown: copy.markdown,
      linkId: copy.linkId,
      attachments: files,
      limits: { fileBytes: 0, copyBytes: 0 },
      files: files.map(({ id, leftOut }) => ({ id, leftOut })),
    };
    const { segments } = await renderWhenFree(renderer, input);
    // A copy that went meanwhile, or was rendered by another server, stays as it is.
    const updated = await db
      .update(publicCopies)
      .set({ rendering: segments, readerVersion: READER_VERSION })
      .where(and(eq(publicCopies.id, copy.id), eq(publicCopies.readerVersion, copy.readerVersion)))
      .returning({ id: publicCopies.id });
    rendered += updated.length;
  }
  return { rendered };
}

// The server's own renders wait their turn behind people's.
async function renderWhenFree(renderer: Renderer, input: Parameters<Renderer['render']>[1]) {
  for (;;) {
    try {
      return await renderer.render('server:rerender', input);
    } catch (error) {
      if (!(error instanceof ContentError && error.code === 'busy')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
