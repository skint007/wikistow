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
import { Paperclip, Trash2 } from 'lucide-react';
import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
import { readHeadings } from './page-reader';
import type { AttachmentAssist, EditorSurfaceHandle, LinkAssist } from './editor/surface';
import { useDraftSession } from './use-draft-session';

export type DraftEditorHandle = {
  /**
   * Save anything not yet saved, after a file still uploading is added.
   * Throws if it can't be, so callers don't move on.
   */
  flush(): Promise<void>;
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
  onReload,
  hiddenAttachments = NONE,
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
  /** Throw away local edits and load the draft as it is now. */
  onReload: () => void;
  /** Attachments kept out of the list because something else manages them (the banner, the icon). */
  hiddenAttachments?: readonly string[];
  ref?: Ref<DraftEditorHandle>;
}) {
  const surface = useRef<EditorSurfaceHandle>(null);
  const { session, snapshot } = useDraftSession({
    ctx,
    page,
    base,
    head,
    payload,
    region,
    surface,
  });
  const links = useLinkAssist({ ctx, page, table: snapshot.links, session });
  const propertyKeys = usePropertyKeys(ctx, page);
  const others = useOtherPages(ctx, page, links.assist, snapshot.markdown);
  const { pages } = links.assist;
  // A query block's result, under its code in the visual editor.
  const queryTable = useCallback(
    (source: string) => (
      <QueryTable
        source={source}
        scope={{ ctx, spaceId: page.spaceId, pageId: page.pageId, pages, editor: true }}
        failed={(error) => (
          <p role="note" className="query-table-error text-xs text-muted-foreground">
            {error}
          </p>
        )}
      />
    ),
    [ctx, page.spaceId, page.pageId, pages],
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
      revise: (changes) => session.revise(changes),
      track: (work) => session.track(work),
      checkSize: (changes) => session.checkSize(changes),
      saved: () => session.savedRevision(),
      markdown: () => surface.current?.read() ?? markdown.current,
    }),
    [session],
  );

  const failed = snapshot.status === 'error' ? saveFailure(snapshot.saveError) : null;

  return (
    <div className="flex flex-1 flex-col gap-4">
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
              : session.hasUnsaved()
                ? 'Someone else saved this draft while you were editing. Your changes are not saved yet.'
                : 'Someone else saved a newer version of this draft.'}
          </p>
          {snapshot.status === 'conflict' ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void session.saveMineOnTop()}>
                Save mine on top
              </Button>
              <Button size="sm" variant="outline" onClick={onReload}>
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
        onFiles={(files, place) => session.attach(files, (made) => place(made.join('\n')))}
        status={
          <span role="status" aria-live="polite">
            {STATUS_TEXT[snapshot.status]}
          </span>
        }
      />
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
  );
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

  const assist = useMemo<LinkAssist>(() => {
    const parentId = tree?.pages.find((p) => p.id === page.pageId)?.parentId ?? null;
    return {
      pages,
      targets: () => session.linkTargets(),
      selfId: page.pageId,
      table,
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
        parentId === null && !tree?.space?.metadata
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
                    await queryClient.invalidateQueries({
                      queryKey: treeQuery(ctx, page.spaceId).queryKey,
                    });
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
  }, [ctx, page, pages, queryClient, session, table, tree]);

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
