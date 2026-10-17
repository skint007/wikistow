import { pageOperations, RevisionId } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { plainText } from '@/components/name';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { pageQuery } from '../data/queries';
import type { Version } from '../page/publish-dialog';
import { pageViewModel } from '../page/view-model';
import { useClient } from '../vault/store';

/** One item of a row's menu, the same in its ⋯ menu and its right-click menu. */
export type MenuAction = { label: string; onSelect: () => void; destructive: boolean };

/** What opening a page loads: the person's role there, publish rights, and its heads. */
export type PageInfo = Awaited<ReturnType<typeof pageOperations.loadPage>>;

/** An item, or nothing where the person can't do it. */
const action = (label: string, onSelect: (() => void) | undefined, destructive = false) =>
  onSelect && { label, onSelect, destructive };

/** A folder's actions: for editors, what they can do there; for everyone, Export. */
export function folderActions({
  editing,
  onExport,
}: {
  editing: {
    onNewPage: () => void;
    onNewFolder: () => void;
    onRename: () => void;
    onRestyle: () => void;
    onMove: () => void;
    onShare: (() => void) | undefined;
    onDelete: (() => void) | undefined;
  } | null;
  onExport: () => void;
}): MenuAction[] {
  return [
    action('New page here', editing?.onNewPage),
    action('New folder here', editing?.onNewFolder),
    action('Rename…', editing?.onRename),
    action('Emoji and colour…', editing?.onRestyle),
    action('Move…', editing?.onMove),
    action('Share…', editing?.onShare),
    action('Export…', onExport),
    action('Delete folder', editing?.onDelete, true),
  ].filter((item) => item !== undefined);
}

/**
 * The version of a page that opening it shows, which the sidebar publishes
 * elsewhere as the page's menu publishes the one on screen. None for a copy
 * unpublished here.
 */
export function shownVersion(info: PageInfo): Version | null {
  const shown = pageViewModel({ viewer: info, heads: info.heads, requested: {} });
  return shown.found
    ? { revisionId: RevisionId.parse(shown.revision), audience: shown.view }
    : null;
}

/** What a page's menu does besides Open, given the page's info. */
export type PageAction = 'move' | 'publish' | 'unpublish' | 'delete';

/**
 * A page's actions, by the rules of its own page's menu: Move and Publish
 * for editors, Publish only with publish rights, Unpublish with those and a
 * publication, Delete for owners who can share.
 */
function pageActions(
  info: PageInfo,
  sharer: boolean,
  onOpen: () => void,
  onAction: (action: PageAction, info: PageInfo) => void,
): MenuAction[] {
  const canEdit = info.role !== 'reader';
  const when = (allowed: boolean, which: PageAction) =>
    allowed ? () => onAction(which, info) : undefined;
  return [
    action('Open', onOpen),
    action('Move…', when(canEdit, 'move')),
    action(
      'Publish to another space…',
      when(canEdit && info.canPublish && shownVersion(info) !== null, 'publish'),
    ),
    action('Unpublish…', when(info.heads.publishedHead !== null && info.canPublish, 'unpublish')),
    action('Delete page', when(sharer, 'delete'), true),
  ].filter((item) => item !== undefined);
}

/** Each action as an item of either kind of menu. */
function Items({
  actions,
  Item,
}: {
  actions: MenuAction[];
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
}) {
  return actions.map(({ label, onSelect, destructive }) => (
    <Item key={label} variant={destructive ? 'destructive' : 'default'} onSelect={onSelect}>
      {label}
    </Item>
  ));
}

/** A folder row's ⋯ button and its menu, shown on hover, and always on touch. */
export function FolderMenu({ name, actions }: { name: string; actions: MenuAction[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${plainText(name)}`}
        onClick={(event) => event.stopPropagation()}
        className="grid size-6 place-items-center rounded-row text-muted-foreground opacity-0 group-hover:opacity-100 hover:tint focus:opacity-100 active:tint-strong pointer-coarse:opacity-100 data-[state=open]:opacity-100"
      >
        <MoreHorizontal className="size-4" strokeWidth={1.75} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
        <Items actions={actions} Item={DropdownMenuItem} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A tree row's right-click menu, which the menu key and Shift+F10 open on
 * the focused row too. It opens nothing and selects nothing by itself. A
 * long press doesn't open it: on touch, rows keep what a tap does, and
 * folders their ⋯ button.
 */
export function RowMenu({ children, items }: { children: ReactElement; items: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Whether the last press was a touch or a pen, whose long press Radix opens the menu on.
  const touched = useRef(false);
  return (
    <ContextMenu open={open} onOpenChange={(next) => setOpen(next && !touched.current)}>
      <ContextMenuTrigger
        asChild
        onPointerDown={(event) => {
          touched.current = event.pointerType !== 'mouse';
        }}
        onKeyDown={() => {
          touched.current = false;
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}

/** A folder's actions in its right-click menu. */
export function FolderMenuItems({ actions }: { actions: MenuAction[] }) {
  return <Items actions={actions} Item={ContextMenuItem} />;
}

/**
 * A page's actions in its right-click menu. The tree doesn't say what the
 * person can do with a page, so opening the menu loads the page's info
 * first, and offers only Open until it has.
 */
export function PageMenuItems({
  pageId,
  sharer,
  onOpen,
  onAction,
}: {
  pageId: pageOperations.PageRef['pageId'];
  sharer: boolean;
  onOpen: () => void;
  onAction: (action: PageAction, info: PageInfo) => void;
}) {
  const ctx = useClient();
  const { data: info, isPending } = useQuery(pageQuery(ctx, pageId));
  if (!info) {
    return (
      <>
        <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>
        {isPending && <ContextMenuItem disabled>Loading…</ContextMenuItem>}
      </>
    );
  }
  return <Items actions={pageActions(info, sharer, onOpen, onAction)} Item={ContextMenuItem} />;
}
