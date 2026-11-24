// The visual editor bound to a live session's `body` (ADR 0015 decision 3,
// **The visual editor**), working by block:
// - its own edits go in as the blocks it changed, each the smallest change
//   from the text it last took in, carried onto `body` as it is now where
//   others' changes have reached `body` but not the editor (`live-text.ts`);
// - others' changes go in a block at a time, as step 2's take-in reads
//   them, those arriving within a tenth of a second together, its own
//   unreported edit written first;
// - a block someone is composing a word in with an input method waits
//   until the composition ends;
// - a change that reaches past its block is read whole, at most every
//   second or every twice as long as the last whole read took;
// - what it can't show, it says, naming who changed it;
// - its formatting, if someone else changed the same text alongside it,
//   one of the two, by Yjs client, takes out again and makes again over
//   the other's (`live-rebase.ts`).
import * as Y from 'yjs';
import type { RemoteUpdate } from '../source/live';
import { OwnFormatting } from './live-rebase';
import { applyTo, Mapping, ownChanges, putInto, type Delta } from './live-text';

/** How a take-in went: in, not by block (read whole), or waiting on a composition. */
export type Taking = boolean | 'composing';

/** The visual editor, as the binding drives it. */
export type BoundEditor = {
  /** Its text as it writes it now, its edits included. */
  written(): string;
  /** Take `text` in a block at a time (`take`). */
  take(text: string): Taking | Promise<Taking>;
  /** Show `text`, checked already, read whole: or not yet, if that would touch a block being composed. */
  show(text: string): true | 'composing';
  /** The fidelity check of a whole text, as a page opening has. */
  check(text: string): Promise<{ visual: boolean; reason: string | null }>;
  /**
   * It can't show `body`, which those in `by` changed since it last could:
   * each a person's identity, or null for the person, from elsewhere.
   */
  cantShow(by: readonly (string | null)[], reason: string): void;
  /** It shows `body` again, after it couldn't. */
  canShow(): void;
  /**
   * Its edit since it was last asked, or since it last took text in, if
   * that's formatting alone, as something it can make again (`reapply`)
   * over other text: null if it's anything else, as typing.
   */
  intent?(): unknown;
  /**
   * Whether text inside `intent`'s formatting reads as it's written, as in
   * code, which it would read otherwise without it: such formatting is
   * never made again.
   */
  literal?(intent: unknown): boolean;
  /** Make `intents`, in order, over the text it shows now, as the person's own edit. */
  reapply?(intents: readonly unknown[]): void;
  /**
   * Whether `merged` reads, as the editor reads it, the same as `theirs`
   * with `intents` made again over it: then there's nothing to make again.
   */
  readsAs?(merged: string, theirs: string, intents: readonly unknown[]): boolean;
};

/** The shared `body`, as the binding reads and writes it. */
export type BoundText = {
  text: Y.Text;
  /** Make the person's own change, in one transaction. */
  edit(change: () => void): void;
  /**
   * Hear just before someone else's change goes into the document, with
   * who sent it (null: the person) and the change as it came.
   */
  onBeforeRemote(listener: (senderId: string | null, from?: RemoteUpdate) => void): () => void;
  /** Whether the session still takes the person's changes: not once it has been left. */
  active(): boolean;
};

// Others' changes arriving this close together go in together; a change
// that reaches past its block is read whole at most every `WHOLE_MS`, or
// twice as long as the last whole read took (ADR 0015 decisions 3 and 11).
export const TAKE_MS = 100;
export const WHOLE_MS = 1_000;
const WHOLE_SHARE = 2;
// How often a take-in waiting on a composition looks again, in case its end went unheard.
const COMPOSING_MS = 500;
// A whole read whose text changed while it was checked checks the newer
// text, at most this many times more, before it shows the one it checked.
const RECHECKS = 2;

const MINE = Symbol('visual-binding');
// Its own formatting writes taken out again, to be made again over others'.
const UNDONE = Symbol('visual-binding-undone');

/** Text read from `body` for a take-in or a whole read, and how it became `body` since, while that's followed. */
type Pending = { text: string; map: Mapping | null };

/**
 * The binding of one visual editor to one session's `body`. The editor's
 * text and `body` are the same once it has taken everything in and written
 * every edit; until then `held` is the text it last took in or wrote.
 */
export class VisualBinding {
  readonly #body: BoundText;
  readonly #editor: BoundEditor;
  readonly #stops: (() => void)[] = [];
  /** The text the editor's document stands for in `body`'s terms. */
  #held: string;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** The timer is a wait for someone else's formatting made again (`OwnFormatting.waitUntil`). */
  #holding = false;
  #wholeAt = -Infinity;
  /** A whole read, or a take-in checked off the thread, is under way. */
  #reading = false;
  /** A change came while one was: once it's done, go again. */
  #again = false;
  /** It said it can't show `body`. */
  #blocked = false;
  /** Who changed `body` since the editor last caught up with it; null for the person, from elsewhere. */
  readonly #by = new Set<string | null>();
  /** Who sent the change going into the document now, and the change as it came. */
  #sending: string | null = null;
  #from: RemoteUpdate | null = null;
  /** Its formatting writes it may make again, and what's heard of others' alongside them. */
  readonly #formatting: OwnFormatting;
  /** Formatting taken out of `body` again, to be made again once the editor has taken that in. */
  #reapply: { intents: unknown[]; rebases: number } | null = null;
  /** How many times the formatting being written now has been made again. */
  #rebases = 0;
  /**
   * How `held` became `body`, followed exactly as Yjs told each change:
   * null where it wasn't, as when the editor took in text it read earlier
   * some other way, which a character diff then stands in for.
   */
  #map: Mapping | null = null;
  /** While a take-in or a whole read is checked, how the text it read became `body` since. */
  #pending: Pending | null = null;
  /** Others' changes to `body`, counted. */
  #theirs = 0;
  #destroyed = false;

  constructor(body: BoundText, editor: BoundEditor) {
    this.#body = body;
    this.#editor = editor;
    this.#held = editor.written();
    this.#formatting = new OwnFormatting(body.text);
    this.#stops.push(() => this.#formatting.clear());
    this.#synced();
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      const delta = event.delta as Delta;
      const mine = transaction.meta.get(MINE) === this;
      const undone = transaction.meta.get(UNDONE) === this;
      if (this.#pending) this.#pending.map = this.#pending.map?.remote(delta, mine) ?? null;
      // The person's own from elsewhere in the app, as split view's source
      // pane. Its own writes it tells of as it makes them, and someone
      // else's once their transaction is done (`done`).
      if (transaction.local && !mine && !undone) this.#formatting.own(transaction);
      if (mine) return;
      const followed = this.#map;
      this.#map = followed?.remote(delta) ?? null;
      this.#theirs++;
      // Taken out again, it's to be taken in as anyone's change is, but nobody made it.
      if (!undone) this.#by.add(this.#sending);
      // Too much to follow: catch up at once, so a diff stands in as briefly as can be.
      this.#schedule(followed && !this.#map ? 0 : TAKE_MS);
    };
    body.text.observe(observer);
    this.#stops.push(() => body.text.unobserve(observer));
    // A sender counts for the one transaction its change goes in with: after
    // its observers, whether it touched `body` or not.
    const doc = body.text.doc;
    // Someone else's change, heard whether it touched `body` here or not:
    // one that only takes out what this app took out already still counts.
    // Formatting to make again over theirs goes at once, before anyone
    // writes over the text it takes out.
    const done = (transaction: Y.Transaction) => {
      if (!transaction.local && !this.#destroyed) {
        this.#formatting.heard(transaction, this.#from);
        if (this.#formatting.due) this.#schedule(0);
      }
      this.#sending = null;
      this.#from = null;
    };
    doc?.on('afterTransaction', done);
    this.#stops.push(() => doc?.off('afterTransaction', done));
    this.#stops.push(
      body.onBeforeRemote((senderId, from) => {
        // Its own edit goes in first, as the change of the text it was made on.
        this.write();
        this.#sending = senderId;
        this.#from = from ?? null;
      }),
    );
    if (body.text.toJSON() !== this.#held) this.#schedule();
  }

  /** The text the editor stands for, as `body` holds it. */
  get held(): string {
    return this.#held;
  }

  /** Whether `body` has changes the editor hasn't taken in. */
  get behind(): boolean {
    return this.#body.text.toJSON() !== this.#held;
  }

  /** How `written`, the editor's text, maps to `body` now: null when they're the same. */
  mapping(written = this.#held): Mapping | null {
    const body = this.#body.text.toJSON();
    if (body === written) return null;
    return written === this.#held ? this.#mapNow(body) : this.#between(written, body);
  }

  // How `held` became `body`: as followed, if it still fits them, else by
  // a diff, kept while neither changes, as bars and carets ask often.
  #mapNow(body: string): Mapping {
    const map = this.#map;
    if (map && map.heldLength === this.#held.length && map.bodyLength === body.length) return map;
    if (body === this.#held) return Mapping.identity(body.length);
    return this.#between(this.#held, body);
  }

  #diffed: { held: string; body: string; map: Mapping } | null = null;

  #between(held: string, body: string): Mapping {
    const known = this.#diffed;
    if (known && known.held === held && known.body === body) return known.map;
    const map = Mapping.between(held, body);
    this.#diffed = { held, body, map };
    return map;
  }

  // `held` is `body`, or what's followed from now on starts from the text the editor took in.
  #synced(from?: Pending) {
    const body = this.#body.text.toJSON();
    if (this.#held === body) this.#map = Mapping.identity(body.length);
    else if (from && from.text === this.#held) this.#map = from.map;
    else this.#map = null;
  }

  /**
   * Write the editor's edit not yet in `body`, the blocks it changed,
   * carried onto `body` as it is now; and what `body` then reads, with it.
   * If the session takes no change any more, as once it has been left,
   * that text is still what the page holds.
   */
  write(): string {
    const body = this.#body.text.toJSON();
    if (this.#destroyed) return body;
    const next = this.#editor.written();
    if (next === this.#held) return body;
    const mapping = this.#mapNow(body);
    const changes = ownChanges(this.#held, next);
    const carried = body === this.#held ? changes : mapping.carry(changes);
    const expected = applyTo(body, carried);
    const text = this.#body.text;
    const intent = this.#editor.intent?.() ?? null;
    const rebases = this.#rebases;
    this.#rebases = 0;
    const literal = intent !== null && (this.#editor.literal?.(intent) ?? false);
    this.#formatting.capture(intent, { rebases, literal }, (mark) =>
      this.#body.edit(() => {
        const doc = text.doc;
        if (!doc) return;
        doc.transact((transaction) => {
          transaction.meta.set(MINE, this);
          mark(transaction);
          putInto(text, carried);
        });
      }),
    );
    // Refused, as by a session left: the page holds it all the same.
    if (text.toJSON() !== expected) return expected;
    this.#held = next;
    this.#map = expected === next ? Mapping.identity(next.length) : mapping.afterOwn(changes);
    return expected;
  }

  /** Text was given from elsewhere, which `body` holds: catch up with it soon. */
  nudge(): void {
    this.#schedule();
  }

  /** A composition ended: what waited on it goes in. */
  composed(): void {
    if (this.#destroyed || this.#reading) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#holding = false;
    this.#run();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const stop of this.#stops.splice(0)) stop();
  }

  #schedule(wait = TAKE_MS, holding = false) {
    if (this.#destroyed) return;
    if (this.#reading) return void (this.#again = true);
    if (this.#timer !== null) {
      // Waiting already, unless this is to go at once, or the wait was for
      // another's formatting made again, which a change may have brought.
      if (wait > 0 && !this.#holding) return;
      clearTimeout(this.#timer);
    }
    this.#holding = holding;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#holding = false;
      this.#run();
    }, wait);
  }

  #run() {
    if (this.#destroyed) return;
    if (this.#reading) return void (this.#again = true);
    this.#again = false;
    // Left, its typing goes nowhere: nothing goes in over it.
    if (!this.#body.active()) return;
    // The editor's own edit, before others' changes go in over it.
    this.write();
    // Its formatting someone else changed alongside: taken out again first,
    // to be made again once it has taken in theirs. Or the other is to make
    // theirs again over it: what they send next goes in, not the merge.
    if (this.#formatting.due) {
      // Unless Yjs's merge already reads as their text with its formatting made again.
      const pending = this.#formatting.pending();
      const body = this.#body.text.toJSON();
      if (pending && this.#editor.readsAs?.(body, pending.text, pending.intents))
        this.#formatting.settle();
      else this.#rebase();
    } else {
      const until = this.#formatting.waitUntil();
      if (until !== null) return this.#schedule(Math.max(1, until - performance.now()), true);
    }
    const text = this.#body.text.toJSON();
    if (text === this.#held) {
      // As changes that changed nothing it shows leave it: the same again.
      this.#map = Mapping.identity(text.length);
      this.#reapplied();
      return this.#caughtUp();
    }
    const pending: Pending = { text, map: Mapping.identity(text.length) };
    this.#pending = pending;
    const taking = this.#editor.take(text);
    if (taking instanceof Promise) {
      this.#reading = true;
      void taking
        .catch(() => false as const)
        .then((took) => {
          this.#reading = false;
          this.#took(pending, took);
        });
      return;
    }
    this.#took(pending, taking);
  }

  #took(pending: Pending, took: Taking) {
    this.#pending = null;
    if (this.#destroyed || !this.#body.active()) return;
    if (took === 'composing') return this.#schedule(COMPOSING_MS);
    if (!took) return this.#whole();
    this.#held = this.#editor.written();
    this.#synced(pending);
    this.#reapplied();
    if (this.#again || this.behind) return this.#schedule();
    this.#caughtUp();
  }

  // Take its formatting writes due out of `body` again, as one change of the person's own.
  #rebase() {
    const text = this.#body.text;
    const taken = this.#formatting.rebase((undo) =>
      this.#body.edit(() =>
        text.doc?.transact((transaction) => {
          transaction.meta.set(UNDONE, this);
          undo();
        }),
      ),
    );
    if (!taken) return;
    const was = this.#reapply;
    this.#reapply = was
      ? {
          intents: [...was.intents, ...taken.intents],
          rebases: Math.max(was.rebases, taken.rebases),
        }
      : taken;
  }

  // The editor has taken in `body` with its formatting taken out again:
  // it makes it again, over what it shows now, and that's written at once.
  #reapplied() {
    const reapply = this.#reapply;
    this.#reapply = null;
    if (!reapply || !this.#editor.reapply) return;
    this.#editor.reapply(reapply.intents);
    this.#rebases = reapply.rebases;
    this.write();
    this.#rebases = 0;
  }

  #caughtUp() {
    this.#by.clear();
    if (this.#blocked) {
      this.#blocked = false;
      this.#editor.canShow();
    }
  }

  // `text`, checked, with the editor's own typing since it stood for
  // `heldThen` carried onto it, as it was onto `body`: what it shows of a
  // whole read others typed through, so it never hides the person's typing.
  #withOwn(text: string, pending: Pending, heldThen: string, mapThen: Mapping): Pending {
    const written = this.#editor.written();
    if (written === heldThen) return pending;
    // As followed, its typing exactly where `body` has it.
    if (pending.map) return pending.map.withOwn(text, this.#body.text.toJSON());
    return { text: applyTo(text, mapThen.carry(ownChanges(heldThen, written))), map: null };
  }

  // `text` read whole, checked first, at its pace: before then, by block
  // again. Only checked text, and the editor's own writing, is ever read
  // whole. If others changed `body` while it was checked, the newer text is
  // checked at once, a few times; past that, the text checked goes in with
  // the person's typing meanwhile carried onto it, and what others changed
  // since follows as any change does.
  #whole(rechecks = 0) {
    const due = this.#wholeAt - performance.now();
    if (rechecks === 0 && due > 0) return this.#schedule(due);
    // `body` as it is now, the person's typing in it, is what's checked:
    // what came in before counts as checked, and what comes after as since.
    this.write();
    const text = this.#body.text.toJSON();
    // What the editor stood for then, and how that was `text`, for its typing meanwhile.
    const heldThen = this.#held;
    const mapThen = this.#mapNow(text);
    const started = performance.now();
    this.#wholeAt = started + WHOLE_MS;
    this.#reading = true;
    const by = [...this.#by];
    const theirs = this.#theirs;
    const pending: Pending = { text, map: Mapping.identity(text.length) };
    this.#pending = pending;
    void this.#editor
      .check(text)
      .catch(() => ({ visual: false, reason: null }))
      .then((fidelity) => {
        this.#reading = false;
        this.#pending = null;
        this.#wholeAt = started + Math.max(WHOLE_MS, WHOLE_SHARE * (performance.now() - started));
        if (this.#destroyed || !this.#body.active()) return;
        if (!fidelity.visual) {
          this.#blocked = true;
          this.#editor.cantShow(by, fidelity.reason ?? '');
          // Later changes may make it one it can show again.
          if (this.#again) this.#schedule();
          return;
        }
        // The person's typing meanwhile goes in first.
        this.#pending = pending;
        this.write();
        this.#pending = null;
        const now = this.#body.text.toJSON();
        let shown: Pending;
        if (this.#theirs === theirs) shown = { text: now, map: Mapping.identity(now.length) };
        else if (rechecks < RECHECKS) return this.#whole(rechecks + 1);
        else shown = this.#withOwn(text, pending, heldThen, mapThen);
        if (this.#editor.show(shown.text) === 'composing') return this.#schedule(COMPOSING_MS);
        this.#held = this.#editor.written();
        this.#synced(shown);
        this.#reapplied();
        if (this.#again || this.behind) return this.#schedule();
        this.#caughtUp();
      });
  }
}

/** Whether `doc` holds the binding's own change in `transaction`, as a test tells them apart. */
export const isBindingChange = (transaction: Y.Transaction) => transaction.meta.has(MINE);
