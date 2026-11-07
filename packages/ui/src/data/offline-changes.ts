import {
  createPageWriter,
  FolderId,
  PageId,
  RevisionId,
  serverWrites,
  SpaceId,
  type ClientContext,
  type PageWriter,
  type queueOperations,
} from '@wikistow/client';
import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { desktop } from '../desktop';
import { readWikilinks } from '../page/page-reader';
import { PLAIN } from '../vault/store';
import { connection, useConnection } from './connection';
import { keepChanged, pageOpened } from './keeper';
import { pageQuery, searchIndexChanged, treeQuery } from './queries';

// Changes made offline (ADR 0009, decision 7), as the app makes, follows and sends them.

/** This session's queue, where the device keeps one. */
export const queueOf = (ctx: ClientContext) => ctx.keptContent?.queue ?? null;

/**
 * How the app writes drafts, new pages and folders, and files for `ctx`'s
 * session: to the server, or into the queue while the app is offline
 * (`connection`) or what's written on has a change waiting.
 */
export const pageWriter = (ctx: ClientContext): PageWriter =>
  createPageWriter({
    queue: ctx.keptContent?.queue ?? null,
    server: serverWrites(ctx),
    isOnline: () => connection.get().online,
  });

/** Every change waiting on this device, in the order made. */
export const queueQuery = (ctx: ClientContext) =>
  queryOptions({
    queryKey: [PLAIN, 'queue'],
    queryFn: async () => (await queueOf(ctx)?.entries()) ?? [],
    // Loaded again whenever the queue changes, here or in another tab.
    staleTime: Infinity,
  });

/** The change waiting for a page, or null. */
export const pageChange = (
  entries: readonly queueOperations.QueueEntry[] | undefined,
  pageId: PageId,
): queueOperations.QueuedPage | null =>
  entries?.find(
    (entry): entry is queueOperations.QueuedPage => entry.kind === 'page' && entry.id === pageId,
  ) ?? null;

/**
 * What the queue tells the draft sessions with its pages, from this tab or
 * another: a version about to be sent, which they count as their own, and
 * one that landed, which they take as their base.
 */
export type SentVersion = { kind: 'recorded' | 'landed'; pageId: PageId; revisionId: RevisionId };

const sessions = new Set<(sent: SentVersion) => void>();

/** Hear of versions the queue sends, until the returned function is called. */
export function onSent(listener: (sent: SentVersion) => void): () => void {
  sessions.add(listener);
  return () => void sessions.delete(listener);
}

// What tabs tell each other of their queue: the same events, without what was typed.
const CHANNEL = 'wikistow-kept-queue';
const Told = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('saved') }),
  z.object({ kind: z.literal('changed'), spaceId: SpaceId, id: z.union([PageId, FolderId]) }),
  z.object({
    kind: z.enum(['recorded', 'landed']),
    spaceId: SpaceId,
    pageId: PageId,
    revisionId: RevisionId,
  }),
]);
type Told = z.output<typeof Told>;

const told = (event: queueOperations.QueueEvent): Told =>
  event.kind === 'saved' ? { kind: 'saved' } : event;

let persisting = false;

/**
 * The first change made offline in a browser asks it to keep the site's
 * storage (decision 1): unlike pages, a change it cleared can't come back.
 */
function persist() {
  if (persisting || desktop || typeof navigator === 'undefined') return;
  persisting = true;
  void navigator.storage?.persist?.().catch(() => {});
}

function follow(queryClient: QueryClient, ctx: ClientContext, event: Told) {
  void queryClient.invalidateQueries({ queryKey: queueQuery(ctx).queryKey });
  if (event.kind === 'saved') return;
  if (event.kind === 'recorded') {
    for (const session of sessions) session(event);
    return;
  }
  const id = event.kind === 'changed' ? event.id : event.pageId;
  void queryClient.invalidateQueries({ queryKey: treeQuery(ctx, event.spaceId).queryKey });
  void queryClient.invalidateQueries({ queryKey: pageQuery(ctx, PageId.parse(id)).queryKey });
  if (event.kind === 'landed') {
    for (const session of sessions) session(event);
    // A change made here was opened here: kept from now on with Pages I open.
    pageOpened(ctx, { spaceId: event.spaceId, pageId: event.pageId });
    searchIndexChanged(queryClient, { spaceIds: [event.spaceId] });
    keepChanged(ctx, { spaces: [event.spaceId] });
  }
}

/** How long the queue waits after a change before sending it, as typing goes on. */
const SEND_AFTER_MS = 1_000;

/** How long a tab waits to try again while another tab or window sends the queue. */
const BUSY_MS = 30_000;

/**
 * While the vault is open: follow the queue, here and in the browser's
 * other tabs, and send it while the app is online and its session is
 * confirmed (`useSessionConfirmed`), as the steps an offline unlock skipped
 * come first (decision 4). Sending starts again after each change, and
 * when the server answers again.
 */
export function useOfflineChanges(ctx: ClientContext | null, confirmed: boolean) {
  const queryClient = useQueryClient();
  const { online } = useConnection();
  const queue = ctx && queueOf(ctx);
  // Following, from the moment the vault opens, online or not.
  useEffect(() => {
    if (!ctx || !queue) return;
    const channel =
      !desktop && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
    if (channel) {
      channel.onmessage = (message: MessageEvent<unknown>) => {
        const event = Told.safeParse(message.data);
        if (event.success) follow(queryClient, ctx, event.data);
      };
    }
    const stop = queue.subscribe((event) => {
      if (event.kind === 'changed' || event.kind === 'saved') persist();
      const sent = told(event);
      follow(queryClient, ctx, sent);
      channel?.postMessage(sent);
    });
    return () => {
      stop();
      channel?.close();
    };
  }, [ctx, queue, queryClient]);
  // Sending.
  const sending = online && confirmed;
  useEffect(() => {
    if (!ctx || !queue || !sending) return;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          // `'offline'` waits for the connection, which this effect follows.
          const sent = await queue.send(ctx, { read: readWikilinks }).catch(() => null);
          // Another tab or window is sending: try again later, in case it closes.
          if (sent === 'busy') later(BUSY_MS);
        } while (again);
      } finally {
        running = false;
      }
    };
    const later = (wait = SEND_AFTER_MS) => {
      clearTimeout(timer);
      timer = setTimeout(() => void send(), wait);
    };
    void send();
    const stop = queue.subscribe((event) => {
      if (event.kind === 'saved' || event.kind === 'changed') later();
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [ctx, queue, sending]);
}
