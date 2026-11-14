import { fromBase64, type ClientContext } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { peopleQuery } from '../../sharing/people';
import type { DraftSession, LiveShown } from '../draft-session';
import { colourOf } from '../editor/source/live-colours';
import type { LiveSource, RemoteCaret } from '../editor/source/live';
import { showLivePeople } from './live-people';

/**
 * What the source editor binds to while the draft is in a live session:
 * the shared document's `body`, the person's own changes made as theirs,
 * others' carets by their names and colours, and the person's cursor sent
 * in their presence. Who else is editing goes to the page's toolbar.
 */
export function useLiveSource(
  ctx: ClientContext,
  pageId: string,
  session: DraftSession,
  live: LiveShown | null,
): LiveSource | null {
  const participant = live?.kind === 'live' ? session.participant : null;
  const people = live?.kind === 'live' ? live.status.people : null;
  const ids = useMemo(() => (people ?? []).map((person) => person.id), [people]);
  const { data: named } = useQuery({ ...peopleQuery(ctx, ids), enabled: ids.length > 0 });

  useEffect(() => {
    showLivePeople(pageId, people);
  }, [pageId, people]);
  useEffect(() => () => showLivePeople(pageId, null), [pageId]);

  // Others' carets, read by the binding as they change.
  const carets = useRef<{ list: RemoteCaret[]; listeners: Set<() => void> }>({
    list: [],
    listeners: new Set(),
  });
  useEffect(() => {
    const list: RemoteCaret[] = [];
    for (const person of people ?? []) {
      const name = named?.get(person.id)?.name ?? '…';
      for (const join of person.joins) {
        if (!join.cursor || join.editor !== 'source') continue;
        try {
          list.push({
            key: `${person.id} ${join.joinId}`,
            name,
            colour: colourOf(person.id),
            anchor: fromBase64(join.cursor.anchor),
            head: fromBase64(join.cursor.head),
          });
        } catch {
          // A cursor that doesn't decode shows nothing.
        }
      }
    }
    carets.current.list = list;
    for (const listener of carets.current.listeners) listener();
  }, [people, named]);

  return useMemo(() => {
    if (!participant) return null;
    return {
      text: participant.document.text('body'),
      edit: (change) => participant.edit(() => change()),
      localOrigin: participant.localOrigin,
      carets: () => carets.current.list,
      onCarets(listener) {
        carets.current.listeners.add(listener);
        return () => void carets.current.listeners.delete(listener);
      },
      cursor: (cursor) => participant.setCursor(cursor),
    };
  }, [participant]);
}
