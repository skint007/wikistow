import {
  commentOperations,
  CryptoError,
  isAgentId,
  MAX_COMMENT_TEXT,
  scalarCount,
  linkablePages,
  type Audience,
  type ClientContext,
  type CommentQuote,
  type IdentityId,
  type QuoteText,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Check, ChevronRight, MessageSquare, MoreHorizontal, RotateCcw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { AgentName, agentPersonName } from '../agents/agent-name';
import { ago } from '../agents/model';
import { useWide } from '../ai/chat-column';
import { historyQuery, treeQuery } from '../data/queries';
import { errorMessage, stopMessage } from '../errors';
import { useOwnerStanding } from '../sharing/owner-standing';
import { peopleQuery } from '../sharing/people';
import { NEEDS_CONNECTION, useNeedsConnection } from '../shell/availability';
import { isApple } from '../shell/search-model';
import { PLAIN, useClient } from '../vault/store';
import { CommentText } from './comment-text';
import {
  audienceOfView,
  authorOf,
  shownAuthor,
  boxLabel,
  canComment,
  canDelete,
  canEdit,
  canReply,
  canResolve,
  commentsBadge,
  ordered,
  pillOf,
  quoteOf,
  type Viewer,
} from './model';
import type { Passages } from './passages';
import { commentsChanged, pageCommentsQuery } from './queries';
import {
  commentsStore,
  unsentKey,
  useCommentsStore,
  usePassagesStore,
  type CommentsPage,
} from './store';

type Thread = commentOperations.ShownThread;
type Comment = commentOperations.ShownComment;

/** Whether the comments panel takes a column beside the page now, in the chat's place. */
export function useCommentsColumn(): boolean {
  const { open, page } = useCommentsStore();
  return useWide() && open && page !== null;
}

/**
 * The page's comments while the panel is open (ADR 0014, decision 13): a
 * 380px card beside the page on windows 1200px and wider, otherwise a
 * sheet from the right, the whole width on phones.
 */
export function CommentsColumn() {
  const { open, page } = useCommentsStore();
  const wide = useWide();
  if (!open || !page) return null;
  const close = () => commentsStore.close();
  if (wide)
    return <CommentsPanel key={`${page.pageId} ${page.view}`} page={page} onClose={close} />;
  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        side="right"
        dialogClassName="max-[599px]:w-screen max-[599px]:max-w-none"
        className="h-full p-0"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Comments</DialogTitle>
        <CommentsPanel key={`${page.pageId} ${page.view}`} page={page} onClose={close} />
      </DialogContent>
    </Dialog>
  );
}

// What a refusal means here, in the panel's words.
function commentMessage(error: unknown): string {
  if (error instanceof CryptoError) {
    return stopMessage(error) ?? 'Something went wrong, so nothing was sent. Try again.';
  }
  if (error instanceof ApiError) {
    if (error.code === 'stale-head') return 'It changed meanwhile. Look again, then try again.';
    if (error.code === 'forbidden' || error.code === 'not-found')
      return 'You can’t do that here now. The page or your access may have changed.';
    if (error.code === 'payload-too-large') return 'That comment is too long.';
  }
  return errorMessage(error);
}

/** The page's threads, a box for a new comment, and New comments. */
function CommentsPanel({ page, onClose }: { page: CommentsPage; onClose: () => void }) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const needs = useNeedsConnection();
  const owner = useOwnerStanding(page.spaceId) === 'owner';
  const { showing, quotes, composing } = useCommentsStore();
  const { passages, read } = usePassagesStore();
  const viewer: Viewer = {
    me: ctx.identity.public.id,
    agents: new Set(ctx.contacts.book.payloads.shared.agents.map((a) => a.enrollment.agent.id)),
    view: page.view,
    editor: page.editor,
    owner,
    published: page.published,
  };
  const options = pageCommentsQuery(ctx, page, { offline: needs.offline });
  const query = useQuery(options);
  const threads = query.data?.threads;
  // Where the version on screen is, as its comments were checked against it.
  const region = query.data?.region ?? page.region;
  // Opening the page's comments marks them seen, on every device; so does
  // anything new arriving while they're open. The button reads the same
  // answer, so it is told at once, up to the newest comment it holds.
  const fresh = query.data
    ? commentsBadge(query.data.threads, { me: viewer.me, seenAt: query.data.seenAt }).fresh
    : false;
  const marked = useRef(false);
  const { queryKey } = options;
  useEffect(() => {
    if (!query.isSuccess || (marked.current && !fresh)) return;
    marked.current = true;
    void commentOperations
      .markSeen(ctx, page.pageId)
      .then(() => {
        queryClient.setQueryData(queryKey, (old) => old && { ...old, seenAt: newestOf(old) });
        return queryClient.invalidateQueries({ queryKey: [PLAIN, 'new-comments'] });
      })
      .catch(() => {});
  }, [ctx, queryClient, queryKey, page.pageId, query.isSuccess, fresh]);
  const { data: tree } = useQuery(treeQuery(ctx, page.spaceId));
  const pages = useMemo(() => (tree ? linkablePages(tree) : null), [tree]);
  const authors = useMemo(
    () =>
      [
        ...new Set(
          (threads ?? [])
            .flatMap((t) => [t.first, ...t.replies])
            .map(shownAuthor)
            .filter((id): id is IdentityId => id !== null),
        ),
      ].sort(),
    [threads],
  );
  const names = useAuthorNames(ctx, authors);
  // Where each thread's passage is in the page on screen, as its text is now:
  // null where it isn't there, undefined where that can't be told.
  const found = useMemo(() => {
    void read;
    const at = new Map<string, number | null | undefined>();
    for (const thread of threads ?? []) {
      const quote = quoteOf(thread);
      if (quote) at.set(thread.thread, passages ? passages.find(quote) : undefined);
    }
    return at;
  }, [threads, passages, read]);
  const { open, resolved } = ordered(threads ?? [], (t) => found.get(t.thread) ?? null);
  const newKey = unsentKey(page, 'new');
  const quote = quotes.get(newKey) ?? null;
  const [dropped, setDropped] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  // A thread New comments named comes into view, unfolded if resolved.
  useEffect(() => {
    if (!showing || !threads) return;
    if (resolved.some((t) => t.thread === showing)) setUnfolded(true);
    requestAnimationFrame(() => {
      document.getElementById(threadElementId(showing))?.scrollIntoView({ block: 'nearest' });
      commentsStore.shown();
    });
  }, [showing, threads, resolved]);
  const changed = () => commentsChanged(queryClient, [page.pageId]);
  const shared = {
    page: { ...page, region },
    viewer,
    names,
    pages,
    passages,
    onChanged: changed,
  };
  const count = threads ? commentsBadge(threads, { me: viewer.me, seenAt: null }).count : null;
  const gone = query.error instanceof ApiError && query.error.code === 'not-found';

  return (
    <aside
      aria-label="Comments"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-card bg-card shadow-card"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <MessageSquare className="size-4 text-primary" strokeWidth={1.75} />
        <h2 className="flex-1 font-extrabold">
          Comments
          {count !== null && count > 0 && (
            <span className="font-bold text-subtle-foreground"> · {count}</span>
          )}
        </h2>
        <button
          type="button"
          aria-label="Close comments"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-control hover:tint active:tint-strong"
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3">
        {needs.offline ? (
          <p className="p-1 text-sm text-muted-foreground">{NEEDS_CONNECTION}</p>
        ) : gone ? (
          <p className="p-1 text-sm text-muted-foreground">
            {/* A server from before comments, or a page unpublished or deleted meanwhile (decision 11). */}
            This page’s comments can’t be shown. If you can still read the page, this server needs
            an update for comments.
          </p>
        ) : (
          <>
            {canComment(viewer) && (
              <CommentBox
                key={newKey}
                unsent={newKey}
                label={boxLabel(audienceOfView(page.view), 'comment')}
                action="Comment"
                rows={2}
                focus={composing}
                autoFocus={quote !== null}
                quote={
                  quote && (
                    <div className="flex items-start gap-1">
                      <QuoteShown quote={quote} className="flex-1" />
                      <button
                        type="button"
                        aria-label="Comment on the page instead"
                        data-hint="Comment on the page instead"
                        onClick={() => commentsStore.dropQuote(newKey)}
                        className="grid size-6 shrink-0 place-items-center rounded-control hover:tint active:tint-strong"
                      >
                        <X className="size-3.5" strokeWidth={1.75} />
                      </button>
                    </div>
                  )
                }
                send={async (text) => {
                  if (!region) throw new Error('The page is still opening');
                  setDropped(false);
                  let withoutQuote = false;
                  await commentOperations.addComment(
                    ctx,
                    { spaceId: page.spaceId, pageId: page.pageId, region, version: page.version },
                    {
                      audience: audienceOfView(page.view),
                      text,
                      // Only this page and view's own, chosen here (decision 13).
                      quote: quote ?? undefined,
                      onQuoteDropped: () => (withoutQuote = true),
                    },
                  );
                  commentsStore.dropQuote(newKey);
                  setDropped(withoutQuote);
                  changed();
                }}
              />
            )}
            {dropped && (
              <p role="status" className="text-sm text-muted-foreground">
                Sent without its passage: readers can’t see the version it was chosen in now.
              </p>
            )}
            {query.error && !gone && (
              <p role="alert" className="text-sm text-destructive">
                {commentMessage(query.error)}
              </p>
            )}
            {threads?.length === 0 && (
              <p className="p-1 text-sm text-muted-foreground">No comments yet.</p>
            )}
            {open.map((thread) => (
              <ThreadCard
                key={thread.thread}
                thread={thread}
                at={found.get(thread.thread)}
                {...shared}
              />
            ))}
            {resolved.length > 0 && (
              <button
                type="button"
                aria-expanded={unfolded}
                onClick={() => setUnfolded((was) => !was)}
                className="flex items-center gap-1 rounded-control px-1 py-1 text-sm font-bold text-subtle-foreground hover:tint"
              >
                <ChevronRight
                  className={cn('size-4 transition-transform', unfolded && 'rotate-90')}
                  strokeWidth={1.75}
                />
                {resolved.length} resolved
              </button>
            )}
            {unfolded &&
              resolved.map((thread) => (
                <ThreadCard
                  key={thread.thread}
                  thread={thread}
                  at={found.get(thread.thread)}
                  {...shared}
                />
              ))}
          </>
        )}
        <Link
          to="/comments"
          className="justify-self-start px-1 text-sm font-bold text-primary hover:underline"
        >
          New comments ›
        </Link>
      </div>
    </aside>
  );
}

export const threadElementId = (thread: string) => `comment-thread-${thread}`;

// The time of the newest comment shown, or the seen time if that is later.
function newestOf({ threads, seenAt }: { threads: readonly Thread[]; seenAt: string | null }) {
  const times = threads.flatMap((t) => [t.first, ...t.replies]).map((c) => c.createdAt);
  return [...times, ...(seenAt ? [seenAt] : [])].reduce<string | null>(
    (newest, time) => (newest === null || Date.parse(time) > Date.parse(newest) ? time : newest),
    null,
  );
}

/** How each author is named: their label, or "agent (for person)" (decision 4). */
type Names = (id: IdentityId) => ReactNode;

function useAuthorNames(ctx: ClientContext, ids: readonly IdentityId[]): Names {
  const { data: people } = useQuery(peopleQuery(ctx, ids));
  const { data: agents } = useQuery({
    queryKey: [PLAIN, 'comment-agents', ...ids.filter(isAgentId)],
    queryFn: () => commentOperations.agentAuthors(ctx, ids),
    enabled: ids.some(isAgentId),
  });
  return (id) => {
    const agent = agents?.get(id);
    if (agent) {
      const person = agent.personId && people?.get(agent.personId);
      return (
        <AgentName
          ctx={ctx}
          agentId={id}
          serverName={agent.name}
          person={agentPersonName(ctx, agent.personId, person ? person.name : null)}
        />
      );
    }
    const person = people?.get(id);
    return <Name>{person?.name ?? '…'}</Name>;
  };
}

type Shared = {
  page: CommentsPage;
  viewer: Viewer;
  names: Names;
  pages: Parameters<typeof CommentText>[0]['pages'];
  /** Where the page on screen shows its text, for passages. */
  passages: Passages | null;
  onChanged: () => void;
};

/** A passage's text, dimmed, as a comment's quote shows it. */
function QuoteShown({ quote, className }: { quote: QuoteText; className?: string }) {
  return (
    <blockquote
      className={cn(
        'line-clamp-3 border-s-2 ps-2 text-sm whitespace-pre-line text-subtle-foreground',
        className,
      )}
    >
      “{quote.exact}”
    </blockquote>
  );
}

/**
 * A thread's passage (decision 5): its quote, and where the page on screen
 * no longer has it, saying so, with the version it was chosen in for
 * anyone who can open that. In the draft view, **Show** selects it in the
 * editor.
 */
function ThreadQuote({
  quote,
  at,
  page,
  passages,
}: {
  quote: CommentQuote;
  at: number | null | undefined;
  page: CommentsPage;
  passages: Passages | null;
}) {
  const ctx = useClient();
  const wide = useWide();
  const gone = at === null;
  const { data: versions } = useQuery({
    ...historyQuery(ctx, { spaceId: page.spaceId, pageId: page.pageId }),
    enabled: gone,
  });
  // The page's history is checked against each version's signed record,
  // so one it lists is of this page.
  const made = versions?.find((v) => v.revisionId === quote.revisionId);
  return (
    <div className="grid gap-1">
      <QuoteShown quote={quote} />
      {gone && (
        <p className="text-xs text-subtle-foreground">
          This passage isn’t in the page now.
          {made && (
            <>
              {' '}
              <Link
                to="/s/$spaceId/p/$pageId"
                params={{ spaceId: page.spaceId, pageId: page.pageId }}
                search={{ view: 'published', rev: made.revisionId }}
                className="font-bold text-primary hover:underline"
              >
                Made on version {made.publishedSeq}
              </Link>
            </>
          )}
        </p>
      )}
      {page.view === 'draft' && typeof at === 'number' && passages && (
        <button
          type="button"
          onClick={() => {
            if (wide) {
              passages.show(quote);
              return;
            }
            // On a narrow window the sheet covers the editor: it steps aside
            // first, and the passage is selected once it has gone.
            commentsStore.close();
            requestAnimationFrame(() => requestAnimationFrame(() => passages.show(quote)));
          }}
          className="justify-self-start rounded-control px-1 text-sm font-bold text-subtle-foreground hover:text-foreground hover:underline"
        >
          Show
        </button>
      )}
    </div>
  );
}

/** One thread: its pill, its first comment and replies, Resolve, and Reply…. */
function ThreadCard({
  thread,
  at,
  ...shared
}: {
  thread: Thread;
  /** Where its passage is in the page on screen, if it has one (`found`). */
  at: number | null | undefined;
} & Shared) {
  const ctx = useClient();
  const { page, viewer, passages, onChanged } = shared;
  const quote = quoteOf(thread);
  const [replying, setReplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pill = pillOf(thread, viewer);
  const first = thread.first.state;
  const resolve = async (resolved: boolean) => {
    setError(null);
    try {
      await commentOperations.resolveThread(ctx, thread.thread, resolved);
      onChanged();
    } catch (caught) {
      setError(commentMessage(caught));
    }
  };
  return (
    <article
      id={threadElementId(thread.thread)}
      aria-label="Thread"
      className={cn(
        'grid gap-2 rounded-control border bg-background/60 p-3',
        thread.resolved && 'opacity-80',
      )}
    >
      {(pill || thread.beforeUnpublish) && (
        <div className="flex flex-wrap gap-1.5 text-xs font-bold">
          {pill && (
            <span
              className="rounded-full bg-muted px-2 py-0.5 text-subtle-foreground"
              data-hint={
                pill === 'Editors'
                  ? 'Only editors see this thread'
                  : 'Everyone who reads this page sees this thread'
              }
            >
              {pill}
            </span>
          )}
          {thread.beforeUnpublish && (
            <span className="text-subtle-foreground">From before the page was unpublished</span>
          )}
        </div>
      )}
      {quote && <ThreadQuote quote={quote} at={at} page={page} passages={passages} />}
      <CommentItem
        comment={thread.first}
        audience={thread.audience}
        {...shared}
        resolve={
          canResolve(thread, viewer)
            ? { resolved: thread.resolved !== null, onResolve: (r) => void resolve(r) }
            : null
        }
      />
      {thread.replies.length > 0 && (
        <div className="grid gap-2 border-s-2 ps-3">
          {thread.replies.map((reply) => (
            <CommentItem
              key={reply.commentId}
              comment={reply}
              audience={thread.audience}
              {...shared}
              resolve={null}
            />
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {canReply(thread, viewer) &&
        first.kind === 'opened' &&
        (replying ? (
          <CommentBox
            unsent={unsentKey(page, `reply ${thread.thread}`)}
            label={boxLabel(thread.audience, 'reply')}
            action="Reply"
            rows={1}
            autoFocus
            onCancel={() => setReplying(false)}
            send={async (text) => {
              if (!page.region) throw new Error('The page is still opening');
              await commentOperations.addComment(
                ctx,
                {
                  spaceId: page.spaceId,
                  pageId: page.pageId,
                  region: page.region,
                  version: page.version,
                },
                {
                  // A reply takes its thread's audience, from its first comment as opened.
                  audience: first.payload.audience,
                  text,
                  reply: { thread: thread.thread, threadAuthor: first.authorId },
                },
              );
              setReplying(false);
              onChanged();
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="justify-self-start rounded-control px-1 text-sm font-bold text-subtle-foreground hover:text-foreground hover:underline"
          >
            Reply…
          </button>
        ))}
    </article>
  );
}

/** One comment: who wrote it and when, its text, its menu, and for a first comment Resolve. */
function CommentItem({
  comment,
  audience,
  page,
  viewer,
  names,
  pages,
  onChanged,
  resolve,
}: {
  comment: Comment;
  audience: Audience;
  resolve: { resolved: boolean; onResolve: (resolved: boolean) => void } | null;
} & Shared) {
  const ctx = useClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { state } = comment;
  const author = authorOf(comment);
  const signed = shownAuthor(comment);
  const mayEdit = canEdit(comment, viewer);
  const mayDelete = canDelete(comment, viewer);
  const remove = async () => {
    setError(null);
    try {
      await commentOperations.deleteComment(ctx, comment.commentId);
      onChanged();
    } catch (caught) {
      setError(commentMessage(caught));
    }
  };
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-1.5 text-xs text-subtle-foreground">
        <span className="min-w-0 truncate font-bold text-foreground">
          {author === null ? 'Comment deleted' : signed === null ? 'Someone' : names(signed)}
        </span>
        {author !== null && <span>· {ago(comment.createdAt, new Date())}</span>}
        {(state.kind === 'opened' || state.kind === 'newer-format') && state.edited && (
          <span>· edited</span>
        )}
        <span className="flex-1" />
        {resolve && (
          <button
            type="button"
            aria-label={resolve.resolved ? 'Open again' : 'Resolve'}
            data-hint={resolve.resolved ? 'Open again' : 'Resolve'}
            onClick={() => resolve.onResolve(!resolve.resolved)}
            className="grid size-6 place-items-center rounded-control hover:tint active:tint-strong"
          >
            {resolve.resolved ? (
              <RotateCcw className="size-3.5" strokeWidth={1.75} />
            ) : (
              <Check className="size-3.5" strokeWidth={2} />
            )}
          </button>
        )}
        {(mayEdit || mayDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Comment actions"
              className="grid size-6 place-items-center rounded-control hover:tint active:tint-strong"
            >
              <MoreHorizontal className="size-3.5" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mayEdit && (
                <DropdownMenuItem onSelect={() => setEditing(true)}>Edit</DropdownMenuItem>
              )}
              {mayDelete && (
                <DropdownMenuItem variant="destructive" onSelect={() => void remove()}>
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {state.kind === 'opened' &&
        (editing ? (
          <CommentBox
            unsent={unsentKey(page, `edit ${comment.commentId}`)}
            initial={state.payload.text}
            label={boxLabel(audience, 'comment')}
            action="Save"
            rows={2}
            autoFocus
            onCancel={() => setEditing(false)}
            send={async (text) => {
              await commentOperations.editComment(
                ctx,
                { ...page, region: page.region ?? state.region },
                { commentId: comment.commentId, state },
                text,
              );
              setEditing(false);
              onChanged();
            }}
          />
        ) : (
          <CommentText
            text={state.payload.text}
            spaceId={page.spaceId}
            pageId={page.pageId}
            pages={pages}
          />
        ))}
      {state.kind === 'newer-format' && (
        <p className="text-sm text-muted-foreground">Update the app to read this comment.</p>
      )}
      {state.kind === 'unreadable' && (
        <p className="text-sm text-muted-foreground">This comment can’t be opened.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A box for a comment, a reply or an edit, saying whom it is for. It
 * offers no link, title or property completion (decision 13), and keeps
 * what is typed for its page, view and box only (`unsent`), in memory.
 * The button, or Ctrl+Enter (Cmd+Enter on a Mac), sends it.
 */
function CommentBox({
  unsent,
  initial = '',
  label,
  action,
  rows,
  autoFocus = false,
  focus,
  quote,
  onCancel,
  send,
}: {
  unsent: string;
  initial?: string;
  label: string;
  action: string;
  rows: number;
  autoFocus?: boolean;
  /** Changes whenever the box should take the focus, as after a passage is chosen. */
  focus?: number;
  /** The passage it comments on, above it. */
  quote?: ReactNode;
  onCancel?: () => void;
  send: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(() => commentsStore.unsent(unsent) || initial);
  const box = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(focus);
  useEffect(() => {
    if (focus === focused.current) return;
    focused.current = focus;
    box.current?.focus();
  }, [focus]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (next: string) => {
    setText(next);
    commentsStore.setUnsent(unsent, next === initial ? '' : next);
  };
  const empty = text.trim() === '';
  const submit = async () => {
    if (empty || busy) return;
    if (scalarCount(text) > MAX_COMMENT_TEXT) {
      setError(
        `That’s too long: a comment holds at most ${MAX_COMMENT_TEXT.toLocaleString()} characters.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await send(text);
      commentsStore.setUnsent(unsent, '');
      setText('');
    } catch (caught) {
      setError(commentMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {quote}
      <textarea
        ref={box}
        aria-label={label}
        placeholder={label}
        value={text}
        rows={rows}
        autoFocus={autoFocus}
        autoComplete="off"
        maxLength={20_000}
        disabled={busy}
        onChange={(event) => change(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && onCancel) {
            event.preventDefault();
            onCancel();
          }
          const mod = isApple() ? event.metaKey : event.ctrlKey;
          if (event.key === 'Enter' && mod && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        className="max-h-60 min-h-9 w-full resize-y rounded-control border border-input bg-background px-3 py-2 text-base outline-ring focus-visible:outline-2 md:text-sm"
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={empty || busy}>
          {action}
        </Button>
      </div>
    </form>
  );
}
