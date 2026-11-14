import {
  CryptoError,
  linkablePages,
  linkKey,
  mayReferOtherPages,
  PageId,
  type ClientContext,
  type pageOperations,
  type PagePayload,
  type PayloadChanges,
  type Region,
  type RevisionId,
} from '@wikistow/client';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { flushSync } from 'react-dom';
import { Paperclip, Trash2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { Name, plainText } from '@/components/name';
import { Button, uploadButtonClass } from '@/components/ui/button';
import { notCredential } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { runCommand } from '../commands/command';
import { createPage } from '../commands/page-commands';
import { requirementsHere } from '../commands/ui-commands';
import { usePageIndex } from '../data/page-index';
import { contentChanged } from '../data/content-changed';
import { revisionQuery, treeQuery } from '../data/queries';
import { errorMessage, stopMessage } from '../errors';
import { decryptedQuery } from './attachments';
import type { SaveStatus } from './autosave';
import { LinkChooser } from './editor/link-chooser';
import { candidatesFor, linkHeadings } from './editor/link-model';
import { PageEditor } from './editor/page-editor';
import { otherPages, type OtherPages } from './other-pages';
import { QueryTable } from './query-table';
import type { PropertyKeys } from './properties-box';
import { useMovedLinks } from './moved-links';
import { readHeadings } from './page-reader';
import type { AttachmentAssist, EditorSurfaceHandle, LinkAssist } from './editor/surface';
import { useDraftSession, type Queued } from './use-draft-session';
import type { DraftSnapshot } from './draft-session';
import { useLiveSource } from './live/use-live-source';
import { peopleQuery } from '../sharing/people';
import { MergeView } from './merge/merge-view';
import { openOnlineMerge, openWindowMerge, type OpenedMerge } from './merge/open-merge';
import { useNotKept } from '../data/connection';
import { pageChange, queueQuery } from '../data/offline-changes';
import { useAvailability } from '../shell/availability';
import type { Passages } from '../comments/passages';

export type DraftEditorHandle = {
  /**
   * Save anything not yet saved, after a file still uploading is added.
   * Throws if it can't be, so callers don't move on.
   */
  flush(): Promise<void>;
  /**
   * Save, and leave the page's live session, before a version is restored:
   * the restore is saved from outside the session, and the draft view opens
   * again on it, joining a new one (ADR 0015 step 6).
   */
  beforeRestore(): Promise<void>;
  /** Change the draft from outside the editor, as the cover pickers do, given the draft as it is now. */
  revise(changes: (current: PagePayload) => PayloadChanges): void;
  /** Work saves and leaving wait for, as for a file uploading: a banner image, say. */
  track(work: Promise<unknown>): void;
  /**
   * Throw `PageTooLarge` if the draft, with `changes` if given, is too large
   * to save: before uploading a file for it, or making a change from outside.
   */
  checkSize(changes?: PayloadChanges): void;
  /** The draft revision everything shown is saved in, or null while some of it isn't. */
  saved(): RevisionId | null;
  /** The draft's Markdown as the editor has it now, saved or not, an edit not yet reported included. */
  markdown(): string;
  /** What is selected where the cursor is, as Markdown, or `''` (a plugin's `selection`). */
  selection(): string;
  /** Put `markdown` in at the cursor as the person's edit (a plugin's `insert`). */
  insert(markdown: string): void;
  /** Its text, for comments on passages, while the editor is there. */
  passages(): Passages | null;
};

const NONE: readonly string[] = [];

const STATUS_TEXT: Record<SaveStatus, string> = {
  saved: 'All changes saved',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Not saved: someone else changed this draft',
  'too-large': 'Not saved: too large',
  error: 'Not saved',
};

/**
 * Why a save failed, in this app's words where it has them, and whether
 * trying again can help. A stop it explains (`stopMessage`) comes back the
 * same while the server sends the same, unless a key was since sealed for
 * this app or an owner accepted.
 */
function saveFailure(error: unknown) {
  const stopped = stopMessage(error);
  if (stopped === undefined)
    return { message: 'Your last changes could not be saved.', retry: true };
  const retry =
    error instanceof CryptoError &&
    (error.code === 'missing-key' || error.code === 'unaccepted-owner');
  return { message: `Your last changes could not be saved. ${stopped}`, retry };
}

/**
 * The draft view: a title and the page's Markdown, its body in the source
 * or visual editor and its frontmatter in Properties, with its
 * attachments, saved by a `DraftSession` as the person types.
 */
export function DraftEditor({
  ctx,
  page,
  base,
  head,
  payload,
  region,
  queued = null,
  onReload,
  onMerged,
  hiddenAttachments = NONE,
  toolbar,
  ref,
}: {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  /** The draft revision `payload` came from. */
  base: RevisionId;
  /** The page's draft head as last loaded, to notice saves made elsewhere. */
  head: RevisionId | null;
  payload: PagePayload;
  /** The region `payload` was opened in, which its link table was worked out for. */
  region: Region;
  /** The change waiting on this device that `payload` is, if any (`useDraftSession`). */
  queued?: Queued | null;
  /**
   * Throw away local edits and load the draft as it is now. `keepQueued`
   * when theirs is a change another window saved on this device.
   */
  onReload: (options: { keepQueued: boolean }) => void;
  /** A merge was saved: the draft is `payload` now, its banner and icon included. */
  onMerged?: (payload: PagePayload) => void;
  /** Attachments kept out of the list because something else manages them (the banner, the icon). */
  hiddenAttachments?: readonly string[];
  /** Plugins' buttons for the editor's format toolbar (`editor.toolbar`). */
  toolbar?: ReactNode;
  ref?: Ref<DraftEditorHandle>;
}) {
  const surface = useRef<EditorSurfaceHandle>(null);
  const { session, snapshot, conflictWithDevice } = useDraftSession({
    ctx,
    page,
    base,
    head,
    payload,
    region,
    queued,
    surface,
  });
  // Saved into this device's queue, not yet on the server (ADR 0009, decision 7).
  const onDevice = useAvailability().waiting(page.pageId) !== 'none';
  // The page's draft change among them: the person's own text, saved there.
  const { data: entries } = useQuery(queueQuery(ctx));
  const draftWaiting = pageChange(entries, page.pageId) !== null;
  const links = useLinkAssist({ ctx, page, table: snapshot.links, session });
  const live = useLiveSource(ctx, page.pageId, session, snapshot.live);
  const propertyKeys = usePropertyKeys(ctx, page);
  const others = useOtherPages(ctx, page, links.assist, snapshot.markdown);
  const { pages } = links.assist;
  // A query block's result, under its code in the visual editor.
  const queryTable = useCallback(
    (source: string) => (
      <QueryTable
        source={source}
        scope={{ ctx, spaceId: page.spaceId, pages, editor: true }}
        failed={(error) => (
          <p role="note" className="query-table-error text-xs text-muted-foreground">
            {error}
          </p>
        )}
      />
    ),
    [ctx, page.spaceId, pages],
  );
  const markdown = useRef(snapshot.markdown);
  useLayoutEffect(() => {
    markdown.current = snapshot.markdown;
  });
  const queryClient = useQueryClient();
  const listed = useMemo(
    () => snapshot.attachments.filter((a) => !hiddenAttachments.includes(a.id)),
    [snapshot.attachments, hiddenAttachments],
  );
  const attachments = useMemo<AttachmentAssist>(
    () => ({
      list: snapshot.attachments,
      listed,
      url: (ref) =>
        queryClient
          .fetchQuery(decryptedQuery({ ctx, page, audience: 'draft' }, ref))
          .catch(() => null),
    }),
    [ctx, page, queryClient, snapshot.attachments, listed],
  );

  useImperativeHandle(
    ref,
    () => ({
      flush: () => session.saveOrThrow(),
      beforeRestore: async () => {
        await session.leaveLive();
        await session.saveOrThrow();
      },
      revise: (changes) => session.revise(changes),
      track: (work) => session.track(work),
      checkSize: (changes) => session.checkSize(changes),
      saved: () => session.savedRevision(),
      markdown: () => surface.current?.read() ?? markdown.current,
      selection: () => surface.current?.selection?.() ?? '',
      insert: (text) => surface.current?.insert?.(text),
      passages: () => surface.current?.passages ?? null,
    }),
    [session],
  );

  const failed = snapshot.status === 'error' ? saveFailure(snapshot.saveError) : null;
  const merging = useMerging(ctx, page, session, conflictWithDevice);
  // Merge… when there is something of the person's to merge (ADR 0013,
  // decision 1): unsaved text, or text saved into the page's draft change
  // waiting on this device. Not a move or publish waiting, which holds none.
  const mine = session.hasUnsaved() || draftWaiting;
  const canMerge = snapshot.status === 'conflict' && mine;
  const merge = merging.state?.status === 'ready' ? merging.state.opened : null;
  const mergeButton = useRef<HTMLButtonElement>(null);
  // Once the conflict is resolved another way, a merge that failed is forgotten.
  const { cancel: forgetMerge } = merging;
  const conflict = snapshot.status === 'conflict';
  useEffect(() => {
    if (!conflict) forgetMerge();
  }, [conflict, forgetMerge]);

  return (
    <div className="flex flex-1 flex-col gap-4">
      {merge && (
        <MergeView
          key={merge.over.kind === 'draft' ? merge.over.revisionId : merge.over.version}
          merge={merge.merge}
          theirs={merge.theirs}
          pictures={{ ctx, page, attachments: merge.attachments }}
          onCancel={() => {
            flushSync(merging.cancel);
            mergeButton.current?.focus();
          }}
          onSave={(payload) => {
            merging.cancel();
            onMerged?.(payload);
            void session.saveMerged(merge.over, payload);
          }}
        />
      )}
      {merging.state?.status === 'loading' && (
        <p role="status" className="text-sm text-muted-foreground">
          Merging…
        </p>
      )}
      {/* Kept on screen while merging, so the person's text stays as it is. */}
      <div
        className={cn(
          'flex flex-1 flex-col gap-4',
          merging.state?.status !== 'failed' && merging.state && 'hidden',
        )}
      >
        {/* Until it saves, or someone else's save stops it saving. */}
        {snapshot.tooLarge !== null && snapshot.status !== 'conflict' && (
          <p
            role="alert"
            className="rounded-control bg-status-draft p-3 text-sm text-status-draft-foreground"
          >
            {snapshot.tooLarge} Your changes aren’t saved. Make it shorter and they will be.
          </p>
        )}
        {(snapshot.status === 'conflict' || snapshot.status === 'error') && (
          <div
            role="alert"
            className="grid gap-3 rounded-control bg-status-draft p-3 text-sm text-status-draft-foreground"
          >
            <p>
              {failed
                ? failed.message
                : conflictWithDevice()
                  ? 'You saved this page in another window while editing here. Your changes here are not saved yet.'
                  : mine
                    ? 'Someone else saved this draft while you were editing. Your changes are not saved yet.'
                    : 'Someone else saved a newer version of this draft.'}
            </p>
            {merging.state?.status === 'failed' && <p>{merging.state.message}</p>}
            {snapshot.status === 'conflict' ? (
              <div className="flex flex-wrap gap-2">
                {canMerge && (
                  <Button ref={mergeButton} size="sm" onClick={merging.start}>
                    Merge…
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={canMerge ? 'outline' : 'default'}
                  onClick={() => void session.saveMineOnTop()}
                >
                  Save mine on top
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReload({ keepQueued: conflictWithDevice() })}
                >
                  Discard mine and view theirs
                </Button>
              </div>
            ) : (
              failed?.retry && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void session.retry()}>
                    Try again
                  </Button>
                </div>
              )
            )}
          </div>
        )}
        <label className="sr-only" htmlFor="page-title">
          Title
        </label>
        <input
          id="page-title"
          value={snapshot.title}
          onChange={(event) => session.setTitle(event.target.value)}
          placeholder="Untitled"
          {...notCredential}
          className="w-full bg-transparent text-[32px] leading-tight font-extrabold outline-none placeholder:text-muted-foreground"
        />
        <PageEditor
          ref={surface}
          initial={snapshot.markdown}
          onChange={(markdown) => session.edit(markdown)}
          onEditing={() => session.editing()}
          links={links.assist}
          attachments={attachments}
          page={page}
          propertyKeys={propertyKeys}
          otherPages={others}
          queryTable={queryTable}
          toolbar={toolbar}
          live={live}
          othersEditing={snapshot.live?.kind === 'live' && snapshot.live.status.people.length > 0}
          onFiles={(files, place) => session.attach(files, (made) => place(made.join('\n')))}
          status={
            <span role="status" aria-live="polite">
              {snapshot.status === 'saved' && onDevice
                ? 'Saved on this device'
                : STATUS_TEXT[snapshot.status]}
            </span>
          }
        />
        <LiveNote ctx={ctx} live={snapshot.live} />
        {links.error && (
          <p role="alert" className="text-sm text-destructive">
            {links.error}
          </p>
        )}
        <LinkChooser {...links.chooser} />
        <section aria-label="Attachments" className="grid gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold">Attachments</h2>
            <label className={cn(uploadButtonClass, 'ml-auto')}>
              <Paperclip className="size-4" strokeWidth={1.75} />
              {snapshot.uploading ? 'Encrypting…' : 'Attach files'}
              <input
                type="file"
                multiple
                className="sr-only"
                disabled={snapshot.uploading}
                onChange={(event) => {
                  session.attach(Array.from(event.target.files ?? []));
                  event.target.value = '';
                }}
              />
            </label>
          </div>
          {snapshot.uploadError && (
            <p role="alert" className="text-sm text-destructive">
              {snapshot.uploadError}
            </p>
          )}
          {listed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              None. Files are encrypted before they leave this device.
            </p>
          ) : (
            <ul className="grid gap-1">
              {listed.map((attachment) => (
                <li
                  key={attachment.id}
                  className="flex items-center gap-2 rounded-row bg-muted px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <Name>{attachment.name}</Name>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {Math.ceil(attachment.size / 1024)} KB
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${plainText(attachment.name)}`}
                    onClick={() => session.removeAttachment(attachment.id)}
                    className="rounded-row p-1 text-muted-foreground hover:tint active:tint-strong"
                  >
                    <Trash2 className="size-4" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** What the draft view says of its live session, when there is something to say. */
function LiveNote({ ctx, live }: { ctx: ClientContext; live: DraftSnapshot['live'] }) {
  const status = live?.kind === 'live' ? live.status : null;
  const failing = status?.failing ?? null;
  const saver = status?.saver;
  const ids = [failing?.id, typeof saver === 'string' && saver !== 'me' ? saver : undefined].filter(
    (id): id is NonNullable<typeof id> => id !== undefined,
  );
  const { data: named } = useQuery({ ...peopleQuery(ctx, ids), enabled: ids.length > 0 });
  const nameOf = (id: string) => named?.get(id)?.name ?? 'Someone';
  let text: string | null = null;
  if (live?.kind === 'left') text = `${live.why} Your changes save as they did before.`;
  else if (live?.kind === 'not-joined' && live.why.kind === 'update-app') {
    text = 'Update the app to edit with others. Your changes save as they did before.';
  } else if (failing && status) {
    // Said in this app's words, never the reason as sent (section 5.10, **`presence`**).
    const whose = failing.id === ctx.identity.public.id ? 'Your' : `${nameOf(failing.id)}’s`;
    const instead =
      saver === 'me'
        ? 'this app is saving'
        : saver
          ? `${nameOf(saver)}’s app is saving`
          : 'nobody else can save yet';
    text = `${whose} saves are failing; ${instead}.`;
  }
  if (!text) return null;
  return (
    <p role="note" className="rounded-control bg-muted px-3 py-2 text-sm">
      {text}
    </p>
  );
}

type Merging =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; opened: OpenedMerge };

/** The merge the person opened from the conflict prompt, while it loads and shows. */
function useMerging(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  session: ReturnType<typeof useDraftSession>['session'],
  /** Whether theirs is a change another window saved on this device. */
  conflictWithDevice: () => boolean,
) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<Merging | null>(null);
  // Each opening, so one cancelled while it loads shows nothing.
  const opening = useRef(0);
  const start = useCallback(() => {
    const mine = ++opening.current;
    const set = (next: Merging) => opening.current === mine && setState(next);
    setState({ status: 'loading' });
    (conflictWithDevice()
      ? openWindowMerge(ctx, page, session, queryClient)
      : openOnlineMerge(ctx, page, session, queryClient)
    ).then(
      (opened) => set({ status: 'ready', opened }),
      (error: unknown) => set({ status: 'failed', message: errorMessage(error) }),
    );
  }, [ctx, page, session, queryClient, conflictWithDevice]);
  const cancel = useCallback(() => {
    opening.current++;
    setState(null);
  }, []);
  return { state, start, cancel };
}

// Long enough for a slow tree to load; after it, the link just stays
// unresolved, as if the page had been made elsewhere.
const PICK_WAIT_MS = 60_000;

/**
 * Tries `pick` on each cache change until it holds. A draft save landing
 * while the tree reloads cancels that reload, and the tree it fetches next
 * is the first to list a page just made.
 */
function pickWhenListed(queryClient: QueryClient, pick: () => boolean) {
  const cache = queryClient.getQueryCache();
  const stop = () => {
    unsubscribe();
    clearTimeout(timer);
  };
  const unsubscribe = cache.subscribe((event) => {
    if (event.type === 'updated' && pick()) stop();
  });
  const timer = setTimeout(stop, PICK_WAIT_MS);
}

/**
 * The keys the pages in this page's folder use, from the search index,
 * which is built only once Add property asks for them.
 */
function usePropertyKeys(ctx: ClientContext, page: pageOperations.PageRef): PropertyKeys {
  const [wanted, setWanted] = useState(false);
  const { data: tree } = useQuery(treeQuery(ctx, page.spaceId));
  const { index } = usePageIndex(ctx, { enabled: wanted });
  const parentId = tree?.pages.find((p) => p.id === page.pageId)?.parentId;
  const keys = useMemo(
    () =>
      parentId === undefined
        ? undefined
        : index?.keys({ spaceId: page.spaceId, folderId: parentId }),
    [index, page.spaceId, parentId],
  );
  const load = useCallback(() => setWanted(true), []);
  return useMemo(() => ({ keys, load }), [keys, load]);
}

/**
 * The other pages the draft's references name (`` `=[[Page]].key` ``), from
 * the search index, which is built only once the draft has one, or one is
 * being typed. A reference to this page shows its saved draft's values.
 */
function useOtherPages(
  ctx: ClientContext,
  page: pageOperations.PageRef,
  assist: LinkAssist,
  markdown: string,
): OtherPages | null {
  const wanted = mayReferOtherPages(markdown);
  const { index } = usePageIndex(ctx, { enabled: wanted });
  const { pages, table } = assist;
  return useMemo(
    () =>
      wanted
        ? otherPages(index, {
            spaceId: page.spaceId,
            selfId: page.pageId,
            pages,
            links: table,
            editor: true,
          })
        : null,
    [wanted, index, page.spaceId, page.pageId, pages, table],
  );
}

/**
 * Wikilink help for the editor, from the space's tree on screen: the pages
 * to link to, their headings, making a missing page, and the chooser for a
 * link several pages have the title of.
 */
function useLinkAssist({
  ctx,
  page,
  table,
  session,
}: {
  ctx: ClientContext;
  page: pageOperations.PageRef;
  table: ReadonlyMap<string, string>;
  session: ReturnType<typeof useDraftSession>['session'];
}) {
  const queryClient = useQueryClient();
  const { data: tree } = useQuery(treeQuery(ctx, page.spaceId));
  const pages = useMemo(() => (tree ? linkablePages(tree) : null), [tree]);
  const [choosing, setChoosing] = useState<{ key: string; target: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Offline, a page is made on this device, but not for a missing link
  // while some of the space's pages aren't kept: it may name one of them
  // (ADR 0009, decision 4).
  const notKept = useNotKept(ctx, page.spaceId);
  const unsure = notKept !== undefined && notKept.size > 0;
  const moved = useMovedLinks(ctx, page, pages, table);

  const assist = useMemo<LinkAssist>(() => {
    const parentId = tree?.pages.find((p) => p.id === page.pageId)?.parentId ?? null;
    return {
      pages,
      targets: () => session.linkTargets(),
      selfId: page.pageId,
      table,
      moved,
      ownHeadings: async (markdown) => linkHeadings(await readHeadings(markdown)),
      async headings(pageId) {
        const entry = tree?.pages.find((p) => p.id === pageId);
        const head = entry?.draftHead ?? entry?.publishedHead;
        if (!entry || !head) return [];
        const audience = entry.draftHead ? 'draft' : 'published';
        try {
          const target = { spaceId: page.spaceId, pageId: entry.id };
          const { opened } = await queryClient.fetchQuery(
            revisionQuery(ctx, target, audience, head),
          );
          return opened.kind === 'current'
            ? linkHeadings(await readHeadings(opened.payload.markdown))
            : [];
        } catch {
          return [];
        }
      },
      // Not at the top of a space whose own name failed its checks: nothing
      // can be made there.
      create:
        unsure || (parentId === null && !tree?.space?.metadata)
          ? null
          : (title) => {
              setError(null);
              runCommand(
                createPage,
                { spaceId: page.spaceId, parentId, title },
                {
                  ctx,
                  satisfies: requirementsHere({ editor: true }),
                  // Once the tree lists the new page, the link just written means
                  // it, even where a page this draft can't name has the same title.
                  onCreated: async (pageId) => {
                    const pick = () => session.chooseLink(linkKey({ target: title }), pageId);
                    await contentChanged(queryClient, ctx, { spaceId: page.spaceId });
                    if (!pick()) pickWhenListed(queryClient, pick);
                  },
                },
              ).catch((caught: unknown) =>
                setError(`“${title}” was not created. ${errorMessage(caught)}`),
              );
            },
      pick: (key, pageId) => void session.chooseLink(key, PageId.parse(pageId)),
      choose: setChoosing,
    };
  }, [ctx, page, pages, queryClient, session, table, tree, unsure, moved]);

  const scope = { pages: pages ?? [], selfId: page.pageId };
  const chooser = {
    link: choosing,
    candidates: choosing ? candidatesFor(choosing.target, scope) : [],
    chosen: choosing ? (table.get(choosing.key) ?? null) : null,
    allowed: choosing ? session.linkTargets() : null,
    onPick: (pageId: string) => {
      if (choosing) session.chooseLink(choosing.key, PageId.parse(pageId));
      setChoosing(null);
    },
    onOpenChange: (open: boolean) => {
      if (!open) setChoosing(null);
    },
  };
  return { assist, chooser, error };
}
