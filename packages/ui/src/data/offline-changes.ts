import {
  FolderId,
  newFolderMetadata,
  newId,
  newPayload,
  PageId,
  pageOperations,
  RevisionId,
  spaceOperations,
  SpaceId,
  type AttachmentRef,
  type ClientContext,
  type FolderLook,
  type FolderPicture,
  type queueOperations,
} from '@wikistow/client';
import { noAnswer } from '@wikistow/client/api';
import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { z } from 'zod';
import { desktop } from '../desktop';
import { readWikilinks } from '../page/page-reader';
import { PLAIN } from '../vault/store';
import { connection, useConnection } from './connection';
import { keepChanged, pageOpened } from './keeper';
import { pageQuery, searchIndexChanged, treeQuery } from './queries';

// Changes made offline (ADR 0009, decision 7), as the app follows and sends them.

/** This session's queue, where the device keeps one. */
export const queueOf = (ctx: ClientContext) => ctx.keptContent?.queue ?? null;

/**
 * Whether a page's changes go into the queue: offline, or while it has a
 * change waiting there, online too, until that is sent (decision 7).
 */
export async function savesOnDevice(ctx: ClientContext, pageId: PageId): Promise<boolean> {
  const queue = queueOf(ctx);
  return !!queue && (!connection.get().online || (await queue.entry(pageId)) !== null);
}

/**
 * Encrypt a file for a page's draft and upload it, or, where its changes go
 * into the queue (`savesOnDevice`), keep it there with them until they are
 * sent. Add the returned ref to the draft's attachments to keep it.
 */
export async function attachFile(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  file: { name: string; mediaType: string; bytes: Uint8Array },
): Promise<AttachmentRef> {
  const queue = queueOf(ctx);
  if (queue && (await savesOnDevice(ctx, page.pageId))) return queue.attach(ctx, page, file);
  return pageOperations.uploadAttachment(ctx, page, file);
}

/**
 * A new page with that title, at the space root or in a folder: offline,
 * made on this device, to be made on the server once it answers (decision
 * 7), as is one whose request got no answer, under the IDs it was sent with.
 */
export async function makePage(
  ctx: ClientContext,
  { spaceId, parentId, title }: { spaceId: SpaceId; parentId: FolderId | null; title: string },
): Promise<PageId> {
  const queue = queueOf(ctx);
  const payload = newPayload({ title, markdown: '' });
  if (queue && !connection.get().online) {
    return (await queue.newPage({ spaceId, parentId, payload })).id;
  }
  const pageId = newId(PageId);
  const revisionId = newId(RevisionId);
  try {
    return await pageOperations.createPage(ctx, { spaceId, parentId, title, pageId, revisionId });
  } catch (error) {
    if (!queue || !noAnswer(error)) throw error;
    await queue.newPage({ spaceId, parentId, payload, pageId, revisionId });
    return pageId;
  }
}

/** A new folder, as `makePage` makes a page: offline, made on this device first. */
export async function makeFolder(
  ctx: ClientContext,
  {
    spaceId,
    parentId,
    name,
    look,
    picture,
  }: {
    spaceId: SpaceId;
    parentId: FolderId | null;
    name: string;
    look?: FolderLook;
    picture?: FolderPicture;
  },
): Promise<FolderId> {
  const queue = queueOf(ctx);
  const metadata = newFolderMetadata(name, look, picture);
  const folderId = newId(FolderId);
  if (queue && !connection.get().online) {
    return (await queue.newFolder({ spaceId, parentId, metadata, folderId })).id;
  }
  try {
    await spaceOperations.createFolderAs(ctx, { spaceId, parentId, folderId, metadata });
  } catch (error) {
    if (!queue || !noAnswer(error)) throw error;
    await queue.newFolder({ spaceId, parentId, metadata, folderId });
  }
  return folderId;
}

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
