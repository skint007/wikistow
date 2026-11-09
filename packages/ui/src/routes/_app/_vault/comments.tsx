import {
  commentOperations,
  type IdentityId,
  type OpenedMetadata,
  type SpaceId,
} from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { MessageSquare } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Name, plainText } from '@/components/name';
import { AgentName, agentPersonName } from '../../../agents/agent-name';
import { ago } from '../../../agents/model';
import { shownAuthor } from '../../../comments/model';
import { newCommentsQuery } from '../../../comments/queries';
import { spacesQuery, treeQuery } from '../../../data/queries';
import { errorMessage } from '../../../errors';
import { peopleQuery } from '../../../sharing/people';
import { NEEDS_CONNECTION, useNeedsConnection } from '../../../shell/availability';
import { pageTitle } from '../../../shell/sidebar';
import { PLAIN, useClient } from '../../../vault/store';

export const Route = createFileRoute('/_app/_vault/comments')({ component: NewComments });

type Row = commentOperations.NewComment;

// A space's name, where this person can open it.
const spaceName = (metadata: { opened: OpenedMetadata } | null | undefined) =>
  metadata?.opened.kind === 'current' ? metadata.opened.metadata.name : null;

/** A comment's first line, as its row shows it. */
function firstLine(comment: Row['latest']): string {
  const { state } = comment;
  if (state.kind === 'opened') return state.payload.text.trim().split('\n')[0] ?? '';
  if (state.kind === 'newer-format') return 'Update the app to read this comment.';
  if (state.kind === 'unreadable') return 'This comment can’t be opened.';
  return 'Comment deleted';
}

/**
 * New comments (ADR 0014, decision 8): threads with a comment this person
 * hasn't seen, from someone else, that concern them, grouped by space,
 * newest first. Each row opens the page with its thread, in the view of
 * the thread's audience; opening it marks the page's comments seen.
 */
function NewComments() {
  const ctx = useClient();
  const needs = useNeedsConnection();
  const { data: rows, error } = useQuery({ ...newCommentsQuery(ctx), enabled: !needs.offline });
  const { data: spaces } = useQuery(spacesQuery(ctx));
  const bySpace = Map.groupBy(rows ?? [], (row) => row.spaceId);
  const authors = useMemo(
    () =>
      [
        ...new Set(
          (rows ?? [])
            .map((row) => shownAuthor(row.latest))
            .filter((id): id is IdentityId => id !== null),
        ),
      ].sort(),
    [rows],
  );
  const { data: people } = useQuery(peopleQuery(ctx, authors));
  const { data: agents } = useQuery({
    queryKey: [PLAIN, 'comment-agents', ...authors],
    queryFn: () => commentOperations.agentAuthors(ctx, authors),
    enabled: authors.length > 0,
  });
  const nameOf = (id: IdentityId | null) => {
    if (id === null) return 'Someone';
    const agent = agents?.get(id);
    if (agent) {
      const person = agent.personId && people?.get(agent.personId);
      return (
        <AgentName
          ctx={ctx}
          agentId={id}
          serverName={agent.name}
          person={agentPersonName(ctx, agent.personId, person ? person.name : null)}
          brief
        />
      );
    }
    return <Name>{people?.get(id)?.name ?? '…'}</Name>;
  };

  return (
    <section className="h-full min-h-0 overflow-y-auto rounded-card bg-card shadow-card">
      <div className="mx-auto grid w-full max-w-[720px] gap-6 px-11 py-10 max-[899px]:px-[18px] max-[899px]:py-8">
        <header className="grid gap-1">
          <h1 className="text-[32px] leading-tight font-extrabold">New comments</h1>
          <p className="text-sm text-muted-foreground">
            Comments you haven’t seen on threads you started or replied to, and new threads on pages
            you can edit.
          </p>
        </header>
        {needs.offline && <p className="text-sm text-muted-foreground">{NEEDS_CONNECTION}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(error)}
          </p>
        )}
        {rows?.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing new. You’re up to date.</p>
        )}
        {[...bySpace].map(([spaceId, inSpace]) => (
          <SpaceRows
            key={spaceId}
            spaceId={spaceId}
            rows={inSpace}
            ownName={spaceName(spaces?.find((space) => space.id === spaceId)?.metadata)}
            nameOf={nameOf}
          />
        ))}
      </div>
    </section>
  );
}

function SpaceRows({
  spaceId,
  rows,
  ownName,
  nameOf,
}: {
  spaceId: SpaceId;
  rows: Row[];
  ownName: string | null;
  nameOf: (id: IdentityId | null) => ReactNode;
}) {
  const ctx = useClient();
  // A space shared only in part has no name this person can open: its tree's, if any.
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const name = spaceName(tree?.space?.metadata) ?? ownName ?? 'Shared with you';
  return (
    <section aria-label={plainText(name)} className="grid gap-2">
      <h2 className="truncate text-lg font-extrabold">
        <Name>{name}</Name>
      </h2>
      <ul className="grid gap-1">
        {rows.map((row) => (
          <li key={row.thread}>
            <Link
              to="/s/$spaceId/p/$pageId"
              params={{ spaceId: row.spaceId, pageId: row.pageId }}
              search={{
                ...(row.audience === 'draft' ? { view: 'draft' as const } : {}),
                thread: row.thread,
              }}
              className="flex items-start gap-3 rounded-control px-3 py-2 hover:tint active:tint-strong"
            >
              <MessageSquare className="mt-1 size-4 shrink-0 text-primary" strokeWidth={1.75} />
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-bold">
                    <Name>{pageTitle(row.title)}</Name>
                  </span>
                  {row.count > 1 && (
                    <span className="shrink-0 text-xs text-subtle-foreground">{row.count} new</span>
                  )}
                </span>
                <span className="truncate text-xs text-subtle-foreground">
                  {nameOf(shownAuthor(row.latest))} · {ago(row.latest.createdAt, new Date())}
                  {row.audience === 'draft' && ' · Editors'}
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {firstLine(row.latest)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
