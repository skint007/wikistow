import type { FolderId, PageId, queueOperations } from '@wikistow/client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useOffline } from '../data/connection';
import { queueQuery } from '../data/offline-changes';
import { useClient } from '../vault/store';

// Whether an action can run now, offline or while a change made offline
// waits to be sent, and if not, what its control says (ADR 0009,
// decisions 7 and 8). Who may do what at all stays with each control: a
// menu leaves out what the person can't do, and `readingRights` decides
// ticks.

/** What a control that waits for the server says offline (ADR 0009, decision 8). */
export const NEEDS_CONNECTION = 'Needs the connection';

/**
 * What a control that waits for a change, or an item, made offline to be
 * sent says (ADR 0009, decision 8).
 */
export const SENDS_FIRST = 'Waits until your change made offline is sent';

/** What the chat says when the person approves its edit to a page with a change waiting. */
export const CHAT_SENDS_FIRST =
  'Your own edit to this page is saved on this device only. Try again once it is sent.';

/** What an action is, as far as the connection and the queue go. */
export type ActionKind =
  | 'open'
  | 'new-page'
  | 'new-folder'
  | 'move'
  | 'copy'
  | 'publish-elsewhere'
  | 'publish'
  | 'restore'
  | 'drag'
  /**
   * A page or folder moved or copied, or dropped, into this folder. The move
   * itself waits for the connection: this is about the folder only.
   */
  | 'into'
  /** A task ticked or a property set while reading, which publishes. */
  | 'tick'
  /** The chat's edit to a page, once approved. */
  | 'chat-edit'
  /** Anything else that needs the server: renaming, sharing, deleting, Settings… */
  | 'server';

/**
 * What waits on this device for an item: nothing, a change to it, or the
 * item itself, made offline, which the server doesn't know yet.
 */
export type Waiting = 'none' | 'changed' | 'made';

/** Whether an action can run now, or the hint its control shows. */
export type Availability = { allowed: true } | { allowed: false; hint: string };

/**
 * Each kind's rules: whether it runs offline, and what waits it holds for.
 * `made`: only the item made offline, as the server can't act on what it
 * doesn't have. `changed`: a change to it too, as acting on the draft the
 * server has would leave out the person's change.
 */
const RULES: Record<ActionKind, { offline: boolean; holds: 'never' | 'made' | 'changed' }> = {
  // Made on this device offline (decision 7).
  open: { offline: true, holds: 'never' },
  'new-page': { offline: true, holds: 'never' },
  'new-folder': { offline: true, holds: 'never' },
  // Act on the page's draft, so never on the one from before its change (decision 8).
  move: { offline: false, holds: 'changed' },
  copy: { offline: false, holds: 'changed' },
  'publish-elsewhere': { offline: false, holds: 'changed' },
  publish: { offline: false, holds: 'changed' },
  restore: { offline: false, holds: 'changed' },
  drag: { offline: false, holds: 'changed' },
  // A folder made offline isn't on the server yet, so nothing goes into it
  // there, nor into what is under it, made offline too.
  into: { offline: true, holds: 'made' },
  tick: { offline: false, holds: 'changed' },
  'chat-edit': { offline: false, holds: 'changed' },
  server: { offline: false, holds: 'made' },
};

/** Whether `kind` can run now on an item with `waiting`, `offline` or not. */
export function availability(
  kind: ActionKind,
  { offline, waiting }: { offline: boolean; waiting: Waiting },
): Availability {
  const rule = RULES[kind];
  if (offline && !rule.offline) return { allowed: false, hint: NEEDS_CONNECTION };
  const { holds } = rule;
  const held = holds === 'changed' ? waiting !== 'none' : holds === 'made' && waiting === 'made';
  if (held) return { allowed: false, hint: kind === 'chat-edit' ? CHAT_SENDS_FIRST : SENDS_FIRST };
  return { allowed: true };
}

/** What waits for an item, given its entry in the queue. */
export const waitingOf = (
  entry:
    | Pick<queueOperations.QueuedPage, 'kind' | 'newPage'>
    | Pick<queueOperations.QueuedFolder, 'kind'>
    | null
    | undefined,
): Waiting => (!entry ? 'none' : entry.kind === 'folder' || entry.newPage ? 'made' : 'changed');

/** A control waiting, dimmed, saying why in its hint, and doing nothing. */
const waitingProps = (hint: string) =>
  ({ 'aria-disabled': true, 'data-hint': hint, 'aria-description': hint }) as const;

const stay = (event: { preventDefault(): void }) => event.preventDefault();

/**
 * The controls for an item with `waiting`. A control that can't run now
 * stays where it is, dimmed with its hint (`aria-disabled`, which keeps the
 * hint showing on hover, as `disabled` wouldn't), and does nothing when
 * pressed. Spread `click(kind, …)` on a button in place of `onClick`, and
 * `select(kind, …)` on a menu item in place of `onSelect`, which keeps the
 * menu open meanwhile.
 */
export function controls(offline: boolean, waiting: Waiting) {
  const hintOf = (kind: ActionKind) => {
    const now = availability(kind, { offline, waiting });
    return now.allowed ? null : now.hint;
  };
  return {
    can: (kind: ActionKind) => availability(kind, { offline, waiting }).allowed,
    click: <E extends { preventDefault(): void }>(
      kind: ActionKind,
      onClick: (event: E) => void,
    ) => {
      const hint = hintOf(kind);
      return hint ? { ...waitingProps(hint), onClick: stay } : { onClick };
    },
    select: (kind: ActionKind, onSelect: (event: Event) => void) => {
      const hint = hintOf(kind);
      return hint ? { ...waitingProps(hint), onSelect: stay } : { onSelect };
    },
  };
}

/**
 * The connection and this device's queue, read once, for controls of the
 * pages and folders of the unlocked vault: `of(id)` gives an item's
 * controls, and `waiting(id)` what waits for it.
 */
export function useAvailability() {
  const ctx = useClient();
  const offline = useOffline();
  const { data: entries } = useQuery(queueQuery(ctx));
  const byId = useMemo(() => new Map(entries?.map((entry) => [entry.id, entry])), [entries]);
  const waiting = (id: PageId | FolderId | null): Waiting =>
    waitingOf(id === null ? null : byId.get(id));
  return { offline, waiting, of: (id: PageId | FolderId | null) => controls(offline, waiting(id)) };
}

/**
 * For controls that wait only for the connection, never for a change made
 * offline, and so work anywhere in the app, outside the vault too: Settings,
 * the rail, the chat, and a page's controls that never meet a change made
 * offline (its panels, Share, which shares its folder, and Detach, which
 * only a copy has). Offline, each waits with "Needs the connection"
 * (`controls`). What acts on a page or folder takes
 * `useAvailability().of(id)` instead, which also holds it while the item,
 * made offline, isn't sent.
 */
export function useNeedsConnection() {
  const offline = useOffline();
  const here = controls(offline, 'none');
  return {
    offline,
    can: here.can,
    click: <E extends { preventDefault(): void }>(onClick: (event: E) => void) =>
      here.click('server', onClick),
    select: (onSelect: (event: Event) => void) => here.select('server', onSelect),
  };
}
