import type { Audience, commentOperations, IdentityId } from '@wikistow/client';

type Thread = commentOperations.ShownThread;
type Comment = commentOperations.ShownComment;

/** Who is looking, and at which view of the page (ADR 0014, decisions 1 and 6). */
export type Viewer = {
  me: IdentityId;
  /** This person's own agents, from their contacts record: their comments count as theirs (decision 6). */
  agents: ReadonlySet<string>;
  view: 'draft' | 'published';
  /** Can edit the page: reads comments for editors, and resolves any thread. */
  editor: boolean;
  /** An owner of the space: deletes any comment. */
  owner: boolean;
  /** The page is published now: comments for readers need it. */
  published: boolean;
};

/** The audience a view writes to: readers from the published view, editors from the draft. */
export const audienceOfView = (view: Viewer['view']): Audience =>
  view === 'published' ? 'published' : 'draft';

/** What a box says it writes to, so nobody has to choose (decision 1). */
export const boxLabel = (audience: Audience, kind: 'comment' | 'reply') => {
  const to = audience === 'published' ? 'everyone who reads this page' : 'editors';
  return `${kind === 'comment' ? 'Comment' : 'Reply'} for ${to}`;
};

/** Whether this person can start a thread here: for readers only while the page is published. */
export const canComment = (viewer: Viewer) =>
  viewer.view === 'published' ? viewer.published : viewer.editor;

/** A comment's author as signed, or for one that didn't open, the server's word; none for a deleted one. */
export const authorOf = (comment: Comment): IdentityId | null =>
  comment.state.kind === 'deleted' ? null : comment.state.authorId;

/** Whom a comment is shown by: its signed author, never the server's word for one that didn't open. */
export const shownAuthor = (comment: Comment): IdentityId | null =>
  comment.state.kind === 'opened' || comment.state.kind === 'newer-format'
    ? comment.state.authorId
    : null;

// Signed by this person or one of their own agents, so theirs to resolve
// or delete (decision 6).
const signedBy = (comment: Comment, { me, agents }: Viewer) =>
  (comment.state.kind === 'opened' || comment.state.kind === 'newer-format') &&
  (comment.state.authorId === me || agents.has(comment.state.authorId));

/** The pill on a thread whose audience isn't the view's (decision 1), or null. */
export const pillOf = (thread: Thread, viewer: Viewer): 'Editors' | 'Readers' | null =>
  thread.audience === audienceOfView(viewer.view)
    ? null
    : thread.audience === 'draft'
      ? 'Editors'
      : 'Readers';

/**
 * Whether the thread takes a reply from this person: its first comment
 * opened, so the reply takes its audience and author from it (decision
 * 1); not deleted; and for readers, the page published and the thread
 * started since its latest unpublish.
 */
export const canReply = (thread: Thread, viewer: Viewer) =>
  thread.first.state.kind === 'opened' &&
  !thread.beforeUnpublish &&
  (thread.audience === 'draft' ? viewer.editor : viewer.published);

/** The thread's starter, as signed, or anyone who can edit the page, resolves it (decision 6). */
export const canResolve = (thread: Thread, viewer: Viewer) =>
  viewer.editor || signedBy(thread.first, viewer);

/** Only a comment's author edits it, one this app opened in a format it writes. */
export const canEdit = (comment: Comment, viewer: Viewer) =>
  comment.state.kind === 'opened' && comment.state.authorId === viewer.me;

/** Its author, and the space's owners, delete a comment; owners even one that didn't open. */
export const canDelete = (comment: Comment, viewer: Viewer) =>
  comment.state.kind !== 'deleted' && (viewer.owner || signedBy(comment, viewer));

// The server's times have milliseconds or not, so they compare as instants.
const time = (iso: string) => Date.parse(iso);

/** The passage a thread's first comment is on, as it opened, if any (decision 5). */
export const quoteOf = (thread: Thread) =>
  thread.first.state.kind === 'opened' ? (thread.first.state.payload.quote ?? null) : null;

/**
 * Open threads in the order of their passages in the page (`at`, where
 * each is found), then those on the whole page and those whose passage
 * isn't found, oldest first; then the resolved ones (decision 6). Ages go
 * by the server's times.
 */
export function ordered(
  threads: readonly Thread[],
  at: (thread: Thread) => number | null = () => null,
) {
  const byAge = [...threads].sort((a, b) => time(a.first.createdAt) - time(b.first.createdAt));
  const open = byAge.filter((t) => t.resolved === null);
  const placed = open.flatMap((thread) => {
    const offset = at(thread);
    return offset === null ? [] : [{ thread, offset }];
  });
  // Stable, so threads on one passage stay oldest first.
  placed.sort((a, b) => a.offset - b.offset);
  const onPage = open.filter((t) => !placed.some((p) => p.thread === t));
  return {
    open: [...placed.map((p) => p.thread), ...onPage],
    resolved: byAge.filter((t) => t.resolved !== null),
  };
}

/**
 * What the Comments button shows (decision 8): how many open threads this
 * person sees, and whether any has a comment from someone else since they
 * last opened the page's comments.
 */
export function commentsBadge(
  threads: readonly Thread[],
  { me, seenAt }: { me: IdentityId; seenAt: string | null },
) {
  const fresh = threads.some((t) =>
    [t.first, ...t.replies].some((c) => {
      const author = authorOf(c);
      return (
        author !== null && author !== me && (seenAt === null || time(c.createdAt) > time(seenAt))
      );
    }),
  );
  return { count: threads.filter((t) => t.resolved === null).length, fresh };
}

/** "3 open", as the button's name says it. */
export const countLabel = (count: number) =>
  count === 0 ? 'Comments' : `Comments, ${count} open${count === 1 ? ' thread' : ' threads'}`;
