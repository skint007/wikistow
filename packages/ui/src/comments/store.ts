import type {
  CommentId,
  CommentQuote,
  PageId,
  Region,
  RevisionId,
  SpaceId,
} from '@wikistow/client';
import { useSyncExternalStore } from 'react';
import { chatStore } from '../ai/chat';
import { vaultStore } from '../vault/store';
import type { Passages } from './passages';

/**
 * The page on screen, as its comments need it (ADR 0014, decision 13): its
 * view, which gives a new comment's audience, and the region of the
 * version shown, against which each comment is checked (decision 4).
 */
export type CommentsPage = {
  spaceId: SpaceId;
  pageId: PageId;
  view: 'draft' | 'published';
  /** Null until the version on screen has opened. */
  region: Region | null;
  /** That version, opened again where its comments don't open in `region`. */
  version: { revisionId: RevisionId; audience: 'draft' | 'published' };
  /** Whether this person can edit the page, and so read comments for editors. */
  editor: boolean;
  /** Whether the page is published now: comments for readers need it. */
  published: boolean;
};

type State = {
  /** Whether the panel is open, in the chat's place. */
  open: boolean;
  page: CommentsPage | null;
  /** The thread to bring into view when the panel opens, as from New comments. */
  showing: CommentId | null;
  /**
   * Unsent comments' passages, by page and view (`unsentKey`), as the
   * unsent text is kept (decision 13): chosen in that view of that page,
   * from a version of it this app opened, and shown in no other box.
   */
  quotes: ReadonlyMap<string, CommentQuote>;
  /** Counts asks to put the focus in the box for a new comment, as after choosing a passage. */
  composing: number;
};

const CLOSED = {
  open: false,
  page: null,
  showing: null,
  quotes: new Map<string, CommentQuote>(),
};
let state: State = { ...CLOSED, composing: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/**
 * Unsent comments, replies and edits, by page, view and box (decision 13):
 * what was typed in one never shows in another, whose page or audience
 * differs. In memory only, and gone when the app locks or signs out.
 */
const unsent = new Map<string, string>();
vaultStore.subscribe(() => {
  if (vaultStore.get().status !== 'unlocked') {
    unsent.clear();
    set(CLOSED);
  }
});

// The chat and the panel share the page's side column: opening one closes the other.
chatStore.subscribe(() => {
  if (chatStore.get().open && state.open) set({ open: false });
});

/** Where an unsent text belongs: one page, one view, and one box in it. */
export const unsentKey = (page: Pick<CommentsPage, 'pageId' | 'view'>, box: string) =>
  `${page.pageId} ${page.view} ${box}`;

export const commentsStore = {
  get: () => state,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  open(showing: CommentId | null = null) {
    chatStore.setOpen(false);
    set({ open: true, showing });
  },
  close: () => set({ open: false, showing: null }),
  setPage: (page: CommentsPage | null) => set({ page }),
  /** Comment on a passage: its quote goes with the page and view's new comment, whose box gets the focus. */
  comment(key: string, quote: CommentQuote) {
    chatStore.setOpen(false);
    set({
      open: true,
      quotes: new Map(state.quotes).set(key, quote),
      composing: state.composing + 1,
    });
  },
  dropQuote(key: string) {
    if (!state.quotes.has(key)) return;
    const quotes = new Map(state.quotes);
    quotes.delete(key);
    set({ quotes });
  },
  /** The thread was brought into view. */
  shown: () => set({ showing: null }),
  unsent: (key: string) => unsent.get(key) ?? '',
  setUnsent(key: string, text: string) {
    if (text) unsent.set(key, text);
    else unsent.delete(key);
  },
};

export const useCommentsStore = () =>
  useSyncExternalStore(commentsStore.subscribe, commentsStore.get);

/**
 * Where the page on screen shows its text, for passages, if anywhere, and
 * a count of changes to that text, as threads' passages may be found or
 * lost by them. Apart from the panel's state, so the page's text changing
 * as it is typed tells only the panel.
 */
type PassagesState = { passages: Passages | null; read: number };
let shown: PassagesState = { passages: null, read: 0 };
const readers = new Set<() => void>();

export const passagesStore = {
  get: () => shown,
  subscribe: (listener: () => void) => {
    readers.add(listener);
    return () => {
      readers.delete(listener);
    };
  },
  set(passages: Passages | null) {
    shown = { passages, read: shown.read + 1 };
    for (const listener of readers) listener();
  },
  /** The page's text changed. */
  reread() {
    shown = { ...shown, read: shown.read + 1 };
    for (const listener of readers) listener();
  },
};

export const usePassagesStore = () =>
  useSyncExternalStore(passagesStore.subscribe, passagesStore.get);
