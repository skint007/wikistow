// Notes of a live session (ADR 0015 decision 8): a draft saved from
// outside while people edited was folded in, and the parts of it that
// overlapped theirs wait for Review. Names come from the pinned labels and
// the agent directory, never from anything sent in the session.
import {
  commentOperations,
  isAgentId,
  type ClientContext,
  type IdentityId,
  type pageMerge,
} from '@wikistow/client';
import type { LiveNote, OpenedNote } from '@wikistow/client/live';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { agentPersonName } from '../../agents/model';
import { peopleQuery } from '../../sharing/people';
import { PLAIN } from '../../vault/store';
import type { DraftSession } from '../draft-session';
import type { Theirs } from '../merge/merge-model';

/** How a note names who wrote its draft: a person, or a person's agent. */
export function useNoteNames(
  ctx: ClientContext,
  notes: readonly LiveNote[],
): (note: LiveNote) => string {
  const ids = [...new Set(notes.flatMap((note) => (note.by ? [note.by] : [])))];
  const agentIds = ids.filter(isAgentId);
  const { data: agents } = useQuery({
    queryKey: [PLAIN, 'live-note-agents', ...agentIds],
    queryFn: () => commentOperations.agentAuthors(ctx, agentIds),
    enabled: agentIds.length > 0,
  });
  const personIds = [
    ...ids.filter((id) => !isAgentId(id)),
    ...[...(agents?.values() ?? [])].flatMap((agent) => (agent.personId ? [agent.personId] : [])),
  ];
  const { data: people } = useQuery({
    ...peopleQuery(ctx, personIds),
    enabled: personIds.length > 0,
  });
  const personName = (id: IdentityId) => {
    if (id === ctx.identity.public.id) return 'You';
    const person = people?.get(id);
    return person && !person.nameless ? person.name : null;
  };
  return (note) => {
    if (!note.by) return 'Someone';
    if (!isAgentId(note.by)) return personName(note.by) ?? 'Someone';
    const agent = agents?.get(note.by);
    const owner = agent?.personId ?? null;
    if (owner === ctx.identity.public.id) return 'Your agent';
    const person = agentPersonName(ctx, owner, owner ? personName(owner) : null);
    return person ? `${person.name}’s agent` : 'An agent';
  };
}

const changes = (count: number) => (count === 1 ? '1 change overlaps' : `${count} changes overlap`);

/** What a note says, in this app's words. */
export function noteText(note: LiveNote, who: string): string {
  const count = note.parts.length;
  if (note.carried) {
    return `${count === 1 ? 'A change' : `${count} changes`} saved from outside the live page ${
      count === 1 ? 'waits' : 'wait'
    } for review, kept by ${who === 'You' ? 'you' : who}.`;
  }
  return `${who} changed this page from outside while you were editing, and ${changes(count)} yours.`;
}

/** The notes waiting for review, each with **Review** and **Dismiss**. */
export function LiveNotes({
  ctx,
  notes,
  busy,
  onReview,
  onDismiss,
}: {
  ctx: ClientContext;
  notes: readonly LiveNote[];
  /** The note whose Review is opening, if any. */
  busy: string | null;
  onReview: (note: LiveNote, who: string) => void;
  onDismiss: (note: LiveNote) => void;
}) {
  const nameOf = useNoteNames(ctx, notes);
  if (notes.length === 0) return null;
  return (
    <ul aria-label="Changes waiting for review" className="grid gap-2">
      {notes.map((note) => (
        <li
          key={note.revision}
          role="note"
          className="flex flex-wrap items-center gap-2 rounded-control bg-muted px-3 py-2 text-sm"
        >
          <p className="min-w-0 flex-1">{noteText(note, nameOf(note))}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy === note.revision}
              onClick={() => onReview(note, nameOf(note))}
            >
              Review
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDismiss(note)}>
              Dismiss
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

type Reviewing =
  | { status: 'opening'; revision: string }
  | { status: 'ready'; opened: OpenedNote; merge: pageMerge.Merge; theirs: Theirs }
  | { status: 'message'; text: string };

/**
 * Review of a note, from **Review** to the merge view and back (ADR 0015
 * decision 8): opened afresh each time, so it shows the document as it is
 * now; what the fold took, or someone settled since, isn't offered.
 */
export function useReviewing(session: DraftSession) {
  const [state, setState] = useState<Reviewing | null>(null);
  const opening = useRef(0);
  const start = useCallback(
    (note: LiveNote, who: string) => {
      const mine = ++opening.current;
      setState({ status: 'opening', revision: note.revision });
      void session.openNote(note.revision).then(
        (opened) => {
          if (opening.current !== mine) return;
          const merge = opened && session.reviewMerge(opened);
          if (!opened || !merge) {
            return setState({ status: 'message', text: 'That change can’t be reviewed here.' });
          }
          if (merge.overlaps.length === 0) {
            // Nothing of it overlaps the page any more: the note has done its job.
            session.dismissNote(note.revision);
            return setState({
              status: 'message',
              text: 'Nothing there overlaps the page any more.',
            });
          }
          const theirs: Theirs = who === 'You' ? { kind: 'self' } : { kind: 'person', name: who };
          setState({ status: 'ready', opened, merge, theirs });
        },
        () => {
          if (opening.current === mine) {
            setState({ status: 'message', text: 'That change couldn’t be opened just now.' });
          }
        },
      );
    },
    [session],
  );
  const cancel = useCallback(() => {
    opening.current++;
    setState(null);
  }, []);
  const apply = useCallback(
    (merge: pageMerge.Merge, choices: Readonly<Record<string, pageMerge.Choice>>) => {
      if (state?.status !== 'ready') return;
      opening.current++;
      setState(
        session.applyReview(state.opened, merge, choices)
          ? null
          : { status: 'message', text: 'Those parts changed meanwhile. Review them again.' },
      );
    },
    [session, state],
  );
  return { state, start, cancel, apply };
}
