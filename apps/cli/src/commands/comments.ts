// `wikistow page comments` and `page comment` (ADR 0014, decision 10): a
// page's threads, and a comment added as this agent. A comment for readers
// reaches everyone who reads the page, so `--for` is always given, and the
// server lets an agent write one only where it may publish.
import {
  ApiError,
  commentOperations as comments,
  isAgentId,
  lookupPeople,
  MAX_COMMENT_TEXT,
  outcomeUnknown,
  pageOperations as pages,
  scalarCount,
  type ClientContext,
} from '@wikistow/client';
import type { Audience, CommentId, IdentityId, PageId } from '@wikistow/contracts';
import { ChangeMayHaveHappened, CliError } from '../exit.ts';
import type { Io, Printer } from '../io.ts';
import type { Deps } from './agent.ts';
import { withAgent, type ContentArgs } from './content.ts';

type Thread = comments.ShownThread;
type Comment = comments.ShownComment;

/** Whom a comment is for, as `--for` names it: readers or editors. */
export type CommentsFor = 'readers' | 'editors';

const AUDIENCE = { readers: 'published', editors: 'draft' } as const satisfies Record<
  CommentsFor,
  Audience
>;

const forOf = (audience: Audience): CommentsFor =>
  audience === 'published' ? 'readers' : 'editors';

/**
 * The page, with the version a comment for `audience` is checked against
 * and written in (decision 4): the publication for readers, the draft for
 * editors. Without an audience, the draft where this agent edits the page,
 * else the publication. Refused before anything is sent where the page has
 * no such version, or the agent may not write there (the server's word,
 * which only picks the message: the server refuses it anyway).
 */
async function openPage(
  ctx: ClientContext,
  pageId: PageId,
  audience: Audience | null,
  { reply = false } = {},
) {
  const info = await pages.loadPage(ctx, pageId);
  const page = { spaceId: info.spaceId, pageId };
  // A reader is listed no draft head.
  const kind = audience ?? (info.heads.draftHead === null ? 'published' : 'draft');
  const head = kind === 'draft' ? info.heads.draftHead : info.heads.publishedHead;
  if (head === null) {
    if (kind === 'published') {
      throw new CliError(
        'unpublished',
        'The page isn’t published, so it has no readers to comment for',
      );
    }
    throw new CliError(
      'forbidden',
      'This agent only reads this page, so it can’t comment for editors',
    );
  }
  if (audience === 'published' && !info.canPublish) {
    // A reply's audience is its thread's, so --for editors is no way out for one.
    throw new CliError(
      'forbidden',
      reply
        ? 'This agent can’t reply in a thread for readers: it comments for readers only where it may publish, and its person too'
        : 'This agent comments for readers only where it may publish, and its person too: use --for editors',
    );
  }
  const opened = await pages.openRevisionOf(ctx, page, kind, head);
  return {
    info,
    page: { ...page, region: opened.region, version: { revisionId: head, audience: kind } },
  };
}

/**
 * A comments route's `not-found` for a page this agent opened just now,
 * said plainly: the server has no comments yet (decision 11).
 */
const olderServer = (error: unknown) =>
  error instanceof ApiError && error.code === 'not-found'
    ? new CliError('failed', 'This server needs an update for comments', { cause: error })
    : error;

/** The page's threads, or the server's lack of comments said plainly. */
async function threadsOf(ctx: ClientContext, page: comments.CommentPage) {
  try {
    return await comments.pageComments(ctx, page);
  } catch (error) {
    throw olderServer(error);
  }
}

/** A comment's author as signed, or none for one that didn't open or was deleted. */
const signedAuthor = ({ state }: Comment): IdentityId | null =>
  state.kind === 'opened' || state.kind === 'newer-format' ? state.authorId : null;

/**
 * Each author by name, as `page history` names publishers: the server's
 * name for a person, and for an agent its name and its person's, kept only
 * when the agent's pinned keys make its ID with that person as owner.
 */
async function authorsOf(ctx: ClientContext, ids: readonly IdentityId[]) {
  const agents = await comments.agentAuthors(ctx, ids);
  const people = [
    ...ids.filter((id) => !isAgentId(id)),
    ...[...agents.values()].flatMap(({ personId }) => (personId ? [personId] : [])),
  ];
  const names = new Map(
    people.length === 0
      ? []
      : (await lookupPeople(ctx, people)).map((entry) => [entry.identity.id, entry.name]),
  );
  return (identityId: IdentityId) => {
    const agent = agents.get(identityId);
    if (!agent) {
      return { identityId, name: names.get(identityId) ?? null, agentName: null, personId: null };
    }
    const { personId } = agent;
    const name = personId ? (names.get(personId) ?? null) : null;
    return { identityId, name, agentName: agent.name, personId };
  };
}

type Author = ReturnType<Awaited<ReturnType<typeof authorsOf>>>;

const commentJson = (comment: Comment, authorOf: (id: IdentityId) => Author) => {
  const { state } = comment;
  const author = signedAuthor(comment);
  const opened = state.kind === 'opened' ? state.payload : null;
  return {
    commentId: comment.commentId,
    state: state.kind,
    ...(state.kind === 'unreadable' ? { problem: state.error.code } : {}),
    author: author && authorOf(author),
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    edited: state.kind === 'opened' || state.kind === 'newer-format' ? state.edited : false,
    quote: opened?.quote
      ? {
          revisionId: opened.quote.revisionId,
          exact: opened.quote.exact,
          prefix: opened.quote.prefix,
          suffix: opened.quote.suffix,
        }
      : null,
    text: opened?.text ?? null,
  };
};

// The server's times have milliseconds or not, so they compare as instants.
const age = (thread: Thread) => Date.parse(thread.first.createdAt);

/**
 * `page comments`: the page's threads this agent can read, open ones then
 * resolved ones, each oldest first (decision 6), every comment opened and
 * checked against the page's version this agent reads.
 */
export async function listComments(
  io: Io,
  out: Printer,
  args: ContentArgs & { pageId: PageId },
  deps: Deps,
) {
  const listed = await withAgent(io, out, args, deps, async ({ ctx }) => {
    const { page } = await openPage(ctx, args.pageId, null);
    const { threads } = await threadsOf(ctx, page);
    const ids = threads
      .flatMap((t) => [t.first, ...t.replies])
      .flatMap((c) => {
        const author = signedAuthor(c);
        return author ? [author] : [];
      });
    const authorOf = await authorsOf(ctx, [...new Set(ids)]);
    const byAge = [...threads].sort((a, b) => age(a) - age(b));
    return [
      ...byAge.filter((t) => t.resolved === null),
      ...byAge.filter((t) => t.resolved !== null),
    ].map((t) => ({
      thread: t.thread,
      for: forOf(t.audience),
      resolved: t.resolved,
      beforeUnpublish: t.beforeUnpublish,
      comments: [t.first, ...t.replies].map((c) => commentJson(c, authorOf)),
    }));
  });
  out.result({ pageId: args.pageId, threads: listed }, () => {
    if (listed.length === 0) out.note('No comments this agent can read.');
    const named = (author: Author | null) => {
      if (!author) return 'unknown author';
      if (author.agentName === null) return out.foreign(author.name ?? author.identityId);
      return `${out.foreign(author.agentName)} (for ${out.foreign(author.name ?? 'someone')})`;
    };
    for (const thread of listed) {
      const marks = [
        `for ${thread.for}`,
        ...(thread.resolved ? ['resolved'] : []),
        ...(thread.beforeUnpublish ? ['from before the page was unpublished'] : []),
      ];
      out.line(`Thread ${thread.thread}  ${marks.join('  ')}`);
      const [first] = thread.comments;
      if (first?.quote) out.line(`  "${out.foreign(first.quote.exact)}"`);
      for (const comment of thread.comments) {
        const edited = comment.edited ? '  edited' : '';
        out.line(
          `  ${comment.commentId}  ${named(comment.author)}  ${out.foreign(comment.createdAt)}${edited}`,
        );
        const text =
          comment.text ??
          {
            opened: '',
            deleted: 'Comment deleted',
            'newer-format': 'Update the CLI to read this comment',
            unreadable: 'This comment can’t be opened',
          }[comment.state];
        for (const line of text.split(/\r?\n/)) out.line(`    ${out.foreign(line)}`);
      }
    }
  });
}

/** `--text`: 1 to 10,000 characters of well-formed text, not blank (section 5.9). */
export function commentTextOf(text: string): string {
  const count = scalarCount(text);
  if (text.trim() === '' || count > MAX_COMMENT_TEXT) {
    throw new CliError('usage', `--text takes a comment of 1 to ${MAX_COMMENT_TEXT} characters`);
  }
  if (!text.isWellFormed()) throw new CliError('usage', '--text is not well-formed text');
  return text;
}

/**
 * The thread `replyTo` names, whose first comment this agent opened, so
 * the reply takes its audience and signed author from it (decision 1),
 * and which takes replies: for `audience`, not deleted, and not from
 * before the page's latest unpublish.
 */
function threadToAnswer(threads: readonly Thread[], replyTo: CommentId, audience: Audience) {
  const thread = threads.find((t) => t.thread === replyTo);
  if (!thread) {
    const within = threads.find((t) => t.replies.some((r) => r.commentId === replyTo));
    if (within) {
      throw new CliError(
        'usage',
        `That is a reply; --reply-to takes its thread's first comment, ${within.thread}`,
        { detail: { thread: within.thread } },
      );
    }
    throw new CliError('not-found', 'This page has no thread that this agent can read by that ID');
  }
  const { state } = thread.first;
  if (state.kind === 'deleted') {
    throw new CliError(
      'forbidden',
      'That thread’s first comment was deleted, so it takes no replies',
    );
  }
  if (state.kind === 'newer-format') {
    throw new CliError('failed', 'That thread was started by a newer WikiStow; update the CLI');
  }
  if (state.kind === 'unreadable') {
    throw new CliError(
      'failed',
      'That thread’s first comment can’t be opened, so it takes no reply',
    );
  }
  // Its audience as this agent opened it, never the server's word alone.
  const { payload } = state;
  if (payload.audience !== audience) {
    const now = forOf(payload.audience);
    throw new CliError(
      'usage',
      `That thread is for ${now}, and a reply goes to its thread's audience: give --for ${now}`,
      { detail: { for: now } },
    );
  }
  if (thread.beforeUnpublish) {
    throw new CliError(
      'forbidden',
      'That thread was started before the page was last unpublished, so it takes no replies',
    );
  }
  return { thread: thread.thread, threadAuthor: state.authorId };
}

/**
 * `page comment --text --for [--reply-to]`: a comment on the page, or a
 * reply to a thread, as this agent, for readers only where it may publish.
 */
export async function addComment(
  io: Io,
  out: Printer,
  args: ContentArgs & {
    pageId: PageId;
    text: string;
    for: CommentsFor;
    replyTo: CommentId | null;
  },
  deps: Deps,
) {
  const audience = AUDIENCE[args.for];
  const added = await withAgent(io, out, args, deps, async ({ ctx }) => {
    const opened = await openPage(ctx, args.pageId, audience, { reply: args.replyTo !== null });
    let { page } = opened;
    let reply = null;
    if (args.replyTo !== null) {
      const { threads, region } = await threadsOf(ctx, page);
      page = { ...page, region };
      reply = threadToAnswer(threads, args.replyTo, audience);
    }
    try {
      const commentId = await comments.addComment(ctx, page, { audience, text: args.text, reply });
      return { commentId, thread: reply?.thread ?? null };
    } catch (error) {
      // Sent again with the same IDs, it found no answer: it may have landed.
      if (outcomeUnknown(error)) throw new ChangeMayHaveHappened(error, 'comment');
      // A reply's thread was just listed, so the route is there: not-found is about the thread.
      throw reply === null ? olderServer(error) : error;
    }
  });
  const result = { pageId: args.pageId, ...added, for: args.for };
  out.result(result, () =>
    out.line(
      added.thread === null
        ? `Added comment ${added.commentId} for ${args.for} on page ${args.pageId}`
        : `Replied with comment ${added.commentId} for ${args.for} in thread ${added.thread}`,
    ),
  );
}
