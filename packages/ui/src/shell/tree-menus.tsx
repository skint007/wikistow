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
import { SENDS_FIRST, useNeedsConnection } from './needs-connection';
import { pageChange, queueQuery } from '../data/offline-changes';
import { useClient } from '../vault/store';

/**
 * One item of a row's menu, the same in its ⋯ menu and its right-click
 * menu. All but Open and making a page or folder need the server
 * (`offline`: works offline, ADR 0009, decisions 7 and 8).
 */
export type MenuAction = {
  label: string;
  onSelect: () => void;
  destructive: boolean;
  offline: boolean;
  /** Waits until the page's change made offline is sent (ADR 0009, decision 8). */
  sendsFirst: boolean;
};

/** What opening a page loads: the person's role there, publish rights, and its heads. */
export type PageInfo = Awaited<ReturnType<typeof pageOperations.loadPage>>;

/** An item, or nothing where the person can't do it. */
const action = (label: string, onSelect: (() => void) | undefined, destructive = false) =>
  onSelect && {
    label,
    onSelect,
    destructive,
    offline: OFFLINE.has(label),
    sendsFirst: SENDS_FIRST_LABELS.has(label),
  };

const OFFLINE = new Set(['Open', 'New page here', 'New folder here']);

// What acts on the page's draft, and so waits for its change made offline.
const SENDS_FIRST_LABELS = new Set(['Move to…', 'Copy to…', 'Publish to another space…']);

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
    action('Open', onOpen),
    action('New page here', editing?.onNewPage),
    action('New page from template here', editing?.onNewFromTemplate),
    action('New folder here', editing?.onNewFolder),
    action('Rename…', editing?.onRename),
    action('Emoji and colour…', editing?.onRestyle),
    action('Move to…', editing?.onMove),
    action('Copy to…', editing?.onCopy),
    action('Share…', editing?.onShare),
    action('Export…', onExport),
    action('Import…', onImport),
    action('Delete folder', editing?.onDelete, true),
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
 * link and Unpublish with those and a publication, Delete for owners who
 * can share.
 */
function pageActions(
  info: PageInfo,
  sharer: boolean,
  onAction: (action: PageAction, info: PageInfo) => void,
): MenuAction[] {
  const canEdit = info.role !== 'reader';
  const when = (allowed: boolean, which: PageAction) =>
    allowed ? () => onAction(which, info) : undefined;
  return [
    action('Move to…', when(canEdit, 'move')),
    action('Copy to…', when(canEdit, 'copy')),
    action(
      'Publish to another space…',
      when(canEdit && info.canPublish && shownVersion(info) !== null, 'publish'),
    ),
    action(
      'Share public link…',
      when(info.heads.publishedHead !== null && info.canPublish, 'public-link'),
    ),
    action('Unpublish…', when(info.heads.publishedHead !== null && info.canPublish, 'unpublish')),
    action('Delete page', when(sharer, 'delete'), true),
  ].filter((item) => item !== undefined);
}

/** Each action as an item of either kind of menu. */
function Items({
  actions,
  Item,
  changed = false,
  made = false,
}: {
  actions: MenuAction[];
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
  /** The page has a change made offline not sent yet. */
  changed?: boolean;
  /**
   * The folder was made offline and isn't sent yet, so the server doesn't
   * know it: all but what works offline waits for it, online too.
   */
  made?: boolean;
}) {
  // Offline, what needs the server says so (ADR 0009, decision 8), and
  // moves and copies wait for the page's change made offline.
  const needs = useNeedsConnection();
  const held = useNeedsConnection(changed || made ? SENDS_FIRST : null);
  return actions.map(({ label, onSelect, destructive, offline, sendsFirst }) => (
    <Item
      key={label}
      variant={destructive ? 'destructive' : 'default'}
      {...(offline ? { onSelect } : (sendsFirst || made ? held : needs).select(onSelect))}
    >
      {label}
    </Item>
  ));
}

/** A folder row's ⋯ button and its menu, shown on hover, and always on touch. */
export function FolderMenu({
  name,
  actions,
  made = false,
}: {
  name: string;
  actions: MenuAction[];
  /** Made offline, not sent yet (`Items`). */
  made?: boolean;
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
        <Items actions={actions} Item={DropdownMenuItem} made={made} />
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
  made = false,
}: {
  actions: MenuAction[];
  /** Made offline, not sent yet (`Items`). */
  made?: boolean;
}) {
  return <Items actions={actions} Item={ContextMenuItem} made={made} />;
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
  pageId: PageId;
  sharer: boolean;
  onOpen: () => void;
  onAction: (action: PageAction, info: PageInfo) => void;
}) {
  const ctx = useClient();
  const { data: info, isPending } = useQuery(pageQuery(ctx, pageId));
  const { data: entries } = useQuery(queueQuery(ctx));
  // Open stays the same item as the rest load, so a menu opened from the keyboard keeps its focus.
  return (
    <>
      <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>
      {info ? (
        <Items
          actions={pageActions(info, sharer, onAction)}
          Item={ContextMenuItem}
          changed={pageChange(entries, pageId) !== null}
        />
      ) : (
        isPending && <ContextMenuItem disabled>Loading…</ContextMenuItem>
      )}
    </>
  );
}
