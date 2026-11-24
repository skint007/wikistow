import {
  marksIgnored,
  withoutChange,
  withoutLiveState,
  type PagePayload,
  propertyKeyFor,
  setPageProperty,
  setTask,
  taskIndex,
  tasksWithLine,
  splitFrontmatter,
  summarizeChange,
  type ChangeSummary,
  type PropertyValue,
  type TaskChange,
  type TaskItem,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { errorMessage } from '../errors';
import { availability, type Waiting } from '../shell/availability';
import type { PageHeads, View, Viewer } from './view-model';

// Changes made while reading a page (#212): a task ticked, or a value a
// plugin block sets in the frontmatter. Each shows at once, and joins the
// page's queue; once changes pause, the queue is saved as one draft and
// published together, so ticking a whole list makes one version. Only an
// editor who can publish makes them, on the latest publication, while the
// draft has no changes of its own: a publish never takes anyone's draft
// edits with it.
//
// Each change says what to set, never what to toggle, so applying one
// again changes nothing more. It is applied to the newest text as a
// targeted edit, one character for a task (`setTask`) and one value for a
// property (`setPageProperty`), so changes made meanwhile are never
// overwritten. One that no longer applies is left out, and the page says why.

/** A change made while reading: a task ticked or not, or a property set. */
export type ReadingChange =
  | ({ kind: 'task' } & TaskChange)
  | { kind: 'property'; key: string; value: PropertyValue };

/**
 * What a change was made on, as the page showed it at the click (#700): the
 * version of the page's draft waiting on this device, null for none, and
 * the publication. On the device, a change made on another is left out.
 */
export type MadeOn = { version: number | null; publishedOn: string };

/**
 * `change` as made in `shown`, the page as the person saw it: a tick keeps
 * that text, and whether more than one task had its line there (#703).
 * They're counted in `read`, the text `shown` is made from by the changes
 * queued, which has the same tasks, as ticks and properties move none
 * between lines, and which is parsed once however many ticks are made.
 * A tick that already says what it was made in keeps that: one made on
 * the body as it showed while a newer text was read (#728).
 */
export function madeIn(change: ReadingChange, shown: string, read: string): ReadingChange {
  if (change.kind !== 'task' || change.madeIn !== undefined) return change;
  const repeated = tasksWithLine(read, change.line) > 1;
  return { ...change, madeIn: { markdown: shown, repeated } };
}

/** A change left out, as it no longer applies, and why. */
export type Dropped = { change: ReadingChange; reason: string };

/**
 * `change` left out for `reason`: a tick without the text it was made in
 * (`madeIn`), as what a flush left out is kept to be said after the page
 * is left, and the page's whole text mustn't stay with it.
 */
export function leftOut(change: ReadingChange, reason: string): Dropped {
  if (change.kind !== 'task' || change.madeIn === undefined) return { change, reason };
  const { madeIn: _, ...rest } = change;
  return { change: rest, reason };
}

/**
 * Who may make changes while reading, or why not: `hint` says it beside a
 * checkbox that can't be ticked, and is null where nothing needs saying.
 */
export type ReadingRights = { allowed: true } | { allowed: false; hint: string | null };

/** The hint on a page with a public link, which a change made while reading would end. */
export const PUBLIC_LINK_HINT = 'This page has a public link: open the draft to change it';

/**
 * Whether `viewer` may change the page while reading the version
 * `revision` of `view`: an editor who can publish, on the latest
 * publication of a page with a draft, while the draft has no changes,
 * and the page has no public link (`publicLink`, null until that's
 * known). A version its address names (`?rev=`, `pinned`) isn't the latest
 * even when it is now, as it stays that one once a tick publishes. Each
 * publish ends a public page's copy, which Publish asks about first (ADR
 * 0005), so a tick there would end it without asking. Readers are told
 * nothing, as nothing would let them. A tick publishes: `offline` it waits
 * on this device, as an offline draft and its publish, and while another
 * change made offline waits (`waiting`), it waits as `availability` says
 * (ADR 0009, decisions 7 and 8; #695).
 */
export function readingRights({
  viewer,
  heads,
  view,
  revision,
  pinned = false,
  publicLink,
  offline = false,
  waiting = 'none',
}: {
  viewer: Viewer;
  heads: PageHeads;
  view: View;
  revision: string;
  pinned?: boolean;
  publicLink: boolean | null;
  offline?: boolean;
  waiting?: Waiting;
}): ReadingRights {
  if (view !== 'published' || viewer.role === 'reader') return { allowed: false, hint: null };
  const now = availability('tick', { offline, waiting });
  if (!now.allowed) return now;
  if (heads.draftHead === null)
    return {
      allowed: false,
      hint: 'This page is a copy of another page, so it can’t be changed here',
    };
  if (revision !== heads.publishedHead)
    return { allowed: false, hint: 'This is an older version. Open the latest to tick this' };
  if (pinned) return { allowed: false, hint: 'Open the latest version to tick this' };
  if (!viewer.canPublish)
    return { allowed: false, hint: 'Open the draft to tick this: you can’t publish this page' };
  // Offline, links not known are checked as the publish is sent, as a publish waiting is (#331).
  if (publicLink === null && !offline) return { allowed: false, hint: null };
  if (publicLink) return { allowed: false, hint: PUBLIC_LINK_HINT };
  if (heads.draftChanges)
    return { allowed: false, hint: 'Open the draft to tick this: it has unpublished changes' };
  return { allowed: true };
}

/**
 * `markdown` with `change` made, or why it can't be. A property is the
 * key exactly as written, else the first whose name matches it as a
 * reference's does, else a new key (`propertyKeyFor`).
 */
export function applyChange(
  markdown: string,
  change: ReadingChange,
  /** Its task items, as `setTask` takes them. */
  items?: () => ReadonlyMap<number, TaskItem>,
): { ok: true; markdown: string } | { ok: false; reason: string } {
  if (change.kind === 'task') return setTask(markdown, change, items);
  const key = propertyKeyFor(splitFrontmatter(markdown).frontmatter, change.key);
  const edit = setPageProperty(markdown, key, change.value);
  return edit.ok
    ? edit
    : { ok: false, reason: `${change.key} couldn’t be changed: ${edit.reason}` };
}

// How many bodies a page keeps as shown: a run of ticks, with a flush or two among them.
const BODIES_KEPT = 32;

/**
 * The bodies a page showed on this device as this person's changes were
 * made in it, since a text not of their making came (#728). A body drawn
 * from one of them has the tasks of the text shown, where it has them, as
 * ticks and properties move no task in the body; another, though it
 * differs only in what is ticked, may have two same-named tasks swapped.
 * A flush of this person's changes keeps them: the text it published is
 * one of them.
 */
export class ShownBodies {
  readonly #bodies = new Set<string>();

  /** The page shows `read` with `changes` made: each body on the way is kept. */
  see(read: string, changes: readonly ReadingChange[]) {
    let markdown = read;
    let parsed = read;
    const items = () => taskIndex(parsed);
    const first = splitFrontmatter(read).body;
    if (!this.#bodies.has(first)) this.#bodies.clear();
    this.#keep(first);
    for (const change of changes) {
      const made = applyChange(markdown, change, items);
      if (!made.ok) continue;
      markdown = made.markdown;
      if (change.kind === 'property') parsed = markdown;
      else this.#keep(splitFrontmatter(markdown).body);
    }
  }

  /** Whether the page showed `body` as this person's changes were made. */
  has(body: string): boolean {
    return this.#bodies.has(body);
  }

  #keep(body: string) {
    if (this.#bodies.has(body)) return;
    this.#bodies.add(body);
    for (const old of this.#bodies) {
      if (this.#bodies.size <= BODIES_KEPT) break;
      this.#bodies.delete(old);
    }
  }
}

/** `markdown` with each of `changes` made, in order, and those that no longer apply. */
export function applyChanges(
  markdown: string,
  changes: readonly ReadingChange[],
): { markdown: string; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  // Ticks move no block, so the task items found in the text before them
  // hold after them, the page parsed once; a property changed moves them.
  let parsed = markdown;
  const items = () => taskIndex(parsed);
  for (const change of changes) {
    const made = applyChange(markdown, change, items);
    if (!made.ok) dropped.push(leftOut(change, made.reason));
    else {
      markdown = made.markdown;
      if (change.kind === 'property') parsed = markdown;
    }
  }
  return { markdown, dropped };
}

/**
 * Whether `after` is `before` with only tasks ticked or unticked: an
 * offline draft made of what was ticked while reading, which more ticks
 * may go into and publish, as it holds nothing the person typed (#695).
 */
export function onlyTicked(before: PagePayload, after: PagePayload): boolean {
  const plain = (payload: PagePayload) => {
    const kept = withoutLiveState(withoutChange(payload));
    return JSON.stringify({ ...kept, markdown: marksIgnored(kept.markdown) });
  };
  return plain(before) === plain(after);
}

/**
 * Whether `after`, made from `before` by ticks alone, is `before` as it
 * was: each box as `before` has it, though one written `[X]` and ticked
 * again comes back as `[x]` (#700), and nothing else changed. Compared
 * as text, never parsed: a tick changes only a box's mark.
 */
export function tickedBack(before: PagePayload, after: PagePayload): boolean {
  const rest = (payload: PagePayload) =>
    JSON.stringify({ ...withoutLiveState(withoutChange(payload)), markdown: '' });
  return sameTicks(before.markdown, after.markdown) && rest(before) === rest(after);
}

/** Whether `after`, made from `before` by ticks alone, has every box as `before` has it. */
function sameTicks(before: string, after: string): boolean {
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    const was = before[i];
    const is = after[i];
    if (was !== is && !((was === 'X' && is === 'x') || (was === 'x' && is === 'X'))) return false;
  }
  return true;
}

/** What a flush needs of the page, so it can be tried without a server. */
export type FlushOperations = {
  /** The page's heads as they are now. */
  heads: () => Promise<Pick<PageHeads, 'draftHead' | 'publishedHead' | 'draftChanges'>>;
  /** The Markdown of the draft `revisionId`. */
  openDraft: (revisionId: string) => Promise<string>;
  /** Save `markdown` as the draft on top of `basedOn`, opened before; the revision written. */
  saveDraft: (basedOn: string, markdown: string) => Promise<string>;
  /**
   * Publish the draft `expected.draftHead`, saying what it changed
   * (`change`), if the page's heads are still `expected`; the revision written.
   */
  publish: (
    expected: { draftHead: string; publishedHead: string | null },
    change: ChangeSummary,
  ) => Promise<string>;
  /** Whether the page has a public link now, looked up afresh. */
  publicLink: () => Promise<boolean>;
};

/**
 * How a flush went: `published` as one version; saved `in-draft` only, as
 * the draft had changes of its own or someone published meanwhile; or
 * `unchanged`, the page already as asked, or every change left out.
 */
export type Flushed = {
  /** `on-device`: saved on this device as the page's draft, with its publish waiting (#695). */
  outcome: 'published' | 'in-draft' | 'unchanged' | 'on-device';
  dropped: Dropped[];
  /** Left in the draft as the page had a public link by then, which a publish would end. */
  publicLink?: true;
};

/** How many times a flush starts again when someone saved the draft meanwhile. */
export const FLUSH_TRIES = 3;

const stale = (error: unknown) => error instanceof ApiError && error.code === 'stale-head';

/**
 * Save `changes` in the page's draft, and publish it if the draft had no
 * changes of its own: the heads loaded afresh, the draft opened, each
 * change made in its Markdown, and the result saved on top of it. If
 * someone saved meanwhile, it all starts again from the top, up to
 * `FLUSH_TRIES` times. The draft is published only if it was the
 * publication when loaded, and only if neither head moved since
 * (`expected`), and the page has no public link by then, which the
 * publish would end without asking; otherwise the changes stay in the
 * draft. The publication says what the flush changed (`summarizeChange`),
 * so history can label it (ADR 0008). A draft already as asked but with changes of its own, as one
 * a flush saved and then failed to publish leaves it, isn't known to be
 * published: the changes are said to be in the draft.
 */
export async function flushChanges(
  operations: FlushOperations,
  changes: readonly ReadingChange[],
): Promise<Flushed> {
  for (let tries = 1; ; tries++) {
    const heads = await operations.heads();
    if (heads.draftHead === null) throw new Error('This page has no draft to change.');
    const before = await operations.openDraft(heads.draftHead);
    const { markdown, dropped } = applyChanges(before, changes);
    // Told by text only where ticks alone made it: a property set to `x` from `X` is a change.
    const ticks = changes.every((change) => change.kind === 'task');
    if (markdown === before || (ticks && sameTicks(before, markdown))) {
      const kept = dropped.length < changes.length;
      return { outcome: heads.draftChanges && kept ? 'in-draft' : 'unchanged', dropped };
    }
    let saved: string;
    try {
      saved = await operations.saveDraft(heads.draftHead, markdown);
    } catch (error) {
      if (stale(error) && tries < FLUSH_TRIES) continue;
      throw error;
    }
    if (heads.draftChanges) return { outcome: 'in-draft', dropped };
    // A link made since the page was shown: publishing would end its copy without asking.
    if (await operations.publicLink()) return { outcome: 'in-draft', dropped, publicLink: true };
    try {
      await operations.publish(
        { draftHead: saved, publishedHead: heads.publishedHead },
        summarizeChange(before, markdown),
      );
      return { outcome: 'published', dropped };
    } catch (error) {
      if (stale(error)) return { outcome: 'in-draft', dropped };
      throw error;
    }
  }
}

// Each page's last flush, by page: a page's next flush starts once it has
// settled, even from another queue, as one made on returning to the page
// while the one left behind still saves.
const flushing = new Map<string, Promise<unknown>>();

/**
 * The page's flushes under way, from any queue, settled once all are: as
 * one the queue left behind still saves when the person turns to the
 * draft. Undefined while none runs.
 */
export const pageFlushing = (pageId: string): Promise<unknown> | undefined => flushing.get(pageId);

// Each page's publications its flushes made, by the one each replaced:
// kept for the page, not the queue, as one left behind may publish while
// the person is back on the page with another.
const replaced = new Map<string, Map<string, string>>();

/** A flush of `pageId` published `revision` in place of `before`, the publication the person was reading. */
export function notePublished(pageId: string, revision: string, before: string | null) {
  if (before === null) return;
  let page = replaced.get(pageId);
  if (!page) replaced.set(pageId, (page = new Map()));
  page.set(revision, before);
}

/**
 * The publication the person was reading when flushes of `pageId`
 * replaced it, one after another, with `revision`; `revision` itself if
 * none made it. The page keeps one view for them all, so reading goes on
 * where it was.
 */
export function originOf(pageId: string, revision: string): string {
  const page = replaced.get(pageId);
  let origin = revision;
  for (let before = page?.get(origin); before; before = page?.get(origin)) origin = before;
  return origin;
}

// The flushes started as pages were left, each until every batch it
// chains, the ones that start only once the one before has settled, is done.
const leaving = new Set<Promise<unknown>>();

/** `work`, a queue's flush as its page is left, held among those `flushesUnderway` waits for until it settles. */
export function holding<T>(work: Promise<T>): Promise<T> {
  leaving.add(work);
  const done = () => void leaving.delete(work);
  work.then(done, done);
  return work;
}

/**
 * Every page's flushes under way, settled once none is, or null while none
 * runs: closing the app or locking the vault waits for them, the pages
 * left included, whose own guards went with them. A batch a flush chains
 * behind itself counts, as do flushes started meanwhile.
 */
export function flushesUnderway(): Promise<void> | null {
  if (flushing.size === 0 && leaving.size === 0) return null;
  return (async () => {
    for (let all = [...flushing.values(), ...leaving]; all.length > 0;) {
      await Promise.allSettled(all);
      all = [...flushing.values(), ...leaving];
    }
  })();
}

/** `flush` run after the page's flushes before it have settled. */
export function inTurn<T>(pageId: string, flush: () => Promise<T>): Promise<T> {
  const run = (flushing.get(pageId) ?? Promise.resolve()).then(flush);
  const settled = run.then(
    () => {},
    () => {},
  );
  flushing.set(pageId, settled);
  void settled.then(() => {
    if (flushing.get(pageId) === settled) flushing.delete(pageId);
  });
  return run;
}

/** A change in the queue, with an id of its own so a flush takes out just those it saved. */
export type Queued = { id: number; change: ReadingChange; on: MadeOn | null };

/**
 * A page's queue: the changes waiting, those being saved among them;
 * whether a flush is running; how the last one went, until the next is
 * done; why the last failed, until another starts; and how a flush made
 * before this visit went (`told`), until one of this visit starts.
 */
export type ReadingState = {
  changes: readonly Queued[];
  saving: boolean;
  last: Flushed | null;
  error: unknown;
  before: Told | null;
};

/**
 * One page's changes made while reading, and when they're saved: about
 * three seconds after the last one, and at most fifteen after the first
 * waiting, as autosave paces a draft's; at once with `flush()`, as the
 * person leaves. One flush runs at a time, with the changes waiting when it
 * starts; those made during it wait for their own timer. A change stays in
 * the queue, and so on the page, until its flush is done, `flush` there
 * including showing the new version; if it fails, they stay, and the next
 * change or flush tries them again.
 */
export class ReadingQueue {
  #state: ReadingState = { changes: [], saving: false, last: null, error: null, before: null };
  #next = 0;
  #firstAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  readonly #listeners = new Set<() => void>();
  readonly #flush: (
    changes: readonly ReadingChange[],
    on: readonly (MadeOn | null)[],
  ) => Promise<Flushed>;
  readonly #timing: { debounceMs: number; maxWaitMs: number };

  /** `flush` is given the changes, and what each was made on, in the same order. */
  constructor(
    flush: (changes: readonly ReadingChange[], on: readonly (MadeOn | null)[]) => Promise<Flushed>,
    timing = { debounceMs: 3000, maxWaitMs: 15_000 },
  ) {
    this.#flush = flush;
    this.#timing = timing;
  }

  /** The queue as it is now: the same object until it changes, for `useSyncExternalStore`. */
  get = (): ReadingState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(state: Partial<ReadingState>) {
    this.#state = { ...this.#state, ...state };
    for (const listener of this.#listeners) listener();
  }

  /** `change` made, on `on`: shown at once, and saved once changes pause. */
  add = (change: ReadingChange, on: MadeOn | null = null) => {
    this.#set({ changes: [...this.#state.changes, { id: this.#next++, change, on }] });
    this.#schedule();
  };

  #schedule() {
    const now = Date.now();
    this.#firstAt ??= now;
    const wait = Math.min(this.#timing.debounceMs, this.#firstAt + this.#timing.maxWaitMs - now);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        void this.#run(false);
      },
      Math.max(0, wait),
    );
  }

  /** Save what waits now, and with `chain`, what waits once that's done, until none does. */
  async #run(chain: boolean): Promise<void> {
    if (this.#running) {
      await this.#running;
      // A timer that fired during a flush waits for the next, set again for what came meanwhile.
      if (!chain) {
        if (this.#state.changes.length > 0 && !this.#timer) this.#schedule();
        return;
      }
      return this.#run(true);
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const taken = this.#state.changes;
    if (taken.length === 0) return;
    this.#firstAt = null;
    this.#set({ saving: true, error: null, before: null });
    const ids = new Set(taken.map(({ id }) => id));
    let failed = false;
    this.#running = this.#flush(
      taken.map(({ change }) => change),
      taken.map(({ on }) => on),
    ).then(
      (last) =>
        this.#set({
          changes: this.#state.changes.filter(({ id }) => !ids.has(id)),
          saving: false,
          last,
        }),
      (error: unknown) => {
        failed = true;
        this.#set({ saving: false, error });
      },
    );
    try {
      await this.#running;
    } finally {
      this.#running = null;
    }
    if (chain && !failed && this.#state.changes.length > 0) return this.#run(true);
  }

  /** Save every change waiting now, as the person leaves; resolves once they're saved (or failed). */
  flush(): Promise<void> {
    return this.#run(true);
  }

  /** Whether a change waits, or is being saved: one leaving now would lose. */
  busy(): boolean {
    return this.#state.changes.length > 0 || this.#state.saving;
  }

  /** Drop the changes waiting, as the person turns to the draft after they failed to save. */
  discard() {
    if (this.#state.saving || this.#state.changes.length === 0) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#firstAt = null;
    this.#set({ changes: [] });
  }

  /**
   * How a flush of this page from a queue left behind went: said beside
   * what this queue says, even while it saves, until a flush of its own
   * starts after it.
   */
  told(told: Told) {
    this.#set({ before: told });
  }

  /**
   * Forget how this visit's last flush went, so the page says only what
   * comes next. How one before it went (`told`) stays, as the person who
   * comes back to the page's draft at once still needs to hear it.
   */
  forget() {
    if (this.#state.last !== null || this.#state.error !== null)
      this.#set({ last: null, error: null });
  }
}

/** How a flush went, as a queue says it: its outcome, or why it failed. */
export type Told = { last: Flushed | null; error: unknown };

// The queue showing each page now, and how a flush of a page nobody shows
// went, kept until the page shows again.
const showingQueues = new Map<string, ReadingQueue>();
const leftWith = new Map<string, Told>();

/**
 * `queue` shows the page `pageId`: it is told how a flush made after the
 * page was left went, now if that's known, or as it settles. Returns what
 * ends it, as the page goes.
 */
export function showing(pageId: string, queue: ReadingQueue): () => void {
  showingQueues.set(pageId, queue);
  const kept = leftWith.get(pageId);
  leftWith.delete(pageId);
  if (kept) queue.told(kept);
  return () => {
    if (showingQueues.get(pageId) === queue) showingQueues.delete(pageId);
  };
}

/**
 * How a flush made by a queue whose page was left went: told to the queue
 * showing the page now, or kept until one does, so the page still says
 * so, a failure included.
 */
export function leftOutcome(pageId: string, told: Told) {
  const queue = showingQueues.get(pageId);
  if (queue) queue.told(told);
  else leftWith.set(pageId, told);
}

/** What the queue says on the page: saving, how the last flush went, or why it failed. */
export function readingNotices(
  { changes, saving, last, error, before }: ReadingState,
  offline = false,
): string[] {
  const notices: string[] = [];
  if (error !== null) notices.push(failed(error));
  else if (saving || changes.length > 0)
    notices.push(offline ? 'Saving your changes on this device…' : 'Publishing your changes…');
  else if (last?.outcome === 'published') notices.push('Your changes are published.');
  if (!saving) notices.push(...settled(last));
  // A flush from before this visit's, after what this visit's says, each thing once.
  if (before) {
    if (before.error !== null) notices.push(failed(before.error));
    else if (before.last?.outcome === 'published') notices.push('Your changes are published.');
    notices.push(...settled(before.last));
  }
  return [...new Set(notices)];
}

const failed = (error: unknown) => `Couldn’t save your change: ${errorMessage(error)}`;

/** What a settled flush says beyond whether it published: into the draft, and what it left out. */
function settled(last: Flushed | null): string[] {
  const notices: string[] = [];
  if (last?.outcome === 'in-draft')
    notices.push(
      last.publicLink
        ? 'This page has a public link, so your change went into the draft: publish it from there.'
        : 'Your change went into the draft: publish it to show it.',
    );
  for (const { reason } of last?.dropped ?? []) notices.push(`A change was left out. ${reason}`);
  return notices;
}
