import {
  bannerAttachment,
  coverOf,
  linkablePages,
  linkTableOf,
  OWNER_REGION,
  pageOperations,
  PageId,
  publicationOperations,
  RevisionId,
  type FolderId,
  type OpenedPayload,
  type PagePayload,
  type Region,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { Check, Globe, Image, MoreHorizontal, Pencil, Share, Unlink } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { Name } from '@/components/name';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent, useReturnFocus } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { runCommand } from '../../../../../../commands/command';
import {
  changeBanner,
  changeEmoji,
  editPage,
  finishEditing,
  requirementsHere,
} from '../../../../../../commands/ui-commands';
import { AgentName, agentPersonName } from '../../../../../../agents/agent-name';
import { AssistantButton, useChatPage } from '../../../../../../ai/chat-column';
import { ago } from '../../../../../../agents/model';
import {
  historyQuery,
  pageQuery,
  publicLinksQuery,
  publishedCopiesQuery,
  revisionQuery,
  treeQuery,
} from '../../../../../../data/queries';
import { contentChanged } from '../../../../../../data/content-changed';
import { useNotKept } from '../../../../../../data/connection';
import { keepEveryPage, pageOpened } from '../../../../../../data/keeper';
import { keptStore } from '../../../../../../data/kept-store';
import { useDeviceSwitch } from '../../../../../../shell/device-switch';
import { PLAIN } from '../../../../../../vault/store';
import { errorMessage, pageOpenMessage } from '../../../../../../errors';
import { decryptedQuery } from '../../../../../../page/attachments';
import { PageFind } from '../../../../../../page/find/find-bar';
import { pageText } from '../../../../../../page/find/page-text';
import { BannerPicker } from '../../../../../../page/cover/banner-picker';
import { bodyTop, CoverBand, PageBadge } from '../../../../../../page/cover/cover-band';
import { EmojiPicker } from '../../../../../../page/cover/emoji-picker';
import { useCoverEditor } from '../../../../../../page/cover/use-cover-editor';
import { DraftEditor, type DraftEditorHandle } from '../../../../../../page/draft-editor';
import type { Queued } from '../../../../../../page/use-draft-session';
import { DetachDialog } from '../../../../../../page/detach-dialog';
import { Markdown } from '../../../../../../page/markdown';
import { DeletePageDialog } from '../../../../../../page/delete-dialog';
import { MoveDialog } from '../../../../../../page/move-dialog';
import { readWikilinks } from '../../../../../../page/page-reader';
import {
  PublicLinkDialog,
  PublishWithLinkDialog,
  usePublicLink,
} from '../../../../../../page/public-link';
import { PublishDialog } from '../../../../../../page/publish-dialog';
import {
  ReadingChanges,
  ReadingNotices,
  useReadingQueue,
} from '../../../../../../page/reading-changes';
import {
  applyChanges,
  originOf,
  pageFlushing,
  readingRights,
  type ReadingQueue,
} from '../../../../../../page/reading-changes-model';
import { PublishedCopiesDialog } from '../../../../../../page/published-copies';
import { LinkedFrom } from '../../../../../../page/linked-from';
import { TableOfContents, useHeadings } from '../../../../../../page/table-of-contents';
import { UnpublishDialog } from '../../../../../../page/unpublish-dialog';
import { isUnpublishedCopy, pageViewModel, type Pill } from '../../../../../../page/view-model';
import { PageCard, PageColumns, PageToolbar } from '../../../../../../page/page-layout';
import { useAppPlugins } from '../../../../../../plugins/app-plugins';
import { PagePlugins } from '../../../../../../plugins/page-plugins';
import { OWN_PANELS, Place, Replaceable, type OpenPanel } from '../../../../../../plugins/places';
import type { ShownPage } from '../../../../../../plugins/runtime';
import { shareCovering } from '../../../../../../sharing/model';
import { useOwnerStanding } from '../../../../../../sharing/owner-standing';
import { ShareDialog } from '../../../../../../sharing/share-dialog';
import { useAvailability, useNeedsConnection } from '../../../../../../shell/availability';
import { pageChange, queueChoices, queueQuery } from '../../../../../../data/offline-changes';
import { asOf } from '../../../../../../shell/offline-pill';
import { pageTitle } from '../../../../../../shell/sidebar';
import { useClient } from '../../../../../../vault/store';

export const Route = createFileRoute('/_app/_vault/s/$spaceId/p/$pageId')({
  params: {
    parse: ({ pageId }) => ({ pageId: PageId.parse(pageId) }),
    stringify: ({ pageId }) => ({ pageId }),
  },
  // The view is in the URL, so links to a draft work and Back returns to the publication.
  validateSearch: z.object({
    view: z.enum(['draft', 'published']).optional().catch(undefined),
    rev: RevisionId.optional().catch(undefined),
  }),
  component: PageView,
});

function PageView() {
  const { spaceId, pageId } = Route.useParams();
  const search = Route.useSearch();
  const ctx = useClient();
  const queryClient = useQueryClient();
  const page = { spaceId, pageId };
  const { data: info, error } = useQuery(pageQuery(ctx, pageId));
  // Offline, a page not kept suggests Every page only where that would keep it.
  const everyPage = useDeviceSwitch(keepEveryPage());
  const { data: onDisk } = useQuery({
    queryKey: ['kept-on-disk'],
    queryFn: async () => (await keptStore()).onDisk,
  });
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  useChatPage(spaceId, pageId, tree?.pages.find((p) => p.id === pageId)?.title ?? null);
  // Bumped to open the draft afresh: after "view theirs", or a restore.
  const [opening, setOpening] = useState(0);
  // The page whose public link dialog is open. It lives here, as the
  // published view mounts afresh for each publication, which mustn't close
  // it or forget an upload. Leaving the page closes it for good.
  const [sharingLinkFor, setSharingLinkFor] = useState<string | null>(null);
  useEffect(() => setSharingLinkFor(null), [pageId]);
  const sharingLink = sharingLinkFor === pageId;
  // Changes made while reading, kept across the publications they make.
  const reading = useReadingQueue(ctx, page);
  const queued = useSyncExternalStore(reading.subscribe, reading.get);
  // Turning to the draft or an older version saves what waits first, at
  // once, saying only how that went; the draft opens once it's done, on
  // top of what it saved, not under it.
  const leavingLatest = search.view === 'draft' || search.rev !== undefined;
  useEffect(() => {
    if (!leavingLatest) return;
    reading.forget();
    void reading.flush();
  }, [leavingLatest, reading]);
  // Changes that failed to save don't wait to go in under the draft the
  // person now edits, which they would overwrite: the page said why.
  const failedBeforeDraft =
    search.view === 'draft' && !queued.saving && queued.error !== null && queued.changes.length > 0;
  useEffect(() => {
    if (failedBeforeDraft) reading.discard();
  }, [failedBeforeDraft, reading]);
  // A flush of this page still running from before, as from a queue left
  // when the person went to another page and came back: the draft waits
  // for it too, drawn again once it has settled.
  const earlier = pageFlushing(pageId);
  const [, settled] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let live = true;
    void earlier?.then(() => live && settled());
    return () => {
      live = false;
    };
  }, [earlier]);
  // A copy unpublished here is shown to editors by its last publication.
  const unpublishedCopy =
    info !== undefined &&
    isUnpublishedCopy({ role: info.role, canPublish: info.canPublish }, info.heads);
  const { data: history } = useQuery({
    ...historyQuery(ctx, page),
    enabled: unpublishedCopy,
  });

  if (error)
    return (
      <PageCard>
        <Missing
          message={pageOpenMessage(error, { everyPageWouldKeep: !everyPage && onDisk === true })}
        />
      </PageCard>
    );
  if (!info || (unpublishedCopy && !history)) return <PageCard>{null}</PageCard>;
  const model = pageViewModel({
    viewer: { role: info.role, canPublish: info.canPublish },
    heads: info.heads,
    requested: search,
    lastPublished: history?.[0]?.revisionId ?? null,
  });
  if (!model.found)
    return (
      <PageCard>
        <Missing message="This page has not been published yet." />
      </PageCard>
    );

  const folder = tree?.folders.find((f) => f.id === info.parentId);
  const folderName =
    folder?.metadata?.opened.kind === 'current' ? folder.metadata.opened.metadata.name : null;
  const spaceName =
    tree?.space?.metadata?.opened.kind === 'current'
      ? tree.space.metadata.opened.metadata.name
      : '';

  if (
    model.view === 'draft' &&
    (earlier !== undefined || queued.saving || (queued.changes.length > 0 && queued.error === null))
  )
    return (
      <PageCard>
        <p role="status" className="p-8 text-center text-sm text-muted-foreground">
          Saving your changes before the draft opens…
        </p>
      </PageCard>
    );

  // The draft view stays mounted while its own saves move the draft head;
  // a publication is shown per revision, but one that changes made while
  // reading published goes on in the view they were made in
  // (`originOf`), where the person is reading, scrolled and focused.
  const key =
    model.view === 'draft'
      ? `${pageId}:draft:${opening}`
      : model.older
        ? `${pageId}:rev:${model.revision}`
        : `${pageId}:latest:${originOf(pageId, model.revision)}`;
  return (
    <>
      <PageBody
        key={key}
        page={page}
        info={info}
        model={model}
        crumbs={[spaceName, folderName].filter((c): c is string => Boolean(c))}
        // Share opens the share the page is in, or offers to share its folder,
        // or the space for a top-level page.
        shareRoot={tree ? (shareCovering(tree, info.parentId)?.rootId ?? info.parentId) : null}
        onReopen={async () => {
          await queryClient.refetchQueries({ queryKey: pageQuery(ctx, pageId).queryKey });
          setOpening((n) => n + 1);
        }}
        onShareLink={() => setSharingLinkFor(pageId)}
        reading={reading}
      />
      {((info.heads.publishedHead && info.canPublish) || sharingLink) && (
        <PublicLinkDialog
          page={page}
          title={pageTitle(tree?.pages.find((p) => p.id === pageId)?.title ?? null)}
          open={sharingLink}
          onOpenChange={(open) => setSharingLinkFor(open ? pageId : null)}
        />
      )}
    </>
  );
}

type Found = Extract<ReturnType<typeof pageViewModel>, { found: true }>;

/** What the draft view opens with (`DraftEditor`). */
type DraftFrom = {
  base: RevisionId;
  payload: PagePayload;
  region: Region;
  queued: Queued | null;
};
type Info = Awaited<ReturnType<typeof pageOperations.loadPage>>;

function PageBody({
  page,
  info,
  model,
  crumbs,
  shareRoot,
  onReopen,
  onShareLink,
  reading,
}: {
  page: pageOperations.PageRef;
  info: Info;
  model: Found;
  crumbs: string[];
  shareRoot: FolderId | null;
  /** Load the draft as it is now, dropping the editor's state. */
  onReopen: () => Promise<void>;
  /** Open the public link dialog, which outlasts this view. */
  onShareLink: () => void;
  /** The page's changes made while reading, which outlast this view. */
  reading: ReadingQueue;
}) {
  const ctx = useClient();
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  // The draft opened when this view mounted: the draft head moves on with
  // every save, but the editor already holds that text. A publication is
  // the one shown, which a change made while reading moves on in this view.
  const [openedDraft] = useState(() => RevisionId.parse(model.revision));
  const revisionId = model.view === 'draft' ? openedDraft : RevisionId.parse(model.revision);
  // The page's change waiting on this device, if any (ADR 0009, decision 7).
  const { data: entries, isSuccess: queueRead } = useQuery(queueQuery(ctx));
  const change = pageChange(entries, page.pageId);
  const { data: revision, error } = useQuery({
    ...revisionQuery(ctx, page, model.view, revisionId),
    // Opened before the page loads again, it shows at once; else the one before stays meanwhile.
    placeholderData: keepPreviousData,
    // A page made offline has no version on the server until it is made.
    enabled: queueRead && !change?.newPage,
  });
  // Kept for offline from its first opening here, with Pages I open (ADR
  // 0009); a page made offline once it is made (`useOfflineChanges`).
  const revisionShown = revision !== undefined;
  useEffect(() => {
    if (revisionShown) pageOpened(ctx, { spaceId: page.spaceId, pageId: page.pageId });
  }, [ctx, revisionShown, page.spaceId, page.pageId]);
  // Wikilinks resolve by title among the pages this person can open.
  const { data: tree } = useQuery(treeQuery(ctx, page.spaceId));
  const linkable = useMemo(() => (tree ? linkablePages(tree) : null), [tree]);
  const editor = useRef<DraftEditorHandle>(null);
  const bannerButton = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  // The cover picker open, if any; a menu item opening one keeps focus off the menu's button.
  const [picker, setPicker] = useState<'banner' | 'emoji' | null>(null);
  const fromMenu = useRef(false);
  const pickerFocus = useReturnFocus();
  const [panel, setPanel] = useState<OpenPanel>(null);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState<'move' | 'copy' | null>(null);
  const [unpublishing, setUnpublishing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [showingCopies, setShowingCopies] = useState(false);
  // Where Publish was pressed on a page with a public link, while it asks first.
  const [publishingFrom, setPublishingFrom] = useState<string | null>(null);
  // The draft as it was when Publish asked, for what the public copy will show.
  const [publishingMarkdown, setPublishingMarkdown] = useState<string | null>(null);
  const publicLink = usePublicLink(page);
  const copiesPill = useRef<HTMLButtonElement>(null);
  const crumbsNav = useRef<HTMLElement>(null);
  const [sharing, setSharing] = useState(false);
  // Sharing waits until a new owner has confirmed who added them.
  const sharer = useOwnerStanding(page.spaceId) === 'owner';
  // Nothing can be made or shared at the top of a space whose own name
  // failed its checks; one in a newer format still opened.
  const topOpened = !!tree?.space?.metadata;
  const shareable = sharer && (shareRoot !== null || topOpened);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Offline, what needs the server says so (ADR 0009, decision 8), and the
  // page says when its space was last listed, which it is shown as of.
  // What acts on this page waits for its change made offline too (`here`).
  const availability = useAvailability();
  const waiting = availability.waiting(page.pageId);
  const here = availability.of(page.pageId);
  const needs = useNeedsConnection();
  const listedAt = needs.offline ? ctx.keptContent?.space(page.spaceId)?.listedAt : undefined;
  // Offline, links to the space's pages this device doesn't keep say so.
  const notKept = useNotKept(ctx, page.spaceId);
  // The published body as shown, whose headings the table of contents lists.
  const [shownBody, setShownBody] = useState<HTMLElement | null>(null);
  const headings = useHeadings(shownBody);
  // The page's card, whose scrolling says which heading is being read.
  const [card, setCard] = useState<HTMLElement | null>(null);
  // Find on page (#276): the page as read is searched in its title and
  // body (`data-find-root`); the draft view's editor gives itself.
  const [find] = useState(() => new PageFind());
  const reader = useMemo(
    () =>
      card && model.view === 'published'
        ? pageText(() => [...card.querySelectorAll('[data-find-root]')])
        : null,
    [card, model.view],
  );
  useEffect(() => (reader ? find.add(reader) : undefined), [find, reader]);
  const contents = model.view === 'published' && headings.length > 1;
  // The latest publication as shown, with the changes made while reading it.
  const queued = useSyncExternalStore(reading.subscribe, reading.get);
  // A version the address names stays that one, so it isn't changed while it's read.
  const pinned = Route.useSearch({ select: (search) => search.rev !== undefined });
  // A page with a public link isn't changed while it's read, nor before its links are known.
  const { data: publicLinks } = useQuery(publicLinksQuery(ctx, page.spaceId));
  const linked = publicLinks ? publicLinks.some((link) => link.pageId === page.pageId) : null;
  const rights = useMemo(
    () =>
      readingRights({
        viewer: { role: info.role, canPublish: info.canPublish },
        heads: info.heads,
        view: model.view,
        revision: revisionId,
        pinned,
        publicLink: linked,
        offline: availability.offline,
        waiting,
      }),
    [
      info.role,
      info.canPublish,
      info.heads,
      model.view,
      revisionId,
      pinned,
      linked,
      availability.offline,
      waiting,
    ],
  );

  const go = (view: 'draft' | 'published') =>
    navigate({
      to: '/s/$spaceId/p/$pageId',
      params: page,
      search: view === 'draft' ? { view } : {},
    });

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const publishDraft = async () => {
    await editor.current?.flush();
    const written = await pageOperations.publishPage(ctx, page, { read: readWikilinks });
    await contentChanged(queryClient, ctx, page);
    return written;
  };
  // A page opened without ?view=draft turns to its publication as soon as
  // it refetches; if the person moved on meanwhile (Edit, another page),
  // don't drag them back.
  const showPublished = async (from: string) => {
    if (router.state.location.href === from) await go('published');
  };
  // One click, unless the page has a public link: then Publish asks first,
  // as publishing updates the public page too (ADR 0005).
  const publish = () =>
    act(async () => {
      const from = router.state.location.href;
      const links = await queryClient.ensureQueryData(publicLinksQuery(ctx, page.spaceId));
      if (links.some((link) => link.pageId === page.pageId)) {
        setPublishingMarkdown(editor.current?.markdown() ?? null);
        setPublishingFrom(from);
        return;
      }
      await publishDraft();
      await showPublished(from);
    });

  const commandEnv = {
    satisfies: requirementsHere({ editor: info.role !== 'reader' }),
    navigate,
    flushDraft: async () => editor.current?.flush(),
  };
  const done = () => act(() => runCommand(finishEditing, page, commandEnv));
  // Discard mine and view theirs: the change waiting on this device goes
  // too, unless it is theirs, saved by another window.
  const viewTheirs = async ({ keepQueued }: { keepQueued: boolean }) => {
    if (change && !keepQueued) {
      await queueChoices(ctx)?.discard(page.pageId);
      await queryClient.refetchQueries({ queryKey: queueQuery(ctx).queryKey });
    }
    await onReopen();
  };

  const opened: OpenedPayload | undefined = revision?.opened;
  // What the draft view opens, once: the page's change waiting on this
  // device, as typed, else its draft. Kept as it opened, as the editor
  // holds that text from then on, through the change being sent.
  const [draftFrom, setDraftFrom] = useState<DraftFrom | null>(null);
  if (model.view === 'draft' && draftFrom === null && queueRead) {
    const opening = change
      ? {
          base: change.basedOn ?? change.newPage?.revisionId ?? revisionId,
          payload: change.payload,
          region:
            change.region ??
            revision?.region ??
            tree?.pages.find((p) => p.id === page.pageId)?.region ??
            OWNER_REGION,
          queued: {
            version: change.version,
            sending: change.sending?.revisionId ?? null,
            // Someone saved since it was based: it opens as the conflict it came back as.
            theirs:
              change.failure?.kind === 'conflict' && info.heads.draftHead !== change.basedOn
                ? info.heads.draftHead
                : null,
          },
        }
      : revision && opened?.kind === 'current'
        ? { base: revisionId, payload: opened.payload, region: revision.region, queued: null }
        : null;
    if (opening) setDraftFrom(opening);
  }
  const payload =
    model.view === 'draft'
      ? (draftFrom?.payload ?? null)
      : opened?.kind === 'current'
        ? opened.payload
        : null;
  const canEdit = info.role !== 'reader';
  const { publishedHead } = info.heads;
  const title = pageTitle(payload?.title ?? null);
  const latest = model.view === 'published' && revisionId === publishedHead;
  const readMarkdown = payload?.markdown ?? null;
  const shownMarkdown = useMemo(
    () =>
      readMarkdown !== null && latest
        ? applyChanges(
            readMarkdown,
            queued.changes.map(({ change }) => change),
          ).markdown
        : readMarkdown,
    [readMarkdown, latest, queued.changes],
  );
  // An older version can't change, but its boxes say why to editors.
  const readingHere = useMemo(
    () =>
      model.view === 'published' && shownMarkdown !== null
        ? { markdown: shownMarkdown, rights, change: reading.add }
        : null,
    [model.view, shownMarkdown, reading, rights],
  );
  // A copy names its source only inside its payload: a label, never a link,
  // and named only once this app has checked it against the source.
  const provenance = payload ? publicationOperations.provenanceOf(payload) : null;
  // Banner and emoji change only on the draft view, saved with the draft.
  const editingCover = model.view === 'draft' && payload !== null;
  const coverEditor = useCoverEditor({
    ctx,
    page,
    payload: model.view === 'draft' ? payload : null,
    editor,
  });
  const shown =
    model.view === 'draft'
      ? coverEditor.shown
      : payload && { cover: coverOf(payload), attachments: payload.attachments };
  const emoji = shown?.cover.emoji ?? null;
  const icon = shown?.cover.icon ?? null;
  const symbol = shown?.cover.symbol?.name ?? null;
  const { data: iconUrl } = useQuery(
    decryptedQuery(
      { ctx, page, audience: model.view },
      icon ? shown?.attachments.find((a) => a.id === icon.attachmentId) : undefined,
    ),
  );
  // The attachments the cover shows, which the draft's attachment list leaves out.
  const banner = shown ? bannerAttachment(shown.cover) : null;
  const coverParts = useMemo(
    () => [banner, icon?.attachmentId ?? null].filter((id) => id !== null),
    [banner, icon?.attachmentId],
  );
  const coverEnv = {
    ...commandEnv,
    openBannerPicker: () => setPicker('banner'),
    openEmojiPicker: () => setPicker('emoji'),
  };
  const openFromMenu = (command: typeof changeBanner | typeof changeEmoji) => {
    fromMenu.current = true;
    pickerFocus.opener.current = menuButton.current;
    void act(() => runCommand(command, page, coverEnv));
  };

  // Where this page is published, which only someone who can publish it learns (section 13).
  const publisher = canEdit && info.canPublish;
  const {
    data: copies,
    error: copiesError,
    isError: copiesUnknown,
    isFetching: checkingCopies,
    refetch: checkCopies,
  } = useQuery({
    ...publishedCopiesQuery(ctx, page),
    enabled: publisher,
  });
  // Refused, this person can no longer publish the page: loaded again, the
  // page says so, and stops asking.
  const lostRights = copiesError instanceof ApiError && copiesError.code === 'forbidden';
  useEffect(() => {
    if (lostRights)
      void queryClient.invalidateQueries({ queryKey: pageQuery(ctx, page.pageId).queryKey });
  }, [lostRights, queryClient, ctx, page.pageId]);

  const { data: sourceTitle } = useQuery({
    queryKey: [PLAIN, 'publication-source', revisionId],
    queryFn: () =>
      provenance && payload
        ? publicationOperations.sourceTitle(ctx, { provenance, copy: payload })
        : null,
    enabled: provenance !== null,
  });

  // The page as plugins see it: their views, commands and panels.
  const pluginShown: ShownPage = {
    page,
    version: model.view,
    revision: revisionId,
    draft:
      model.view === 'draft'
        ? {
            ready: () => editor.current !== null,
            flush: async () => {
              if (!editor.current) throw new Error('The draft is still opening here');
              await editor.current.flush();
            },
            saved: () => editor.current?.saved() ?? null,
            fits: (changes) => editor.current?.checkSize(changes),
            revise: (changes) => editor.current?.revise(() => changes),
            selection: () => editor.current?.selection() ?? '',
            insert: (markdown) => editor.current?.insert(markdown),
          }
        : null,
  };
  // Plugins are told the version shown here, where the router has the page.
  const { location } = useAppPlugins();
  useEffect(
    () =>
      location.showing({
        page: { spaceId: page.spaceId, pageId: page.pageId },
        version: model.view,
        revision: revisionId,
      }),
    // `page` is new each render; its IDs aren't.
    [location, page.spaceId, page.pageId, model.view, revisionId],
  );

  return (
    <PageCard ref={setCard} find={find}>
      <CoverBand
        banner={shown?.cover.banner ?? { kind: 'theme' }}
        attachments={{ ctx, page, audience: model.view, attachments: shown?.attachments ?? [] }}
      >
        <Popover
          open={picker === 'banner'}
          onOpenChange={(open) => setPicker(open ? 'banner' : null)}
        >
          <PopoverAnchor asChild>
            <PageToolbar>
              {/* On phones: only the folder, and History and Share as icons, to fit one row. */}
              <nav
                ref={crumbsNav}
                aria-label="Breadcrumbs"
                tabIndex={-1}
                className="min-w-0 flex-1 truncate font-bold outline-none"
              >
                {crumbs.map((crumb, index) => {
                  const last = index === crumbs.length - 1;
                  return (
                    <span key={index} className={cn(!last && 'max-[899px]:hidden')}>
                      <Name>{crumb}</Name>
                      {!last && ' › '}
                    </span>
                  );
                })}
              </nav>
              <AssistantButton />
              {OWN_PANELS.map(({ id, label, icon: Icon }) => (
                <Button key={id} variant="ghost" size="sm" {...needs.click(() => setPanel(id))}>
                  <Icon strokeWidth={1.75} /> <span className="max-[899px]:sr-only">{label}</span>
                </Button>
              ))}
              <Place name="page.toolbar" shown={pluginShown} />
              <PagePlugins shown={pluginShown} onOpenPanel={setPanel} />
              {shareable && (
                <Button variant="ghost" size="sm" {...needs.click(() => setSharing(true))}>
                  <Share strokeWidth={1.75} /> <span className="max-[899px]:sr-only">Share</span>
                </Button>
              )}
              {model.actions.edit && (
                <Button
                  size="sm"
                  // Drafts are saved on this device offline (ADR 0009, decision 7).
                  onClick={() => void act(() => runCommand(editPage, page, commandEnv))}
                >
                  <Pencil strokeWidth={1.75} /> Edit
                </Button>
              )}
              {editingCover && (
                <Button
                  ref={bannerButton}
                  variant="ghost"
                  size="sm"
                  aria-expanded={picker === 'banner'}
                  className="max-[899px]:hidden"
                  onClick={() => {
                    if (picker === 'banner') {
                      setPicker(null);
                      return;
                    }
                    pickerFocus.opener.current = bannerButton.current;
                    void act(() => runCommand(changeBanner, page, coverEnv));
                  }}
                >
                  <Image strokeWidth={1.75} /> Banner
                </Button>
              )}
              {model.actions.done && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void done()}>
                  Done
                </Button>
              )}
              {model.actions.publish && (
                <Button size="sm" disabled={busy} {...here.click('publish', () => void publish())}>
                  <Check strokeWidth={1.75} /> Publish
                </Button>
              )}
              {model.actions.detach && (
                <Button size="sm" variant="secondary" {...needs.click(() => setDetaching(true))}>
                  <Unlink strokeWidth={1.75} /> Detach to edit…
                </Button>
              )}
              {/* Everyone has it, for Find on page, which phones have no key for. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  ref={menuButton}
                  aria-label="Page actions"
                  className="grid size-8 place-items-center rounded-control hover:tint active:tint-strong"
                >
                  <MoreHorizontal className="size-4" strokeWidth={1.75} />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => {
                    if (fromMenu.current) event.preventDefault();
                    fromMenu.current = false;
                  }}
                >
                  <DropdownMenuItem
                    onSelect={() => {
                      fromMenu.current = true;
                      find.open(menuButton.current);
                    }}
                  >
                    Find on page
                  </DropdownMenuItem>
                  {/* On phones the toolbar has no room for Banner. */}
                  {editingCover && (
                    <>
                      <DropdownMenuItem
                        className="min-[900px]:hidden"
                        onSelect={() => openFromMenu(changeBanner)}
                      >
                        Change banner
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="min-[900px]:hidden"
                        onSelect={() => openFromMenu(changeEmoji)}
                      >
                        {icon ? 'Change image' : symbol ? 'Change icon' : 'Change emoji'}
                      </DropdownMenuItem>
                    </>
                  )}
                  {canEdit && (
                    <DropdownMenuItem {...here.select('move', () => setMoving('move'))}>
                      Move to…
                    </DropdownMenuItem>
                  )}
                  {canEdit && (
                    <DropdownMenuItem {...here.select('copy', () => setMoving('copy'))}>
                      Copy to…
                    </DropdownMenuItem>
                  )}
                  {/* Only someone who can publish a page publishes it elsewhere (section 13). */}
                  {canEdit && info.canPublish && (
                    <DropdownMenuItem
                      {...here.select('publish-elsewhere', () => setPublishing(true))}
                    >
                      Publish to another space…
                    </DropdownMenuItem>
                  )}
                  {publishedHead && info.canPublish && (
                    <DropdownMenuItem {...here.select('server', onShareLink)}>
                      Share public link…
                    </DropdownMenuItem>
                  )}
                  {publishedHead && info.canPublish && (
                    <DropdownMenuItem {...here.select('server', () => setUnpublishing(true))}>
                      Unpublish…
                    </DropdownMenuItem>
                  )}
                  {sharer && (
                    <DropdownMenuItem
                      variant="destructive"
                      {...here.select('server', () => setDeleting(true))}
                    >
                      Delete page
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </PageToolbar>
          </PopoverAnchor>
          {editingCover && shown && (
            <PopoverContent
              align="end"
              aria-label="Banner"
              onInteractOutside={(event) => {
                // The Banner button toggles the popover itself.
                if (event.target instanceof Node && bannerButton.current?.contains(event.target))
                  event.preventDefault();
                pickerFocus.content.onInteractOutside(event);
              }}
              onCloseAutoFocus={pickerFocus.content.onCloseAutoFocus}
            >
              <BannerPicker
                banner={shown.cover.banner}
                uploading={coverEditor.uploading}
                error={coverEditor.error}
                onChoose={coverEditor.setBanner}
                onUpload={coverEditor.upload}
              />
            </PopoverContent>
          )}
        </Popover>
        {editingCover ? (
          <EmojiPicker
            emoji={emoji}
            hasImage={icon !== null}
            symbol={{
              current: symbol,
              onPick: coverEditor.setSymbol,
              onRemove: () => coverEditor.setSymbol(null),
            }}
            image={{
              current: iconUrl ?? null,
              onPick: coverEditor.uploadIcon,
              onRemove: coverEditor.removeIcon,
              working: 'Encrypting…',
            }}
            open={picker === 'emoji'}
            onOpenChange={(open) => setPicker(open ? 'emoji' : null)}
            onPick={coverEditor.setEmoji}
            returnFocus={pickerFocus.content}
          />
        ) : (
          // An image with no emoji shows once it's decrypted, not as an empty badge.
          (emoji || symbol || iconUrl) && (
            <PageBadge emoji={emoji} symbol={symbol} image={iconUrl ?? null} />
          )
        )}
      </CoverBand>
      <PageColumns
        shown={pluginShown}
        contents={contents ? { headings, card } : null}
        className={bodyTop(emoji !== null || icon !== null || symbol !== null)}
      >
        {actionError && (
          <p role="alert" className="text-sm text-destructive">
            {actionError}
          </p>
        )}
        {model.view === 'published' && (
          <h1 data-find-root className="text-[32px] leading-tight font-extrabold">
            <Name>{pageTitle(payload?.title ?? null)}</Name>
          </h1>
        )}
        <Pills pills={model.pills} older={model.older} onSwitch={(view) => void go(view)}>
          {listedAt && (
            <span
              data-hint="When this device last heard from the server about this space"
              className="rounded-full bg-muted px-2.5 py-[3px] text-subtle-foreground"
            >
              As of {asOf(new Date(listedAt))}
            </span>
          )}
          {provenance && (
            <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-[3px] text-subtle-foreground">
              <span aria-hidden>↗</span>
              {sourceTitle ? (
                <span>
                  Published from “<Name>{sourceTitle}</Name>”
                </span>
              ) : (
                <span>Published from another page</span>
              )}
            </span>
          )}
          {/* Publishers only: the server tells nobody else where the page went. */}
          {publisher && copies && !copiesUnknown && (copies.length > 0 || showingCopies) && (
            <button
              ref={copiesPill}
              type="button"
              {...needs.click(() => setShowingCopies(true))}
              className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-[3px] text-subtle-foreground hover:underline active:tint-strong"
            >
              <span aria-hidden>⇉</span>
              <span>
                Published in {copies.length} other {copies.length === 1 ? 'space' : 'spaces'} ›
              </span>
            </button>
          )}
          {publisher && copiesUnknown && !needs.offline && (
            // Said as it changes, so a retry that fails again is heard.
            <span aria-live="polite">
              <button
                ref={copiesPill}
                type="button"
                onClick={() =>
                  void checkCopies({ cancelRefetch: false }).then(({ isError }) => {
                    // The pill there is now, or with no copies, the page's menu.
                    if (!isError) {
                      requestAnimationFrame(() =>
                        (copiesPill.current ?? menuButton.current)?.focus(),
                      );
                    }
                  })
                }
                className="rounded-full bg-muted px-2.5 py-[3px] text-subtle-foreground hover:underline active:tint-strong"
              >
                {checkingCopies
                  ? 'Checking where else it’s published…'
                  : 'Couldn’t check where else it’s published. Try again ›'}
              </button>
            </span>
          )}
          {/* Everyone who sees the page; only those who can publish it get the link. */}
          {publicLink &&
            (publisher && publishedHead ? (
              <button
                type="button"
                {...here.click('server', onShareLink)}
                className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-[3px] text-subtle-foreground hover:underline active:tint-strong"
              >
                <Globe aria-hidden className="size-3.5" strokeWidth={2} />
                <span>Public link ›</span>
              </button>
            ) : (
              <span
                data-hint="Anyone with the link can read this page"
                className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-[3px] text-subtle-foreground"
              >
                <Globe aria-hidden className="size-3.5" strokeWidth={2} />
                <span>Public link</span>
              </span>
            ))}
          {/* Editors only: the server tells readers of no draft. */}
          {info.agentEdit && (
            <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-[3px] text-subtle-foreground">
              <span aria-hidden>🤖</span>
              <span>
                <span className="sr-only">Draft edited by </span>
                <AgentName
                  ctx={ctx}
                  agentId={info.agentEdit.agentId}
                  serverName={info.agentEdit.agentName}
                  person={agentPersonName(ctx, info.agentEdit.personId, info.agentEdit.personName)}
                  brief
                  told
                />{' '}
                · {ago(info.agentEdit.at, new Date())}
              </span>
            </span>
          )}
        </Pills>
        <ReadingNotices state={queued} />
        {model.view === 'published' && change && (
          <p role="note" className="text-sm text-muted-foreground">
            Changed on this device, not saved yet.
          </p>
        )}
        {canEdit && provenance && info.heads.draftHead === null && !model.actions.detach && (
          <p className="text-sm text-muted-foreground">
            This page is a copy of another page, published to it from there. Someone who can publish
            here can detach it, so it can be edited here.
          </p>
        )}
        {/* A page made offline has no version to fail to open, though one read
              of the queue from before it was made may have tried. */}
        {error && !change?.newPage && <Missing message={errorMessage(error)} />}
        {opened?.kind === 'newer-format' && (
          <Missing message="This version was written by a newer version of WikiStow. Update to open it." />
        )}
        {model.view === 'draft' && draftFrom && (
          <DraftEditor
            ref={editor}
            ctx={ctx}
            page={page}
            base={draftFrom.base}
            head={info.heads.draftHead}
            payload={draftFrom.payload}
            region={draftFrom.region}
            queued={draftFrom.queued}
            onReload={(options) => void viewTheirs(options)}
            hiddenAttachments={coverParts}
            toolbar={<Place name="editor.toolbar" shown={pluginShown} />}
          />
        )}
        {revision && payload && model.view === 'published' && (
          <>
            {contents && (
              <TableOfContents
                headings={headings}
                card={card}
                collapsed
                className="@min-[960px]:hidden"
              />
            )}
            <div ref={setShownBody} data-find-root className="contents">
              <ReadingChanges value={readingHere}>
                <Markdown
                  source={shownMarkdown ?? payload.markdown}
                  attachments={{
                    ctx,
                    page,
                    audience: 'published',
                    attachments: payload.attachments,
                  }}
                  pages={linkable}
                  links={linkTableOf(payload)}
                  notKept={notKept}
                  editing={
                    canEdit
                      ? {
                          parentId: info.parentId,
                          // Offline, a missing link's page is made from the draft view, which knows what is kept.
                          create: !needs.offline && (info.parentId !== null || topOpened),
                        }
                      : null
                  }
                  // A plugin may draw the text in place of the app's reader.
                  bodyIn={(own, body) => (
                    <Replaceable
                      name="page.reader"
                      inputs={{ page, revision: revisionId, markdown: body }}
                    >
                      {own}
                    </Replaceable>
                  )}
                />
              </ReadingChanges>
            </div>
          </>
        )}
        {revision && payload && <LinkedFrom ctx={ctx} page={page} />}
      </PageColumns>
      <Place
        name="page.panel"
        shown={pluginShown}
        open={panel}
        onOpenChange={setPanel}
        own={{
          ctx,
          page,
          // A copy of another page has no draft to change until it is detached.
          editor: canEdit && info.heads.draftHead !== null,
          published: model.view === 'published' ? revisionId : null,
          draft:
            model.view === 'draft'
              ? { flush: async () => editor.current?.flush(), reopen: onReopen }
              : null,
        }}
      />
      {shareable && (
        <ShareDialog
          spaceId={page.spaceId}
          rootId={shareRoot}
          open={sharing}
          onOpenChange={setSharing}
        />
      )}
      <MoveDialog
        spaceId={page.spaceId}
        moving={moving && { id: page.pageId, kind: 'page', name: title, action: moving }}
        onOpenChange={(open) => !open && setMoving(null)}
      />
      <PublishDialog
        page={page}
        title={title}
        version={{ revisionId, audience: model.view }}
        open={publishing}
        onOpenChange={setPublishing}
      />
      <PublishWithLinkDialog
        page={page}
        title={title}
        markdown={publishingMarkdown}
        open={publishingFrom !== null}
        onOpenChange={(open) => !open && setPublishingFrom(null)}
        publish={publishDraft}
        onDone={() => publishingFrom !== null && void showPublished(publishingFrom)}
      />
      {/* Kept while open, so losing publish rights meanwhile doesn't take what it says away. */}
      {(publisher || showingCopies) && (
        <PublishedCopiesDialog
          page={page}
          title={title}
          copies={copies ?? []}
          unknown={copiesUnknown}
          refused={lostRights}
          checking={checkingCopies}
          onRetry={async () => {
            // Not cancelling a check already running, so its outcome is the one told.
            const { error } = await checkCopies({ cancelRefetch: false });
            if (!error) return 'loaded';
            return error instanceof ApiError && error.code === 'forbidden' ? 'refused' : 'failed';
          }}
          open={showingCopies}
          onOpenChange={(open) => {
            setShowingCopies(open);
            // The pill that opened it may have gone or been replaced since:
            // back to the pill there is now, the page's menu, or the top of the page.
            if (!open) {
              requestAnimationFrame(() =>
                (copiesPill.current ?? menuButton.current ?? crumbsNav.current)?.focus(),
              );
            }
          }}
        />
      )}
      {model.actions.detach && (
        <DetachDialog
          page={page}
          title={title}
          open={detaching}
          onOpenChange={setDetaching}
          onDone={() => go('draft')}
        />
      )}
      {publishedHead && (
        <UnpublishDialog
          page={page}
          title={title}
          publishedHead={publishedHead}
          copy={info.heads.draftHead === null}
          permissionVersion={info.permissionVersion}
          open={unpublishing}
          onOpenChange={setUnpublishing}
          onDone={() => go('draft')}
        />
      )}
      <DeletePageDialog
        page={page}
        title={title}
        open={deleting}
        onOpenChange={setDeleting}
        onDone={() => {
          setDeleting(false);
          void navigate({ to: '/s/$spaceId', params: { spaceId: page.spaceId } });
        }}
      />
    </PageCard>
  );
}

function Pills({
  pills,
  older,
  onSwitch,
  children,
}: {
  pills: Pill[];
  older: boolean;
  onSwitch: (view: 'draft' | 'published') => void;
  /** Pills that tell, or open more about the page, after the ones that switch the view. */
  children?: React.ReactNode;
}) {
  const style = (pill: Pill) =>
    pill.kind === 'published'
      ? 'bg-status-published text-status-published-foreground'
      : 'bg-status-draft text-status-draft-foreground';
  return (
    <div className="flex flex-wrap gap-2 text-[12.5px] font-bold">
      {pills.map((pill) => {
        const label = pill.kind === 'published' && older ? 'Older version' : pill.label;
        if (pill.kind === 'not-published' || ('current' in pill && pill.current && !older)) {
          return (
            <span
              key={pill.kind}
              data-hint={pill.kind === 'not-published' ? pill.hint : undefined}
              aria-description={pill.kind === 'not-published' ? pill.hint : undefined}
              className={cn(
                'rounded-full px-2.5 py-[3px]',
                style(pill),
                pill.kind !== 'not-published' && 'ring-[1.5px] ring-current ring-inset',
              )}
            >
              {pill.kind === 'published' ? '✓' : '✎'} {label}
            </span>
          );
        }
        const target = pill.kind === 'draft' ? 'draft' : 'published';
        return (
          <button
            key={pill.kind}
            type="button"
            onClick={() => onSwitch(target)}
            className={cn(
              'rounded-full px-2.5 py-[3px] hover:underline active:tint-strong',
              style(pill),
            )}
          >
            {pill.kind === 'published' ? '✓' : '✎'}{' '}
            {pill.kind === 'published' && older ? 'Latest version' : pill.label} ›
          </button>
        );
      })}
      {children}
    </div>
  );
}

function Missing({ message }: { message: string }) {
  return (
    <div className="grid gap-2 p-8 text-center">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Link to="/" className="text-sm font-bold text-primary">
        Go home
      </Link>
    </div>
  );
}
