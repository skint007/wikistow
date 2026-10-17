import {
  pageOperations,
  spaceOperations,
  type FolderId,
  type PageId,
  type SpaceId,
} from '@wikistow/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ChevronRight, FolderPlus, Plus } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { submitData } from '@/components/form/submit';
import { IconImage } from '@/components/icon-image';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Name, plainText } from '@/components/name';
import { cn } from '@/lib/utils';
import { AgentActivityCard } from '../agents/activity-card';
import { searchIndexChanged, treeQuery } from '../data/queries';
import { decryptedQuery } from '../page/attachments';
import { DeleteButton, DeletePageDialog } from '../page/delete-dialog';
import { destinationsIn, MoveDialog, type Moving } from '../page/move-dialog';
import type { Destination } from '../page/move-model';
import { PublishDialog } from '../page/publish-dialog';
import { UnpublishDialog } from '../page/unpublish-dialog';
import { errorMessage } from '../errors';
import { shareCovering } from '../sharing/model';
import { useOwnerStanding } from '../sharing/owner-standing';
import { ShareDialog } from '../sharing/share-dialog';
import { useClient } from '../vault/store';
import { useExpandedFolders } from './expanded-folders';
import { ExportDialog, type Exporting } from './export-dialog';
import {
  DEFAULT_CHOICE,
  FolderLookDialog,
  FolderLookFields,
  FolderTile,
  folderLook,
  pickedIcon,
  type LookChoice,
} from './folder-look';
import { FolderRenameDialog } from './folder-rename';
import { SpaceHeader } from './space-header';
import {
  FolderMenu,
  folderActions,
  FolderMenuItems,
  PageMenuItems,
  RowMenu,
  shownVersion,
  type PageAction,
  type PageInfo,
} from './tree-menus';

type Tree = Awaited<ReturnType<typeof spaceOperations.loadTree>>;

/** One visible row of the tree, in display order. */
type Row =
  | {
      kind: 'folder';
      id: FolderId;
      parentId: FolderId | null;
      level: number;
      name: string;
      emoji: string;
      tint: string;
      metadata: spaceOperations.LoadedMetadata | null;
      count: number;
      expanded: boolean;
    }
  | {
      kind: 'page';
      id: PageId;
      parentId: FolderId | null;
      level: number;
      title: string;
      emoji: string | null;
      icon: pageOperations.PageIcon | null;
      unpublished: boolean;
    };

export const pageTitle = (title: string | null) => (title?.trim() ? title : 'Untitled');

function folderName(folder: Tree['folders'][number]) {
  const opened = folder.metadata?.opened;
  return opened?.kind === 'current'
    ? { name: opened.metadata.name, ...folderLook(opened.metadata) }
    : { name: 'Unreadable folder', emoji: '⚠️', tint: 'orange' };
}

/**
 * The rows shown: folders first, then pages, each alphabetical. A filter
 * shows matching pages with the folders around them opened.
 */
function visibleRows(tree: Tree, expanded: ReadonlySet<string>, filter: string): Row[] {
  const needle = filter.trim().toLowerCase();
  const matches = (title: string | null) =>
    !needle || pageTitle(title).toLowerCase().includes(needle);
  const rows: Row[] = [];
  const hasMatch = (folderId: FolderId): boolean =>
    tree.pages.some((p) => p.parentId === folderId && matches(p.title)) ||
    tree.folders.some((f) => f.parentId === folderId && hasMatch(f.id));
  const walk = (parentId: FolderId | null, level: number) => {
    const folders = tree.folders
      .filter((f) => f.parentId === parentId && (!needle || hasMatch(f.id)))
      .map((f) => ({ folder: f, ...folderName(f) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const { folder, name, emoji, tint } of folders) {
      const open = needle ? true : expanded.has(folder.id);
      const count =
        tree.folders.filter((f) => f.parentId === folder.id).length +
        tree.pages.filter((p) => p.parentId === folder.id).length;
      rows.push({
        kind: 'folder',
        id: folder.id,
        parentId,
        level,
        name,
        emoji,
        tint,
        metadata: folder.metadata,
        count,
        expanded: open,
      });
      if (open) walk(folder.id, level + 1);
    }
    const pages = tree.pages
      .filter((p) => p.parentId === parentId && matches(p.title))
      .sort((a, b) => pageTitle(a.title).localeCompare(pageTitle(b.title)));
    for (const page of pages) {
      rows.push({
        kind: 'page',
        id: page.id,
        parentId,
        level,
        title: pageTitle(page.title),
        emoji: page.emoji,
        icon: page.icon,
        unpublished: page.draftChanges || page.publishedHead === null,
      });
    }
  };
  walk(null, 1);
  return rows;
}

/** Everything inside a folder, for the delete confirmation. */
function contentsOf(tree: Tree, folderId: FolderId) {
  let folders = 0;
  let pages = 0;
  const walk = (id: FolderId) => {
    pages += tree.pages.filter((p) => p.parentId === id).length;
    for (const child of tree.folders.filter((f) => f.parentId === id)) {
      folders += 1;
      walk(child.id);
    }
  };
  walk(folderId);
  return { folders, pages };
}

/**
 * A page row's image as a 20px rounded square, or its emoji, which also
 * shows while the image loads or if it fails to.
 */
function PageRowIcon({
  page,
  emoji,
  icon,
}: {
  page: pageOperations.PageRef;
  emoji: string | null;
  icon: pageOperations.PageIcon | null;
}) {
  const ctx = useClient();
  const { data: url } = useQuery(
    decryptedQuery({ ctx, page, audience: icon?.audience ?? 'published' }, icon?.ref),
  );
  return (
    <IconImage
      src={url ?? null}
      className="size-5 shrink-0 rounded-[6px]"
      fallback={
        emoji && (
          // Clipped to its own line, whatever the emoji draws.
          <span aria-hidden className="max-w-[1.5em] shrink-0 overflow-hidden leading-none">
            {emoji}
          </span>
        )
      }
    />
  );
}

type Creating = { kind: 'page' | 'folder'; parentId: FolderId | null } | null;

/**
 * A page's Publish to another space, Unpublish or Delete chosen in its row's
 * menu, with the page's info loaded then. Kept while its dialog closes.
 */
type PageDialog = {
  action: Exclude<PageAction, 'move'>;
  pageId: PageId;
  title: string;
  info: PageInfo;
  open: boolean;
};

/**
 * A page or folder being dragged in the tree, where it can be dropped, and
 * the place it is over now, if it can go there.
 */
type Dragging = {
  moving: Moving;
  to: Map<FolderId | null, Destination<FolderId>>;
  over: Destination<FolderId> | null;
};

// Set, empty, on a drag from the tree, since Firefox starts no drag without data.
const DRAG_TYPE = 'application/x-wikistow-node';

export function Sidebar({ spaceId, onNavigate }: { spaceId: SpaceId; onNavigate?: () => void }) {
  const ctx = useClient();
  const { data: tree } = useQuery(treeQuery(ctx, spaceId));
  const params = useParams({ strict: false });
  const navigate = useNavigate();
  const [expanded, setExpanded] = useExpandedFolders(spaceId);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState<Creating>(null);
  const [deleting, setDeleting] = useState<FolderId | null>(null);
  const [renaming, setRenaming] = useState<FolderId | null>(null);
  const [restyling, setRestyling] = useState<FolderId | null>(null);
  const [sharing, setSharing] = useState<{ rootId: FolderId | null } | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [exporting, setExporting] = useState<Exporting | null>(null);
  const [pageDialog, setPageDialog] = useState<PageDialog | null>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const standing = useOwnerStanding(spaceId);
  const [focused, setFocused] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());

  const rows = useMemo(
    () => (tree ? visibleRows(tree, expanded, filter) : []),
    [tree, expanded, filter],
  );
  // While filtering, every folder shows open, and the kept state waits
  // unchanged for the filter to clear. Saving drops folders the tree no
  // longer has, deleted or out of reach.
  const filtering = filter.trim() !== '';
  const toggle = (id: string, open?: boolean) => {
    if (filtering) return;
    setExpanded((current) => {
      const next = new Set(
        tree ? [...current].filter((kept) => tree.folders.some((f) => f.id === kept)) : current,
      );
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  if (!tree) return <SidebarCard>{null}</SidebarCard>;
  // Someone who holds only folders in the space sees no space name: their
  // tree starts at each shared folder (section 7.7).
  const opened = tree.space?.metadata?.opened;
  const spaceName = tree.space
    ? opened?.kind === 'current'
      ? opened.metadata.name
      : 'Space'
    : null;
  // Sharing and deleting folders wait until a new owner has confirmed who added them.
  const sharer = standing === 'owner';
  // Whether the person can change what is under `parentId`: their role in
  // the share that holds it, or in the space.
  const canEditAt = (parentId: FolderId | null) => {
    const role = shareCovering(tree, parentId)?.role ?? tree.space?.role;
    return role === 'editor' || role === 'owner';
  };
  // Nothing can be written or shared at the top of a space whose own name
  // failed its checks; one in a newer format still opened.
  const topOpened = tree.space?.metadata !== null;
  const canEdit = canEditAt(null) && topOpened;
  const focusId =
    focused && rows.some((r) => r.id === focused) ? focused : (params.pageId ?? rows[0]?.id);

  const openPage = (pageId: PageId) => {
    onNavigate?.();
    void navigate({ to: '/s/$spaceId/p/$pageId', params: { spaceId, pageId } });
  };
  const focusRow = (row: Row | undefined) => {
    if (!row) return;
    setFocused(row.id);
    itemRefs.current.get(row.id)?.focus();
  };

  // The WAI-ARIA tree pattern: arrows move, Left and Right fold, Enter opens.
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    // Only keys pressed on a row. A folder's menu and its button sit inside
    // the tree in React, so their keys bubble here too; they handle their own.
    if (!(event.target instanceof HTMLElement) || event.target.role !== 'treeitem') return;
    const index = rows.findIndex((r) => r.id === focusId);
    const row = rows[index];
    if (!row) return;
    const handled = () => event.preventDefault();
    switch (event.key) {
      case 'ArrowDown':
        handled();
        return focusRow(rows[index + 1]);
      case 'ArrowUp':
        handled();
        return focusRow(rows[index - 1]);
      case 'Home':
        handled();
        return focusRow(rows[0]);
      case 'End':
        handled();
        return focusRow(rows.at(-1));
      case 'ArrowRight':
        handled();
        if (row.kind === 'folder' && !row.expanded) return toggle(row.id, true);
        if (row.kind === 'folder') return focusRow(rows[index + 1]);
        return;
      case 'ArrowLeft':
        handled();
        if (row.kind === 'folder' && row.expanded && !filtering) return toggle(row.id, false);
        return focusRow(rows.find((r) => r.id === row.parentId));
      case 'Enter':
        handled();
        return row.kind === 'folder' ? toggle(row.id) : openPage(row.id);
      default:
        // Type-ahead: jump to the next row starting with that letter.
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const label = (r: Row) => (r.kind === 'folder' ? r.name : r.title).toLowerCase();
          const after = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
          focusRow(after.find((r) => label(r).startsWith(event.key.toLowerCase())));
        }
    }
  }

  // Drag and drop moves, for a mouse: a drop opens the move preview on the
  // place dropped on, as Move… does once that place is chosen. Keyboard
  // users have Move… in the menus. A drop on a page is a drop beside it,
  // and one below the rows is at the top of the space.
  // A drag whose row went away meanwhile, moved or deleted elsewhere, is
  // over: the row's dragend never reaches the tree.
  if (dragging && !rows.some((r) => r.id === dragging.moving.id)) setDragging(null);
  const startDrag = (event: DragEvent, moving: Moving) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DRAG_TYPE, '');
    const places = destinationsIn(tree, moving, sharer);
    setDragging({ moving, to: new Map(places.map((d) => [d.parentId, d])), over: null });
  };
  const pointAt = (over: Destination<FolderId> | null) =>
    setDragging((current) => (current && current.over !== over ? { ...current, over } : current));
  // Only a drag from this tree, and only where Move… would offer: not onto
  // itself, inside itself, or where it is.
  const placeAt = (event: DragEvent, parentId: FolderId | null) =>
    event.dataTransfer.types.includes(DRAG_TYPE) ? (dragging?.to.get(parentId) ?? null) : null;
  // For dragenter as well as dragover: a browser takes a drop on whatever
  // took either last, and moving onto a new element fires only dragenter.
  const dragOver = (event: DragEvent, parentId: FolderId | null) => {
    event.stopPropagation();
    const destination = placeAt(event, parentId);
    pointAt(destination);
    if (!destination) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const drop = (event: DragEvent, parentId: FolderId | null) => {
    event.preventDefault();
    event.stopPropagation();
    const destination = placeAt(event, parentId);
    if (dragging && destination) setMoving({ ...dragging.moving, to: destination });
    setDragging(null);
  };
  const dropTarget = (row: Row) => (row.kind === 'folder' ? row.id : row.parentId);

  const deletingContents = deleting ? contentsOf(tree, deleting) : null;
  const deletingName = rows.find((r) => r.id === deleting);

  return (
    <SidebarCard>
      <SpaceHeader
        spaceId={spaceId}
        name={spaceName}
        metadata={tree.space?.metadata}
        onShare={topOpened ? () => setSharing({ rootId: null }) : undefined}
        onExport={() => setExporting({ folderId: null, name: spaceName ?? 'Shared with you' })}
      />
      {canEdit && (
        <div className="flex gap-2">
          <Button
            className="flex-1 rounded-control"
            onClick={() => setCreating({ kind: 'page', parentId: null })}
          >
            <Plus strokeWidth={1.75} /> New page
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label="New folder"
            className="rounded-control"
            onClick={() => setCreating({ kind: 'folder', parentId: null })}
          >
            <FolderPlus strokeWidth={1.75} />
          </Button>
        </div>
      )}
      <Input
        aria-label="Filter pages"
        placeholder="Filter pages"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="rounded-row border-0 bg-muted"
      />
      <ul
        role="tree"
        aria-label={`Pages in ${spaceName === null ? 'folders shared with you' : plainText(spaceName)}`}
        onKeyDown={onKeyDown}
        // Between rows, the place last pointed at holds.
        onDragEnter={(event) => dragging?.over && dragOver(event, dragging.over.parentId)}
        onDragOver={(event) => dragging?.over && dragOver(event, dragging.over.parentId)}
        onDrop={(event) => dragging?.over && drop(event, dragging.over.parentId)}
        onDragLeave={(event) => {
          const to = event.relatedTarget;
          if (!(to instanceof Node) || !event.currentTarget.contains(to)) pointAt(null);
        }}
        onDragEnd={() => setDragging(null)}
        className={cn(
          '-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded-control px-1',
          dragging?.over?.parentId === null && 'bg-primary-soft/60 ring-2 ring-primary ring-inset',
        )}
      >
        {rows.map((row) => {
          const indent = {
            paddingLeft: `${(row.level - 1) * 20 + (row.kind === 'page' ? 18 : 4)}px`,
          };
          const common = {
            role: 'treeitem',
            'aria-level': row.level,
            tabIndex: row.id === focusId ? 0 : -1,
            ref: (element: HTMLLIElement | null) => {
              if (element) itemRefs.current.set(row.id, element);
              else itemRefs.current.delete(row.id);
            },
            onFocus: () => setFocused(row.id),
            onDragEnter: (event: DragEvent) => dragOver(event, dropTarget(row)),
            onDragOver: (event: DragEvent) => dragOver(event, dropTarget(row)),
            onDrop: (event: DragEvent) => drop(event, dropTarget(row)),
          } as const;
          if (row.kind === 'folder') {
            // One list for both menus, so they can't differ.
            const actions = folderActions({
              editing: canEditAt(row.id)
                ? {
                    onNewPage: () => setCreating({ kind: 'page', parentId: row.id }),
                    onNewFolder: () => setCreating({ kind: 'folder', parentId: row.id }),
                    onRename: () => setRenaming(row.id),
                    onRestyle: () => setRestyling(row.id),
                    onMove: () => setMoving({ id: row.id, kind: 'folder', name: row.name }),
                    onShare: sharer ? () => setSharing({ rootId: row.id }) : undefined,
                    onDelete: sharer ? () => setDeleting(row.id) : undefined,
                  }
                : null,
              onExport: () => setExporting({ folderId: row.id, name: row.name }),
            });
            return (
              <RowMenu key={row.id} items={<FolderMenuItems actions={actions} />}>
                <li
                  {...common}
                  aria-expanded={row.expanded}
                  onClick={() => toggle(row.id)}
                  draggable={canEditAt(row.id)}
                  onDragStart={(event) =>
                    startDrag(event, { id: row.id, kind: 'folder', name: row.name })
                  }
                  className={cn(
                    'group flex cursor-pointer items-center gap-2 rounded-control py-1 pr-1 outline-offset-[-2px] hover:tint active:tint-strong has-[button:active]:bg-none',
                    dragging?.over?.parentId === row.id &&
                      'bg-primary-soft ring-2 ring-primary ring-inset',
                  )}
                  style={indent}
                >
                  <ChevronRight
                    aria-hidden
                    className={cn(
                      'size-3.5 shrink-0 text-muted-foreground transition-transform',
                      row.expanded && 'rotate-90',
                    )}
                    strokeWidth={1.75}
                  />
                  <FolderTile
                    metadata={row.metadata}
                    emoji={row.emoji}
                    tint={row.tint}
                    className="size-7 text-sm"
                  />
                  <span className="min-w-0 flex-1 truncate font-extrabold">
                    <Name>{row.name}</Name>
                  </span>
                  <span className="rounded-full bg-muted px-2 text-xs font-bold text-muted-foreground">
                    {row.count}
                  </span>
                  <FolderMenu name={row.name} actions={actions} />
                </li>
              </RowMenu>
            );
          }
          const selected = params.pageId === row.id;
          return (
            <RowMenu
              key={row.id}
              items={
                <PageMenuItems
                  pageId={row.id}
                  sharer={sharer}
                  onOpen={() => openPage(row.id)}
                  onAction={(action, info) =>
                    action === 'move'
                      ? setMoving({ id: row.id, kind: 'page', name: row.title })
                      : setPageDialog({
                          action,
                          pageId: row.id,
                          title: row.title,
                          info,
                          open: true,
                        })
                  }
                />
              }
            >
              <li
                {...common}
                aria-selected={selected}
                onClick={() => openPage(row.id)}
                draggable={canEditAt(row.parentId)}
                onDragStart={(event) =>
                  startDrag(event, { id: row.id, kind: 'page', name: row.title })
                }
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-row py-1.5 pr-2.5 text-subtle-foreground outline-offset-[-2px] hover:tint active:tint-strong aria-selected:hover:bg-none aria-selected:active:bg-none',
                  selected && 'bg-primary-soft font-bold text-primary-ink',
                )}
                style={indent}
              >
                <PageRowIcon page={{ spaceId, pageId: row.id }} emoji={row.emoji} icon={row.icon} />
                <span className="min-w-0 flex-1 truncate">
                  <Name>{row.title}</Name>
                </span>
                {canEditAt(row.parentId) && row.unpublished && (
                  <span className="size-[7px] shrink-0 rounded-full bg-draft-dot">
                    <span className="sr-only">Unpublished changes</span>
                  </span>
                )}
              </li>
            </RowMenu>
          );
        })}
        {rows.length === 0 && (
          <li className="px-2 py-4 text-sm text-muted-foreground">
            {filter ? 'No pages match.' : 'No pages yet.'}
          </li>
        )}
        <li
          aria-hidden
          className="min-h-10 flex-1"
          onDragEnter={(event) => dragOver(event, null)}
          onDragOver={(event) => dragOver(event, null)}
          onDrop={(event) => drop(event, null)}
        />
      </ul>
      {tree.agentActivity && (
        <AgentActivityCard
          ctx={ctx}
          activity={tree.agentActivity}
          title={pageTitle(
            tree.pages.find((p) => p.id === tree.agentActivity?.pageId)?.title ?? null,
          )}
          onOpen={() => {
            const pageId = tree.agentActivity?.pageId;
            if (!pageId) return;
            onNavigate?.();
            void navigate({
              to: '/s/$spaceId/p/$pageId',
              params: { spaceId, pageId },
              search: tree.agentActivity?.draftOnly ? { view: 'draft' } : {},
            });
          }}
        />
      )}
      <CreateDialog
        spaceId={spaceId}
        creating={creating}
        onClose={() => setCreating(null)}
        onCreatedFolder={(folderId, parentId) => {
          if (parentId) toggle(parentId, true);
          toggle(folderId, true);
        }}
        onCreatedPage={openPage}
      />
      <FolderRenameDialog
        spaceId={spaceId}
        folderId={renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
      />
      <FolderLookDialog
        spaceId={spaceId}
        folderId={restyling}
        onOpenChange={(open) => !open && setRestyling(null)}
      />
      <MoveDialog
        spaceId={spaceId}
        moving={moving}
        onOpenChange={(open) => !open && setMoving(null)}
      />
      <ExportDialog
        spaceId={spaceId}
        exporting={exporting}
        onOpenChange={(open) => !open && setExporting(null)}
      />
      {pageDialog && (
        <PageRowDialog
          spaceId={spaceId}
          dialog={pageDialog}
          onClose={() => setPageDialog({ ...pageDialog, open: false })}
        />
      )}
      {sharer && (
        <ShareDialog
          spaceId={spaceId}
          rootId={sharing?.rootId ?? null}
          open={sharing !== null}
          onOpenChange={(open) => !open && setSharing(null)}
        />
      )}
      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete{' '}
              {deletingName?.kind === 'folder' ? (
                <>
                  “<Name>{deletingName.name}</Name>”
                </>
              ) : (
                'folder'
              )}
              ?
            </DialogTitle>
            <DialogDescription>
              This deletes the folder, {deletingContents?.folders ?? 0} folder(s) and{' '}
              {deletingContents?.pages ?? 0} page(s) inside it, with every version and attachment.
              It can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DeleteButton
            spaceId={spaceId}
            nodeId={deleting}
            onDone={() => {
              setDeleting(null);
              const current = tree.pages.find((p) => p.id === params.pageId);
              if (current && deleting && isInside(tree, current.parentId, deleting)) {
                void navigate({ to: '/s/$spaceId', params: { spaceId } });
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </SidebarCard>
  );
}

function isInside(tree: Tree, folderId: FolderId | null, ancestor: FolderId): boolean {
  if (folderId === null) return false;
  if (folderId === ancestor) return true;
  return isInside(tree, tree.folders.find((f) => f.id === folderId)?.parentId ?? null, ancestor);
}

function SidebarCard({ children }: { children: React.ReactNode }) {
  return (
    <aside className="flex h-full min-h-0 flex-col gap-3 rounded-card bg-card p-3.5 shadow-card">
      {children}
    </aside>
  );
}

function CreateDialog({
  spaceId,
  creating,
  onClose,
  onCreatedFolder,
  onCreatedPage,
}: {
  spaceId: SpaceId;
  creating: Creating;
  onClose: () => void;
  onCreatedFolder: (folderId: FolderId, parentId: FolderId | null) => void;
  onCreatedPage: (pageId: PageId) => void;
}) {
  const ctx = useClient();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [look, setLook] = useState<LookChoice>(DEFAULT_CHOICE);
  const kind = creating?.kind ?? 'page';
  const close = () => {
    setLook(DEFAULT_CHOICE);
    onClose();
  };

  async function submit(form: FormData) {
    const name = form.get('name');
    if (!creating || typeof name !== 'string' || !name.trim()) return;
    setError(null);
    try {
      if (creating.kind === 'folder') {
        const folderId = await spaceOperations.createFolder(ctx, {
          spaceId,
          parentId: creating.parentId,
          name: name.trim(),
          look: { emoji: look.emoji, tint: look.tint },
          icon: pickedIcon(look),
        });
        onCreatedFolder(folderId, creating.parentId);
      } else {
        const pageId = await pageOperations.createPage(ctx, {
          spaceId,
          parentId: creating.parentId,
          title: name.trim(),
        });
        onCreatedPage(pageId);
      }
      searchIndexChanged(queryClient);
      await queryClient.invalidateQueries({ queryKey: treeQuery(ctx, spaceId).queryKey });
      close();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <Dialog open={creating !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <form onSubmit={submitData(submit)} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{kind === 'folder' ? 'New folder' : 'New page'}</DialogTitle>
            <DialogDescription>
              {kind === 'folder'
                ? 'Its name, emoji or image, and colour are encrypted.'
                : 'It starts as a private draft. Publish it when it’s ready.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="create-name">{kind === 'folder' ? 'Name' : 'Title'}</Label>
            <Input id="create-name" name="name" required autoFocus maxLength={200} />
          </div>
          {kind === 'folder' && <FolderLookFields look={look} kept={null} onChange={setLook} />}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit">{kind === 'folder' ? 'Create folder' : 'Create page'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Publish to another space, Unpublish or Delete for a page from its row's
 * menu: the dialogs its own page's menu opens, with the info loaded when
 * the row's menu opened.
 */
function PageRowDialog({
  spaceId,
  dialog,
  onClose,
}: {
  spaceId: SpaceId;
  dialog: PageDialog;
  onClose: () => void;
}) {
  const params = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const { action, pageId, title, info, open } = dialog;
  const page = { spaceId, pageId };
  const onOpenChange = (next: boolean) => !next && onClose();
  // Whether the page is the one open, which then shows what's left, as its own menu does.
  const here = params.pageId === pageId;
  const { publishedHead } = info.heads;
  // The open page publishes the version on screen, as from its own menu.
  const version = shownVersion(info, here ? search : {});
  if (action === 'publish') {
    return (
      version && (
        <PublishDialog
          page={page}
          title={title}
          version={version}
          open={open}
          onOpenChange={onOpenChange}
        />
      )
    );
  }
  if (action === 'unpublish') {
    return (
      publishedHead && (
        <UnpublishDialog
          page={page}
          title={title}
          publishedHead={publishedHead}
          copy={info.heads.draftHead === null}
          permissionVersion={info.permissionVersion}
          open={open}
          onOpenChange={onOpenChange}
          onDone={async () => {
            if (here)
              await navigate({
                to: '/s/$spaceId/p/$pageId',
                params: page,
                search: { view: 'draft' },
              });
          }}
        />
      )
    );
  }
  return (
    <DeletePageDialog
      page={page}
      title={title}
      publishedCount={info.heads.publishedCount}
      open={open}
      onOpenChange={onOpenChange}
      onDone={() => {
        onClose();
        if (here) void navigate({ to: '/s/$spaceId', params: { spaceId } });
      }}
    />
  );
}
