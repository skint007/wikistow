import { pageOperations, RevisionId, type PageId } from '@wikistow/client';
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
import { useOffline } from '../data/connection';
import { controls, useAvailability, type ActionKind, type Waiting } from './availability';
import { useClient } from '../vault/store';

/**
 * One item of a row's menu, the same in its ⋯ menu and its right-click
 * menu. Its `kind` decides whether it runs offline or while a change made
 * offline waits (`availability`).
 */
export type MenuAction = {
  label: string;
  kind: ActionKind;
  onSelect: () => void;
  destructive: boolean;
};

/** What opening a page loads: the person's role there, publish rights, and its heads. */
export type PageInfo = Awaited<ReturnType<typeof pageOperations.loadPage>>;

/** An item, or nothing where the person can't do it. */
const action = (
  label: string,
  kind: ActionKind,
  onSelect: (() => void) | undefined,
  destructive = false,
) => onSelect && { label, kind, onSelect, destructive };

/**
 * A folder's actions: for everyone, Open and Export; for editors, what they
 * can do there; Import for those who can publish there too.
 */
export function folderActions({
  onOpen,
  editing,
  onExport,
  onImport,
}: {
  onOpen: () => void;
  editing: {
    onNewPage: () => void;
    onNewFromTemplate: () => void;
    onNewFolder: () => void;
    onRename: () => void;
    onRestyle: () => void;
    onMove: () => void;
    onCopy: () => void;
    onShare: (() => void) | undefined;
    onDelete: (() => void) | undefined;
  } | null;
  onExport: () => void;
  onImport: (() => void) | undefined;
}): MenuAction[] {
  return [
    action('Open', 'open', onOpen),
    action('New page here', 'new-page', editing?.onNewPage),
    action('New page from template here', 'server', editing?.onNewFromTemplate),
    action('New folder here', 'new-folder', editing?.onNewFolder),
    action('Rename…', 'rename', editing?.onRename),
    action('Emoji and colour…', 'rename', editing?.onRestyle),
    action('Move to…', 'move', editing?.onMove),
    action('Copy to…', 'copy', editing?.onCopy),
    action('Share…', 'server', editing?.onShare),
    action('Export…', 'server', onExport),
    action('Import…', 'server', onImport),
    action('Delete folder', 'delete', editing?.onDelete, true),
  ].filter((item) => item !== undefined);
}

/**
 * The version of a page that its page shows with `requested`'s view and
 * version, by default what opening it shows: the one the sidebar publishes
 * elsewhere, as the page's own menu publishes the one on screen. None for a
 * copy unpublished here.
 */
export function shownVersion(
  info: PageInfo,
  requested: Parameters<typeof pageViewModel>[0]['requested'] = {},
): Version | null {
  const shown = pageViewModel({ viewer: info, heads: info.heads, requested });
  return shown.found
    ? { revisionId: RevisionId.parse(shown.revision), audience: shown.view }
    : null;
}

/** What a page's menu does besides Open, given the page's info. */
export type PageAction = 'move' | 'copy' | 'publish' | 'public-link' | 'unpublish' | 'delete';

/**
 * A page's actions after Open, by the rules of its own page's menu: Move,
 * Copy and Publish for editors, Publish only with publish rights, Share public
 * link and Unpublish with those and a publication, Delete for those who
 * may delete (`mayDelete`).
 */
function pageActions(
  info: PageInfo,
  deleter: boolean,
  onAction: (action: PageAction, info: PageInfo) => void,
): MenuAction[] {
  const canEdit = info.role !== 'reader';
  const when = (allowed: boolean, which: PageAction) =>
    allowed ? () => onAction(which, info) : undefined;
  return [
    action('Move to…', 'move', when(canEdit, 'move')),
    action('Copy to…', 'copy', when(canEdit, 'copy')),
    action(
      'Publish to another space…',
      'publish-elsewhere',
      when(canEdit && info.canPublish && shownVersion(info) !== null, 'publish'),
    ),
    action(
      'Share public link…',
      'server',
      when(info.heads.publishedHead !== null && info.canPublish, 'public-link'),
    ),
    action(
      'Unpublish…',
      'server',
      when(info.heads.publishedHead !== null && info.canPublish, 'unpublish'),
    ),
    action('Delete page', 'delete', when(deleter, 'delete'), true),
  ].filter((item) => item !== undefined);
}

/** Each action as an item of either kind of menu, for an item with `waiting`. */
function Items({
  actions,
  Item,
  waiting,
}: {
  actions: MenuAction[];
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  waiting: Waiting;
}) {
  const here = controls(useOffline(), waiting);
  return actions.map(({ label, kind, onSelect, destructive }) => (
    <Item
      key={label}
      variant={destructive ? 'destructive' : 'default'}
      {...here.select(kind, onSelect)}
    >
      {label}
    </Item>
  ));
}

/** A folder row's ⋯ button and its menu, shown on hover, and always on touch. */
export function FolderMenu({
  name,
  actions,
  waiting,
}: {
  name: string;
  actions: MenuAction[];
  /** What waits on this device for the folder (`useAvailability`). */
  waiting: Waiting;
}) {
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
        <Items actions={actions} Item={DropdownMenuItem} waiting={waiting} />
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
export function FolderMenuItems({
  actions,
  waiting,
}: {
  actions: MenuAction[];
  /** What waits on this device for the folder (`useAvailability`). */
  waiting: Waiting;
}) {
  return <Items actions={actions} Item={ContextMenuItem} waiting={waiting} />;
}

/**
 * A page's actions in its right-click menu. The tree doesn't say what the
 * person can do with a page, so opening the menu loads the page's info
 * first, and offers only Open until it has.
 */
export function PageMenuItems({
  pageId,
  deleter,
  onOpen,
  onAction,
}: {
  pageId: PageId;
  deleter: boolean;
  onOpen: () => void;
  onAction: (action: PageAction, info: PageInfo) => void;
}) {
  const ctx = useClient();
  const { data: info, isPending } = useQuery(pageQuery(ctx, pageId));
  const { waiting } = useAvailability();
  // Open stays the same item as the rest load, so a menu opened from the keyboard keeps its focus.
  return (
    <>
      <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>
      {info ? (
        <Items
          actions={pageActions(info, deleter, onAction)}
          Item={ContextMenuItem}
          waiting={waiting(pageId)}
        />
      ) : (
        isPending && <ContextMenuItem disabled>Loading…</ContextMenuItem>
      )}
    </>
  );
}
