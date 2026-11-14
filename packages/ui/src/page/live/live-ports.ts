import {
  pageOperations,
  type ClientContext,
  type PagePayload,
  type Region,
  type RevisionId,
} from '@wikistow/client';
import type { QueryClient } from '@tanstack/react-query';
import { connection } from '../../data/connection';
import { pageQuery, treeQuery } from '../../data/queries';
import { holdLivePage } from './live-lock';
import { desktop } from '../../desktop';
import type { LivePorts } from '../draft-session';
import { readWikilinks } from '../page-reader';

/**
 * Whether this app may join live sessions here (ADR 0015 decision 10):
 * online, and in a browser only while its requests to `/api/` go over
 * HTTP/2 or later, by the protocol of the latest such request's resource
 * timing entry. Over HTTP/1.1 a browser allows six connections per server,
 * and each tab with a draft open holds three streams. The desktop app
 * forwards through Node, which has no such cap.
 */
export function liveAllowed(): boolean {
  if (!connection.get().online) return false;
  if (desktop) return true;
  return overHttp2();
}

/** Whether the latest request to `/api/` this page made went over HTTP/2 or later. */
export function overHttp2(): boolean {
  if (typeof performance === 'undefined' || typeof location === 'undefined') return false;
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    let url: URL;
    try {
      url = new URL(entry.name);
    } catch {
      continue;
    }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) continue;
    // The service worker may answer without saying: look further back.
    if (entry.nextHopProtocol === '') continue;
    return entry.nextHopProtocol === 'h2' || entry.nextHopProtocol === 'h3';
  }
  return false;
}

/**
 * How the draft view joins a page's live session: the client's `live`
 * module, loaded only now, with Yjs; drafts opened and saved as the app's
 * other saves are, their links read off the page's thread; and the
 * session told of everything that may change access to the page.
 */
export function livePorts(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  queryClient: QueryClient,
  /** A save of the session landed, as the draft session tells the app of its own. */
  saved: (saved: {
    revisionId: RevisionId;
    basedOn: RevisionId;
    payload: PagePayload;
    region: Region;
  }) => void,
): LivePorts {
  let region: Region | null = null;
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  return {
    allowed: () => !ctx.agent && liveAllowed(),
    whenVisible(run) {
      if (visible()) {
        run();
        return () => {};
      }
      // A hidden tab whose join lapsed joins again when shown (ADR 0015 decision 5).
      const shown = () => {
        if (!visible()) return;
        document.removeEventListener('visibilitychange', shown);
        run();
      };
      document.addEventListener('visibilitychange', shown);
      return () => document.removeEventListener('visibilitychange', shown);
    },
    hold: () => holdLivePage(page.pageId),
    async head() {
      const info = await queryClient.fetchQuery({ ...pageQuery(ctx, page.pageId), staleTime: 0 });
      const head = info.heads.draftHead;
      if (!head) return null;
      const opened = await pageOperations.openRevisionOf(ctx, page, 'draft', head, { fresh: true });
      if (opened.opened.kind !== 'current') return null;
      return { revisionId: head, payload: opened.opened.payload, region: opened.region };
    },
    async join(opening) {
      region = opening.region;
      const live = await import('@wikistow/client/live');
      const ports = live.participantPorts(ctx, page, () => region ?? opening.region, {
        read: readWikilinks,
        visible,
        editor: () => 'source',
        onSaved: (landed) => saved({ ...landed, region: region ?? opening.region }),
      });
      return live.joinLive(ports, opening);
    },
    watch(participant) {
      const stops: (() => void)[] = [];
      // Marks, keys and owners another tab changed, or this one.
      if (ctx.kept) stops.push(ctx.kept.onChange(() => void participant.recheck()));
      // Who saves: visible tabs first.
      const shown = () => participant.presenceChanged();
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', shown);
        stops.push(() => document.removeEventListener('visibilitychange', shown));
      }
      // The page's region, read again from the tree when it changes, as after a move.
      const key: readonly unknown[] = treeQuery(ctx, page.spaceId).queryKey;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const reread = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void import('@wikistow/client/live').then(async (live) => {
            const now = await live.pageRegionNow(ctx, page).catch(() => null);
            if (!now) return;
            // Access itself is checked again when the marks, keys or owners change.
            region = now;
            participant.regionIs(now);
          });
        }, 500);
      };
      stops.push(
        queryClient.getQueryCache().subscribe((event) => {
          if (event.type !== 'updated' || event.action.type !== 'success') return;
          const queryKey: readonly unknown[] = event.query.queryKey;
          if (queryKey.length === key.length && queryKey.every((part, i) => part === key[i])) {
            reread();
          }
        }),
      );
      stops.push(() => {
        if (timer) clearTimeout(timer);
      });
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}
