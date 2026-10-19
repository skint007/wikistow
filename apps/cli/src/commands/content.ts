// `wikistow spaces list`, `tree` and `page …`: what an agent reads and writes.
import {
  ApiError,
  checkPayloadSize,
  withoutLinkTable,
  CryptoError,
  findWikilinks,
  linkablePages,
  linkTableOf,
  outcomeUnknown,
  pageOperations as pages,
  publicationOperations as publications,
  renamedLinks,
  repairText,
  resolveLinked,
  revisePayload,
  sharingOperations,
  spaceOperations,
  type AttachmentRef,
  type ClientContext,
  type LinkTree,
  type PagePayload,
  type RenamedLink,
  type ResolvedLink,
  type Wikilink,
} from '@wikistow/client';
import {
  pageRoutes,
  structureRoutes,
  AttachmentId,
  type FolderId,
  type PageId,
  type RevisionId,
  type SpaceId,
} from '@wikistow/contracts';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { z } from 'zod';
import { finish, openAgent, type OpenedAgent, type UnlockOptions } from '../agent.ts';
import { ChangeMayHaveHappened, CliError, stateNotSaved } from '../exit.ts';
import type { Io, Printer } from '../io.ts';
import { inputHash } from '../journal.ts';
import type { Deps } from './agent.ts';

type LoadedMetadata = spaceOperations.LoadedMetadata;
type OpenedRevision = pages.OpenedRevision;
type PublicationPreview = publications.PublicationPreview;

/** What every content command is run with. */
export type ContentArgs = {
  unlock: UnlockOptions;
  idempotencyKey: string | null;
};

/**
 * Run `body` with the agent open, then keep what its session learned. A
 * change command passes `input`, a hash of what it was asked to do, so a
 * retry with its key can be held to the same.
 */
export async function withAgent<T>(
  io: Io,
  out: Printer,
  args: ContentArgs,
  deps: Deps,
  body: (agent: OpenedAgent) => Promise<T>,
  input?: string,
): Promise<T> {
  const agent = await openAgent(io, {
    unlock: args.unlock,
    idempotencyKey: args.idempotencyKey,
    ...(input === undefined ? {} : { input }),
    makeStore: deps.makeStore,
    send: deps.send,
  });
  let result: T;
  try {
    result = await body(agent);
  } catch (error) {
    // Its own failure is the one to report.
    await finish(agent).catch(() => {});
    // Sent, then no answer or a server failure, or a failure after the
    // answer: the change may have been made, and the agent must be told.
    const { journal } = agent;
    if (journal.inconclusive) throw new ChangeMayHaveHappened(error, 'check');
    if (journal.attempted && (outcomeUnknown(error) || journal.sent !== null)) {
      throw new ChangeMayHaveHappened(error, args.idempotencyKey === null ? 'unkeyed' : 'resend');
    }
    throw error;
  }
  // Done, whatever happens now: a failure to keep what was learned is
  // reported with the result, not in place of it.
  await finish(agent).catch((error: unknown) => out.warn(stateNotSaved(error)));
  return result;
}

const nameOf = (loaded: LoadedMetadata | null) =>
  loaded?.opened.kind === 'current' ? loaded.opened.metadata.name : null;

/** `spaces list`: every folder or space this agent was given, with its name. */
export async function listSpaces(io: Io, out: Printer, args: ContentArgs, deps: Deps) {
  const items = await withAgent(io, out, args, deps, ({ ctx }) =>
    sharingOperations.sharedWithMe(ctx),
  );
  const grants = items.map(({ share, role, canPublish, folderId, root }) => ({
    spaceId: share.spaceId,
    shareId: share.shareId,
    folderId,
    role,
    canPublish,
    name: nameOf(root),
  }));
  out.result({ spaces: grants }, () => {
    for (const grant of grants) {
      const where = grant.folderId === null ? 'space' : `folder ${grant.folderId}`;
      const role = `${grant.role}${grant.canPublish ? '+publish' : ''}`;
      out.line(
        `${grant.spaceId}  ${where}  ${role}  ${out.foreign(grant.name ?? '(unreadable name)')}`,
      );
    }
  });
}

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;

type LinkablePage = { id: PageId; title: string | null; parentId: FolderId | null };

/** `tree --space`: the folders and pages this agent can see, with names and titles. */
export async function tree(
  io: Io,
  out: Printer,
  args: ContentArgs & { spaceId: SpaceId },
  deps: Deps,
) {
  const loaded = await withAgent(io, out, args, deps, ({ ctx }) =>
    spaceOperations.loadTree(ctx, args.spaceId),
  );
  const result = {
    spaceId: args.spaceId,
    space: loaded.space && { name: nameOf(loaded.space.metadata), role: loaded.space.role },
    shares: loaded.shares,
    folders: loaded.folders.map((f) => ({
      id: f.id,
      parentId: f.parentId,
      name: nameOf(f.metadata),
    })),
    pages: loaded.pages.map((p) => ({
      id: p.id,
      parentId: p.parentId,
      title: p.title,
      permissionVersion: p.permissionVersion,
      draftHead: p.draftHead,
      publishedHead: p.publishedHead,
      draftChanges: p.draftChanges,
    })),
  };
  out.result(result, () => {
    const print = (parentId: FolderId | null, depth: number) => {
      const indent = '  '.repeat(depth);
      for (const folder of result.folders.filter((f) => f.parentId === parentId)) {
        out.line(`${indent}${out.foreign(folder.name ?? '(unreadable name)')}/  ${folder.id}`);
        print(folder.id, depth + 1);
      }
      for (const page of result.pages.filter((p) => p.parentId === parentId)) {
        const state =
          page.publishedHead === null
            ? 'unpublished'
            : page.draftChanges
              ? 'draft changes'
              : 'published';
        out.line(
          `${indent}${out.foreign(page.title ?? '(unreadable title)')}  ${page.id}  [${state}]`,
        );
      }
    };
    print(null, 0);
  });
}

/** The page as the server lists it for this agent; a page it can't reach is not found. */
async function pageRef(ctx: ClientContext, pageId: PageId) {
  const info = await pages.loadPage(ctx, pageId);
  return { info, page: { spaceId: info.spaceId, pageId } };
}

type Heads = Awaited<ReturnType<typeof pages.loadPage>>['heads'];

const headsOf = ({ draftHead, publishedHead }: Heads) => ({ draftHead, publishedHead });

/*
 * The revision IDs a command is given are checked against the heads the
 * server lists before anything is opened. An ID from the wrong audience
 * would otherwise fail the audience check on opening, which reads as a
 * possible attack (exit 8) when it is only a mix-up: the commonest one is
 * passing the published `revisionId` that `page read` returns as `--base`.
 */

/** `id`, given as `option`, must be the draft head: a usage hint or a conflict otherwise. */
function requireDraftHead(heads: Heads, id: RevisionId, option: string): void {
  if (id === heads.draftHead) return;
  const detail = headsOf(heads);
  if (heads.draftHead === null) {
    throw new CliError('not-found', 'There is no draft this agent can edit', { detail });
  }
  if (id === heads.publishedHead) {
    throw new CliError(
      'usage',
      `That is the published version; ${option} takes the draft head, ${heads.draftHead}`,
      { detail },
    );
  }
  throw new CliError(
    'stale-head',
    `That is not the draft head; the page has moved on to ${heads.draftHead}`,
    { detail },
  );
}

/**
 * The draft a change builds on, `baseId`. A retry resends the first run's
 * change, whatever is built here, and its base may be gone: draft retention
 * keeps a draft only so long after a save on top of it, and a change whose
 * answer never came back may be retried any time. Then the draft head
 * stands in for it.
 */
async function openBase(agent: OpenedAgent, page: pages.PageRef, heads: Heads, baseId: RevisionId) {
  try {
    return await pages.openRevisionOf(agent.ctx, page, 'draft', baseId, { fresh: true });
  } catch (error) {
    const gone = error instanceof ApiError && error.code === 'not-found';
    if (!gone || !agent.journal.replaying || heads.draftHead === null) throw error;
    return pages.openRevisionOf(agent.ctx, page, 'draft', heads.draftHead, { fresh: true });
  }
}

/** `--base-published` must name the publication now on the page, or `none` if there is none. */
function requirePublishedHead(heads: Heads, id: RevisionId | null): void {
  if (id === heads.publishedHead) return;
  const detail = headsOf(heads);
  const now = heads.publishedHead ?? 'none';
  if (id !== null && id === heads.draftHead) {
    throw new CliError(
      'usage',
      `That is the draft head; --base-published takes the published head, ${now}`,
      { detail },
    );
  }
  throw new CliError('stale-head', `The page's published head is ${now}`, { detail });
}

/**
 * For `page read --revision` with an ID that is neither head: is it a
 * version of this page, in the audience asked for? This asks the server and
 * goes by its unchecked word, but only to choose a usage hint: nothing is
 * shown from it, and opening the revision checks everything as before.
 */
async function requireAudience(
  ctx: ClientContext,
  page: pages.PageRef,
  audience: 'draft' | 'published',
  id: RevisionId,
): Promise<void> {
  const { revisions } = await ctx.api.call(pageRoutes.fetchRevisions, { body: { ids: [id] } });
  const record = revisions.find((r) => r.revision.record.revisionId === id)?.revision.record;
  // Absent: opening it says it is not found.
  if (!record) return;
  if (record.pageId !== page.pageId) {
    throw new CliError('usage', 'That revision belongs to another page');
  }
  if (record.audience !== audience) {
    throw new CliError(
      'usage',
      audience === 'draft'
        ? 'That is a published version; leave out --draft'
        : 'That is a draft version; add --draft',
    );
  }
}

const current = (opened: OpenedRevision) => {
  if (opened.opened.kind !== 'current') {
    throw new CliError('failed', 'That version was written by a newer WikiStow; update the CLI');
  }
  return opened.opened.payload;
};

/** Which version `page read` and `page download-attachment` open. */
type VersionArgs = { pageId: PageId; draft: boolean; revisionId: RevisionId | null };

/**
 * The version a command names: the published head, or the draft head with
 * `--draft`, or `--revision` of that same kind, checked against the heads
 * but not yet opened.
 */
async function versionOf(
  ctx: ClientContext,
  { info, page }: Awaited<ReturnType<typeof pageRef>>,
  args: VersionArgs,
) {
  const audience = args.draft ? 'draft' : 'published';
  const own = args.draft ? info.heads.draftHead : info.heads.publishedHead;
  const other = args.draft ? info.heads.publishedHead : info.heads.draftHead;
  if (args.revisionId !== null && args.revisionId !== own) {
    if (args.revisionId === other) {
      throw new CliError(
        'usage',
        args.draft
          ? 'That is the published head; leave out --draft'
          : 'That is the draft head; add --draft',
        { detail: headsOf(info.heads) },
      );
    }
    await requireAudience(ctx, page, audience, args.revisionId);
  }
  const head = args.revisionId ?? own;
  if (head === null) {
    // The agent can see the page, so saying it is unpublished reveals nothing.
    if (!args.draft) throw new CliError('unpublished', 'The page has no published version yet');
    throw new CliError('not-found', 'There is no draft this agent can read');
  }
  return { audience, head } as const;
}

/** The version a command names (`versionOf`), opened and checked. */
async function openVersion(ctx: ClientContext, args: VersionArgs) {
  const ref = await pageRef(ctx, args.pageId);
  const { info, page } = ref;
  const { audience, head } = await versionOf(ctx, ref, args);
  const opened = await pages.openRevisionOf(ctx, page, audience, head);
  return { info, page, audience, opened, payload: current(opened) } as const;
}

/** `page read`: one version's title, Markdown and attachments. */
export async function readPage(io: Io, out: Printer, args: ContentArgs & VersionArgs, deps: Deps) {
  const read = await withAgent(io, out, args, deps, ({ ctx }) => openVersion(ctx, args));
  const { info, audience, opened, payload } = read;
  out.result(
    {
      pageId: info.pageId,
      spaceId: info.spaceId,
      parentId: info.parentId,
      audience,
      revisionId: opened.record.revisionId,
      authorId: opened.record.authorId,
      title: payload.title,
      markdown: payload.markdown,
      attachments: payload.attachments.map(({ id, name, mediaType, size }) => ({
        id,
        name,
        mediaType,
        size,
      })),
      heads: info.heads,
      permissionVersion: info.permissionVersion,
      role: info.role,
      canPublish: info.canPublish,
    },
    () => out.raw(payload.markdown),
  );
}

/**
 * The Markdown from `--file`: a path, or `-` for standard input. Strict
 * UTF-8, kept byte for byte, and refused (`PageTooLarge`) if a page can't
 * hold it, before anything reads its links, which takes longest then.
 */
async function readMarkdown(io: Io, file: string): Promise<string> {
  const bytes = await readInput(io, file);
  let markdown: string;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CliError('usage', 'The file is not UTF-8 text');
  }
  checkPayloadSize({ markdown });
  return markdown;
}

async function readInput(io: Io, file: string): Promise<Uint8Array> {
  if (file === '-') return io.readStdin();
  try {
    return new Uint8Array(readFileSync(file));
  } catch (cause) {
    throw new CliError('usage', `Can't read ${file}`, { cause });
  }
}

type LinkTargets = { links: Wikilink[] | null; tree: Tree | null };

/**
 * A change's wikilinks and the pages they resolve against, loaded before
 * the change is sent: once it has landed, nothing may fail and report it as
 * not done. The change's link table is worked out from the same tree. No
 * tree when there are no links to resolve; no links when the Markdown can't
 * be read for them (nested thousands deep, say), which is reported but
 * never stops the change.
 */
async function linkTargets(
  ctx: ClientContext,
  spaceId: SpaceId,
  markdown: string,
): Promise<LinkTargets> {
  let links: Wikilink[] | null;
  try {
    links = findWikilinks(markdown);
  } catch {
    links = null;
  }
  return {
    links,
    tree: links?.length ? await spaceOperations.loadTree(ctx, spaceId) : null,
  };
}

/**
 * The draft a change wrote, opened again: a save may have written pages'
 * new titles into its links (`writeLinks`), and a retry resends the first
 * run's draft. Null when it can't be opened now; the change has landed, so
 * that fails nothing. Opened only for a change with links to report.
 */
async function storedDraft(
  ctx: ClientContext,
  page: pages.PageRef,
  revisionId: RevisionId,
): Promise<PagePayload | null> {
  try {
    const { opened } = await pages.openRevisionOf(ctx, page, 'draft', revisionId);
    return opened.kind === 'current' ? opened.payload : null;
  } catch {
    return null;
  }
}

/**
 * How each of the stored draft's wikilinks resolves for this agent, as a
 * reader shows them: through the draft's link table to a page in its tree,
 * else by title among its tree's pages, with the page just written in place
 * of what the tree listed for it. Without the stored draft, the links sent
 * resolve by title. Null when they couldn't be read.
 */
function resolveLinks(
  { links, tree }: LinkTargets,
  stored: PagePayload | null,
  self: LinkablePage,
  attachments: readonly { id: string; name: string }[] = [],
): ResolvedLink[] | null {
  if (!links) return null;
  if (!tree) return [];
  let found = links;
  try {
    if (stored) found = findWikilinks(stored.markdown);
  } catch {
    return null;
  }
  const pages = [...tree.pages.filter((page) => page.id !== self.id), self];
  return resolveLinked(found, {
    pages: linkablePages({ folders: tree.folders, pages }),
    selfId: self.id,
    attachments,
    table: stored ? linkTableOf(stored) : new Map(),
  });
}

/** Each target text in `sent` that the stored draft names by another, once. */
const renamedIn = (sent: string, stored: PagePayload | null): RenamedLink[] =>
  stored ? renamedLinks(sent, stored.markdown) : [];

function printRenamed(out: Printer, renamed: readonly RenamedLink[]) {
  for (const { from, to } of renamed) {
    out.line(`  link [[${out.foreign(from)}]] now [[${out.foreign(to)}]]: its page was renamed`);
  }
}

/**
 * Each link for `--json`: a page link resolves to a `pageId`, an embed to an
 * `attachmentId`. Null when the links couldn't be read.
 */
const linkJson = (links: readonly ResolvedLink[] | null) =>
  links === null
    ? null
    : links.map(({ source, target, heading, shown, embed, status, targets }) => ({
        source,
        target,
        heading,
        shown,
        embed,
        status,
        ...(status === 'resolved' ? { [embed ? 'attachmentId' : 'pageId']: targets[0] } : {}),
        ...(status === 'ambiguous' ? { candidates: targets } : {}),
      }));

function printLinks(out: Printer, links: readonly ResolvedLink[] | null) {
  if (!links) out.line('  links couldn’t be read');
  for (const link of links ?? []) {
    const where =
      link.status === 'resolved'
        ? ` -> ${link.targets[0]}`
        : link.status === 'ambiguous'
          ? ` (one of ${link.targets.join(', ')})`
          : '';
    out.line(`  link ${out.foreign(link.source)}: ${link.status}${where}`);
  }
}

/**
 * The answer to the change this command sent, from the journal: on a
 * retry with an idempotency key it is the first run's answer, which names
 * the IDs that run made.
 */
function answered(agent: OpenedAgent): Record<string, unknown> {
  const answer = agent.journal.sent?.answer;
  if (typeof answer !== 'object' || answer === null) {
    throw new CliError('failed', 'The server’s answer to the change was not kept');
  }
  return answer as Record<string, unknown>;
}

/** Which space a folder this agent can see is in, from the trees it can see. */
export async function spaceOfFolder(ctx: ClientContext, folderId: FolderId): Promise<SpaceId> {
  const spaceIds = new Set(
    (await sharingOperations.sharedWithMe(ctx)).map((item) => item.share.spaceId),
  );
  for (const spaceId of spaceIds) {
    const { folders } = await ctx.api.call(structureRoutes.tree, { params: { spaceId } });
    if (folders.some((folder) => folder.id === folderId)) return spaceId;
  }
  throw new ApiError(404, 'not-found', 'No such folder');
}

/** `page create`: a new page with its first draft, in a folder this agent was given. */
export async function createPage(
  io: Io,
  out: Printer,
  args: ContentArgs & { folderId: FolderId; spaceId: SpaceId | null; title: string; file: string },
  deps: Deps,
) {
  const markdown = await readMarkdown(io, args.file);
  const input = inputHash('page create', [args.folderId, args.spaceId, args.title, markdown]);
  const made = await withAgent(
    io,
    out,
    args,
    deps,
    async (agent) => {
      const { ctx } = agent;
      const spaceId = args.spaceId ?? (await spaceOfFolder(ctx, args.folderId));
      const targets = await linkTargets(ctx, spaceId, markdown);
      await pages.createPage(ctx, {
        spaceId,
        parentId: args.folderId,
        title: args.title,
        markdown,
        ...(targets.tree ? { tree: targets.tree } : {}),
      });
      const answer = answered(agent);
      const pageId = answer.pageId as PageId;
      const revisionId = answer.revisionId as RevisionId;
      const stored = targets.tree ? await storedDraft(ctx, { spaceId, pageId }, revisionId) : null;
      const self = { id: pageId, title: args.title, parentId: args.folderId };
      return {
        spaceId,
        pageId,
        revisionId,
        links: resolveLinks(targets, stored, self),
        renamed: renamedIn(markdown, stored),
      };
    },
    input,
  );
  out.result({ ...made, links: linkJson(made.links) }, () => {
    out.line(`Created page ${made.pageId}, draft ${made.revisionId}`);
    printLinks(out, made.links);
    printRenamed(out, made.renamed);
  });
}

/** `page draft --base`: a new draft on top of `base`, which must still be the draft head. */
export async function draftPage(
  io: Io,
  out: Printer,
  args: ContentArgs & { pageId: PageId; base: RevisionId; file: string; title: string | null },
  deps: Deps,
) {
  const markdown = await readMarkdown(io, args.file);
  const input = inputHash('page draft', [args.pageId, args.base, args.title, markdown]);
  const saved = await withAgent(
    io,
    out,
    args,
    deps,
    async (agent) => {
      const { ctx } = agent;
      const { info, page } = await pageRef(ctx, args.pageId);
      // A retry resends the first run's change, which may have moved the heads on.
      if (!agent.journal.replaying) requireDraftHead(info.heads, args.base, '--base');
      const base = await openBase(agent, page, info.heads, args.base);
      const payload = revisePayload(base.opened, {
        markdown,
        ...(args.title === null ? {} : { title: args.title }),
      });
      const targets = await linkTargets(ctx, page.spaceId, markdown);
      await pages.saveDraft(ctx, {
        page,
        basedOn: args.base,
        basedOnRegion: base.region,
        payload,
        ...(targets.tree ? { tree: targets.tree } : {}),
      });
      const revisionId = answered(agent).revisionId as RevisionId;
      const stored = targets.tree ? await storedDraft(ctx, page, revisionId) : null;
      const self = {
        id: page.pageId,
        title: stored?.title ?? payload.title,
        parentId: info.parentId,
      };
      return {
        spaceId: page.spaceId,
        pageId: page.pageId,
        revisionId,
        basedOn: args.base,
        links: resolveLinks(targets, stored, self, stored?.attachments ?? payload.attachments),
        renamed: renamedIn(markdown, stored),
      };
    },
    input,
  );
  out.result({ ...saved, links: linkJson(saved.links) }, () => {
    out.line(`Saved draft ${saved.revisionId} of page ${saved.pageId}`);
    printLinks(out, saved.links);
    printRenamed(out, saved.renamed);
  });
}

/**
 * `page publish --revision --base-published`: publish exactly that draft
 * over exactly that publication. With `--permission-version`, only to the
 * readers the agent saw: the server refuses if who can read it changed.
 */
export async function publishPage(
  io: Io,
  out: Printer,
  args: ContentArgs & {
    pageId: PageId;
    revisionId: RevisionId;
    basePublished: RevisionId | null;
    permissionVersion: number | null;
  },
  deps: Deps,
) {
  const { permissionVersion } = args;
  const input = inputHash('page publish', [
    args.pageId,
    args.revisionId,
    args.basePublished,
    // Only when given, so a key used before the option existed still matches.
    ...(permissionVersion === null ? [] : [String(permissionVersion)]),
  ]);
  const published = await withAgent(
    io,
    out,
    args,
    deps,
    async (agent) => {
      const { ctx } = agent;
      const { info, page } = await pageRef(ctx, args.pageId);
      if (!agent.journal.replaying) {
        requireDraftHead(info.heads, args.revisionId, '--revision');
        requirePublishedHead(info.heads, args.basePublished);
      }
      await pages.publishPage(ctx, page, {
        expected: {
          draftHead: args.revisionId,
          publishedHead: args.basePublished,
          ...(permissionVersion === null ? {} : { permissionVersion }),
        },
      });
      return {
        pageId: page.pageId,
        revisionId: answered(agent).revisionId as RevisionId,
        publishedFrom: args.revisionId,
      };
    },
    input,
  );
  out.result(published, () =>
    out.line(
      `Published ${published.revisionId} of page ${published.pageId} from draft ${published.publishedFrom}`,
    ),
  );
}

/**
 * Run `change`, the one request a command that names the state it changes
 * sends: one whose answer was lost is safe to run again as it was (`again`).
 */
async function changing<T>(change: () => Promise<T>): Promise<T> {
  try {
    return await change();
  } catch (error) {
    if (outcomeUnknown(error)) throw new ChangeMayHaveHappened(error, 'again');
    throw error;
  }
}

/**
 * `page unpublish --base-published`: hide exactly that publication from
 * readers (protocol section 11). The server refuses an agent unless its
 * grant and its person both may publish there.
 */
export async function unpublishPage(
  io: Io,
  out: Printer,
  args: ContentArgs & { pageId: PageId; basePublished: RevisionId },
  deps: Deps,
) {
  await withAgent(io, out, args, deps, async ({ ctx }) => {
    const { info, page } = await pageRef(ctx, args.pageId);
    // With none published, the server tells whether it was that publication
    // that was unpublished last, as by a first run whose answer was lost:
    // then it is done, and that is no error.
    if (info.heads.publishedHead !== null || args.basePublished === info.heads.draftHead) {
      requirePublishedHead(info.heads, args.basePublished);
    }
    await changing(() =>
      pages.unpublishPage(ctx, page, {
        publishedHead: args.basePublished,
        permissionVersion: info.permissionVersion,
      }),
    );
  });
  out.result({ pageId: args.pageId, unpublished: args.basePublished }, () => {
    out.line(`Unpublished ${args.basePublished} of page ${args.pageId}`);
    out.line(
      '  Readers keep what they already read or downloaded, and copies published to other spaces stay there',
    );
  });
}

/** Which of the version's attachments `page publish-to` copies: all, none, or these. */
export type AttachmentPick = 'all' | 'none' | readonly AttachmentId[];

/**
 * `page publish-to`'s own arguments. `send` is null for `--preview`, which
 * sends nothing. Its `permissionVersion`, when given, is the one a preview
 * showed: the copy goes only to the readers there the agent saw.
 */
type PublishToArgs = ContentArgs &
  VersionArgs & {
    revisionId: RevisionId;
    spaceId: SpaceId;
    folderId: FolderId | null;
    send: {
      baseCopy: RevisionId | null;
      attachments: AttachmentPick;
      permissionVersion: number | null;
    } | null;
  };

const attachmentJson = ({ id, name, mediaType, size }: AttachmentRef) => ({
  id,
  name,
  mediaType,
  size,
});

/** The attachments `pick` names, each one the version must list. */
function pickAttachments(listed: readonly AttachmentRef[], pick: AttachmentPick): AttachmentRef[] {
  if (pick === 'all') return [...listed];
  if (pick === 'none') return [];
  for (const id of pick) {
    if (!listed.some((ref) => ref.id === id)) {
      throw new CliError('not-found', `That version lists no attachment ${id}`);
    }
  }
  return listed.filter((ref) => pick.includes(ref.id));
}

/**
 * Whether the copy's published head says it is a copy of the very version
 * being published, with its title and text: perhaps made by an earlier run
 * of the same command, whose answer was lost. Only a hint for the agent,
 * since anyone who publishes there can write any source into it.
 */
async function copiesThisVersion(
  ctx: ClientContext,
  { destination, sourceRevisionId, sourceAudience, title, opened: version }: PublicationPreview,
): Promise<boolean> {
  if (destination.state !== 'existing' || destination.publishedHead === null) return false;
  const copy = { spaceId: destination.spaceId, pageId: destination.pageId };
  try {
    const { opened } = await pages.openRevisionOf(
      ctx,
      copy,
      'published',
      destination.publishedHead,
    );
    if (opened.kind !== 'current') return false;
    const source = publications.provenanceOf(opened.payload);
    // A copy holds the source's text with any broken character repaired.
    const { value: sent } = repairText({ title, markdown: current(version).markdown });
    return (
      source?.sourceRevisionId === sourceRevisionId &&
      source.sourceAudience === sourceAudience &&
      opened.payload.title === sent.title &&
      opened.payload.markdown === sent.markdown
    );
  } catch (error) {
    if (error instanceof ApiError || error instanceof CryptoError) return false;
    throw error;
  }
}

/**
 * What `--base-copy` names: the copy's published head there, or for a copy
 * unpublished there its latest publication, which the next one goes on
 * from, or null when there is no copy there yet.
 */
async function copyBase(
  ctx: ClientContext,
  destination: PublicationPreview['destination'],
): Promise<RevisionId | null> {
  if (destination.state !== 'existing' || destination.publishedHead !== null) {
    return destination.publishedHead;
  }
  const copy = { spaceId: destination.spaceId, pageId: destination.pageId };
  const [latest] = await pages.loadHistory(ctx, copy);
  return latest?.revisionId ?? null;
}

/**
 * `--base-copy` must name the copy's base there (`copyBase`), or `none`
 * for no copy yet, and `--folder` the folder it is in, since a copy takes
 * the next version where it is. So a copy someone published since the
 * agent looked, a copy elsewhere in the space it didn't know of, or its
 * own first run's copy whose answer was lost, is never published to unseen.
 */
async function requireCopy(
  ctx: ClientContext,
  preview: PublicationPreview,
  base: RevisionId | null,
  given: { baseCopy: RevisionId | null; folderId: FolderId | null },
): Promise<void> {
  const { destination } = preview;
  if (given.baseCopy === base && given.folderId === destination.parentId) return;
  const sameVersion = await copiesThisVersion(ctx, preview);
  const detail = {
    pageId: destination.state === 'new' ? null : destination.pageId,
    parentId: destination.parentId,
    publishedHead: destination.publishedHead,
    baseCopy: base,
    sameVersion,
  };
  const folder = destination.parentId ? `--folder ${destination.parentId}` : 'no --folder';
  const now =
    base === null
      ? 'There is no copy there yet: give --base-copy none'
      : `The copy there is page ${destination.pageId}: give --base-copy ${base} and ${folder}`;
  throw new CliError(
    'stale-head',
    sameVersion ? `${now}. Its published head is a copy of this same version already` : now,
    { detail },
  );
}

/**
 * `page publish-to`: copy one version of a page, with the attachments
 * picked, into another space as a published version there (protocol
 * section 13), or with `--preview`, say what that would do. The server
 * refuses an agent unless its grants and its person both may publish at
 * the source and where the copy goes (section 9.5).
 */
export async function publishTo(io: Io, out: Printer, args: PublishToArgs, deps: Deps) {
  const done = await withAgent(io, out, args, deps, async ({ ctx }) => {
    const ref = await pageRef(ctx, args.pageId);
    if (args.spaceId === ref.page.spaceId) {
      throw new CliError('usage', 'That is the page’s own space; page publish publishes it there');
    }
    const { audience, head } = await versionOf(ctx, ref, args);
    let preview: PublicationPreview;
    try {
      preview = await publications.previewPublication(ctx, {
        source: ref.page,
        revisionId: head,
        audience,
        spaceId: args.spaceId,
        parentId: args.folderId,
      });
    } catch (error) {
      if (!(error instanceof publications.PublishedElsewhere)) throw error;
      throw new CliError(
        'published-elsewhere',
        'This page is already published into that space, somewhere this agent can’t publish. ' +
          'Someone who can publish the page can end that copy’s link to it in WikiStow, then ' +
          'publish it there again',
      );
    }
    const base = await copyBase(ctx, preview.destination);
    if (!args.send) return { preview, base, picked: null, sent: null };
    await requireCopy(ctx, preview, base, { ...args.send, folderId: args.folderId });
    const picked = pickAttachments(preview.attachments, args.send.attachments);
    const { permissionVersion } = args.send;
    const seen =
      permissionVersion === null
        ? preview
        : { ...preview, destination: { ...preview.destination, permissionVersion } };
    const sent = await changing(() =>
      publications.publishToSpace(ctx, {
        preview: seen,
        attachmentIds: new Set(picked.map((a) => a.id)),
      }),
    );
    return { preview, base, picked, sent };
  });
  const { preview, base, picked, sent } = done;
  const { destination } = preview;
  const source = {
    spaceId: preview.source.spaceId,
    pageId: preview.source.pageId,
    revisionId: preview.sourceRevisionId,
    audience: preview.sourceAudience,
  };
  const where = `space ${destination.spaceId}${destination.parentId ? `, folder ${destination.parentId}` : ''}`;
  const printLinks = () => {
    if (preview.links === null) out.line('  links couldn’t be read, so some may not open there');
    else if (preview.links.length > 0) out.line('  links readers there may not be able to open:');
    for (const link of preview.links ?? []) {
      const count = link.count > 1 ? ` (${link.count} links)` : '';
      out.line(`    ${out.foreign(link.text)}${count}`);
    }
  };
  if (!sent) {
    out.result(
      {
        preview: true,
        source,
        spaceId: destination.spaceId,
        pageId: destination.state === 'new' ? null : destination.pageId,
        parentId: destination.parentId,
        state: destination.state,
        publishedHead: destination.publishedHead,
        baseCopy: base,
        permissionVersion: destination.permissionVersion,
        region: preview.audience.region,
        attachments: preview.attachments.map(attachmentJson),
        links: preview.links,
      },
      () => {
        const to =
          destination.state === 'existing'
            ? `its copy there, page ${destination.pageId}, in ${where}`
            : `a new page in ${where}`;
        const version = source.audience === 'draft' ? 'draft' : 'published version';
        out.line(`Would publish the ${version} ${source.revisionId} to ${to}`);
        out.line(
          preview.audience.region === 'owner'
            ? '  read there by the space’s owners'
            : '  read there by the members of the share it is in',
        );
        for (const a of preview.attachments) {
          out.line(`  attachment ${a.id}  ${out.foreign(a.name)}`);
        }
        printLinks();
        out.line('  Copies can’t be recalled: anyone who can read it there can keep it');
        const folder = destination.parentId ? ` --folder ${destination.parentId}` : '';
        out.line(
          `  to publish:${folder} --base-copy ${base ?? 'none'} ` +
            `--permission-version ${destination.permissionVersion} --attachments all|none|ID,...`,
        );
      },
    );
    return;
  }
  out.result(
    {
      source,
      spaceId: destination.spaceId,
      pageId: sent.pageId,
      parentId: destination.parentId,
      state: destination.state,
      revisionId: sent.revisionId,
      attachments: (picked ?? []).map(attachmentJson),
      links: preview.links,
    },
    () => {
      out.line(`Published ${sent.revisionId} to page ${sent.pageId} in ${where}`);
      for (const a of picked ?? []) out.line(`  attachment ${out.foreign(a.name)} copied`);
      printLinks();
      out.line('  Copies can’t be recalled: anyone who can read it there can keep it');
    },
  );
}

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

/** An attachment as `page attach` reports it, and journals it for a retry to report. */
const Attached = z.strictObject({
  id: AttachmentId,
  name: z.string(),
  mediaType: z.string(),
  size: z.number().int().nonnegative(),
});
type Attached = z.infer<typeof Attached>;

/** What `page attach` journals: its file, and whether its draft's links were left as they were. */
const AttachNote = z.strictObject({ attachment: Attached, linksKept: z.boolean() });
type AttachNote = z.infer<typeof AttachNote>;

/**
 * The note a retry reports from. A CLI from before the link table noted
 * only the file: its draft left the links as they were, unchecked.
 */
const KeptNote = z.union([
  AttachNote,
  Attached.transform((attachment): AttachNote => ({ attachment, linksKept: true })),
]);

function keptNote(note: string | null): AttachNote {
  let kept: AttachNote | null = null;
  try {
    kept = note === null ? null : KeptNote.parse(JSON.parse(note));
  } catch {
    // Reported below, as for no note at all.
  }
  if (!kept) {
    throw new CliError(
      'state-unreadable',
      'The journal kept no attachment for that idempotency key; check the page before using a new key',
    );
  }
  return kept;
}

/**
 * The tree `page attach` works its draft's links out from, loaded before the
 * change goes out so the journal can note whether it loaded. None when the
 * Markdown has no page links. One that can't be loaded fails nothing: a tree
 * listing no page stands in, so the links are left as they were.
 */
async function attachTree(
  ctx: ClientContext,
  spaceId: SpaceId,
  markdown: string,
): Promise<{ tree: LinkTree | null; linksKept: boolean }> {
  let linked: boolean;
  try {
    linked = findWikilinks(markdown).some((link) => !link.embed && link.target !== '');
  } catch {
    linked = false;
  }
  if (!linked) return { tree: null, linksKept: false };
  try {
    return { tree: await spaceOperations.loadTree(ctx, spaceId), linksKept: false };
  } catch (error) {
    if (!(error instanceof ApiError || error instanceof CryptoError)) throw error;
    return { tree: { shares: [], folders: [], pages: [] }, linksKept: true };
  }
}

/** `page attach`: encrypt and upload a file, and list it on a new draft. */
export async function attachFile(
  io: Io,
  out: Printer,
  args: ContentArgs & {
    pageId: PageId;
    file: string;
    name: string | null;
    mediaType: string | null;
    base: RevisionId | null;
  },
  deps: Deps,
) {
  const name = args.name ?? (args.file === '-' ? null : basename(args.file));
  if (!name) throw new CliError('usage', 'Give --name for a file read from standard input');
  const bytes = await readInput(io, args.file);
  const mediaType =
    args.mediaType ?? MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
  const input = inputHash('page attach', [args.pageId, args.base, name, mediaType, bytes]);
  const saved = await withAgent(
    io,
    out,
    args,
    deps,
    async (agent) => {
      const { ctx } = agent;
      const { info, page } = await pageRef(ctx, args.pageId);
      const baseId = args.base ?? info.heads.draftHead;
      if (baseId === null) throw new CliError('not-found', 'There is no draft this agent can edit');
      if (!agent.journal.replaying) requireDraftHead(info.heads, baseId, '--base');
      const base = await openBase(agent, page, info.heads, baseId);
      let attachments = current(base).attachments;
      let attachment: Attached;
      let linksKept: boolean;
      let tree: LinkTree | null = null;
      if (agent.journal.replaying) {
        // The draft that goes out is the first run's, listing the file that
        // run uploaded, with its links as that run left them: report those,
        // and upload nothing.
        ({ attachment, linksKept } = keptNote(agent.journal.note));
      } else {
        // A page saved larger than the limit, before it, can't take the file.
        checkPayloadSize(withoutLinkTable(current(base)));
        const ref = await pages.uploadAttachment(ctx, page, { name, mediaType, bytes });
        attachment = { id: ref.id, name: ref.name, mediaType: ref.mediaType, size: ref.size };
        attachments = [...attachments, ref];
        ({ tree, linksKept } = await attachTree(ctx, page.spaceId, current(base).markdown));
        agent.journal.setNote(JSON.stringify({ attachment, linksKept } satisfies AttachNote));
      }
      const payload = revisePayload(base.opened, { attachments });
      await pages.saveDraft(ctx, {
        page,
        basedOn: baseId,
        basedOnRegion: base.region,
        payload,
        ...(tree ? { tree } : {}),
      });
      const revisionId = answered(agent).revisionId as RevisionId;
      // As for page draft, the save may have written pages' new titles into links.
      const stored = payload.markdown.includes('[[')
        ? await storedDraft(ctx, page, revisionId)
        : null;
      return {
        pageId: page.pageId,
        revisionId,
        attachment,
        renamed: renamedIn(payload.markdown, stored),
        linksKept,
      };
    },
    input,
  );
  out.result(saved, () => {
    out.line(
      `Attached ${out.foreign(saved.attachment.name)} as ${saved.attachment.id}; draft ${saved.revisionId}`,
    );
    printRenamed(out, saved.renamed);
    if (saved.linksKept) {
      out.line('  links left as they were, not checked against the space’s tree');
    }
  });
}

/**
 * `page download-attachment`: one attachment of a version, decrypted, to a
 * new file or to standard output. A file that exists is never overwritten.
 */
export async function downloadAttachment(
  io: Io,
  out: Printer,
  args: ContentArgs & VersionArgs & { attachmentId: AttachmentId; out: string },
  deps: Deps,
) {
  if (args.out === '-' && out.json) {
    throw new CliError('usage', 'With --out -, the file is the output: leave out --json');
  }
  if (args.out === '-' && io.stdout.isTTY) {
    throw new CliError('usage', 'Standard output is a terminal: give --out a file to write');
  }
  const got = await withAgent(io, out, args, deps, async ({ ctx }) => {
    const { page, audience, opened, payload } = await openVersion(ctx, args);
    const ref = payload.attachments.find((a) => a.id === args.attachmentId);
    if (!ref) throw new CliError('not-found', 'That version lists no such attachment');
    const bytes = await pages.readAttachment(ctx, page, audience, ref);
    return { revisionId: opened.record.revisionId, ref, bytes };
  });
  const { ref, bytes } = got;
  if (args.out === '-') {
    await io.writeStdout(bytes);
    // The file is the output, so a warning has only standard error to go to.
    if (out.warning) out.failure(out.warning);
    return;
  }
  writeNewFile(args.out, bytes);
  const attachment = { id: ref.id, name: ref.name, mediaType: ref.mediaType, size: ref.size };
  out.result({ pageId: args.pageId, revisionId: got.revisionId, attachment, out: args.out }, () =>
    out.line(`Saved ${out.foreign(ref.name)} (${bytes.length} bytes) to ${args.out}`),
  );
}

/**
 * Write `bytes` to a new file at `path`, mode 600, never one that exists
 * or a link's target. A write that fails partway leaves no part behind,
 * so a retry isn't refused for a file that exists already.
 */
function writeNewFile(path: string, bytes: Uint8Array): void {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (cause) {
    const exists = (cause as NodeJS.ErrnoException).code === 'EEXIST';
    throw new CliError('usage', exists ? `${path} exists already` : `Can't write ${path}`, {
      cause,
    });
  }
  try {
    try {
      writeFileSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    rmSync(path, { force: true });
    throw new CliError('failed', `Writing ${path} failed, so it was removed`, { cause });
  }
}

/** `page history`: published versions, newest first, and who published each. */
export async function pageHistory(
  io: Io,
  out: Printer,
  args: ContentArgs & { pageId: PageId },
  deps: Deps,
) {
  const versions = await withAgent(io, out, args, deps, async ({ ctx }) => {
    const { page } = await pageRef(ctx, args.pageId);
    return pages.loadHistory(ctx, page);
  });
  const listed = versions.map(({ revisionId, publishedSeq, publishedAt, basedOn, publisher }) => ({
    revisionId,
    publishedSeq,
    publishedAt,
    basedOn,
    publisher,
  }));
  out.result({ pageId: args.pageId, versions: listed }, () => {
    for (const v of listed) {
      const by = v.publisher.agentName
        ? `${out.foreign(v.publisher.agentName)} (for ${out.foreign(v.publisher.name ?? 'someone')})`
        : out.foreign(v.publisher.name ?? v.publisher.identityId);
      out.line(`v${v.publishedSeq}  ${v.revisionId}  ${out.foreign(v.publishedAt)}  ${by}`);
    }
  });
}
