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
// - what it can't show, it says, naming who changed it.
import * as Y from 'yjs';
import { applyTo, Mapping, ownChanges, putInto } from './live-text';

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
};

/** The shared `body`, as the binding reads and writes it. */
export type BoundText = {
  text: Y.Text;
  /** Make the person's own change, in one transaction. */
  edit(change: () => void): void;
  /** Hear just before someone else's change goes into the document, with who sent it. */
  onBeforeRemote(listener: (senderId: string) => void): () => void;
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
  #wholeAt = -Infinity;
  /** A whole read, or a take-in checked off the thread, is under way. */
  #reading = false;
  /** A change came while one was: once it's done, go again. */
  #again = false;
  /** It said it can't show `body`. */
  #blocked = false;
  /** Who changed `body` since the editor last caught up with it; null for the person, from elsewhere. */
  readonly #by = new Set<string | null>();
  /** Who sent the change going into the document now. */
  #sending: string | null = null;
  #destroyed = false;

  constructor(body: BoundText, editor: BoundEditor) {
    this.#body = body;
    this.#editor = editor;
    this.#held = editor.written();
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (transaction.meta.get(MINE) === this) return;
      this.#by.add(this.#sending);
      this.#schedule();
    };
    body.text.observe(observer);
    this.#stops.push(() => body.text.unobserve(observer));
    // A sender counts for the one transaction its change goes in with: after
    // its observers, whether it touched `body` or not.
    const doc = body.text.doc;
    const done = () => void (this.#sending = null);
    doc?.on('afterTransaction', done);
    this.#stops.push(() => doc?.off('afterTransaction', done));
    this.#stops.push(
      body.onBeforeRemote((senderId) => {
        // Its own edit goes in first, as the change of the text it was made on.
        this.write();
        this.#sending = senderId;
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

  /** How the editor's text maps to `body` now: null when they're the same. */
  mapping(): Mapping | null {
    const body = this.#body.text.toJSON();
    return body === this.#held ? null : new Mapping(this.#held, body);
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
    const changes = ownChanges(this.#held, next);
    const carried = body === this.#held ? changes : new Mapping(this.#held, body).carry(changes);
    const expected = applyTo(body, carried);
    const text = this.#body.text;
    this.#body.edit(() => {
      const doc = text.doc;
      if (!doc) return;
      doc.transact((transaction) => {
        transaction.meta.set(MINE, this);
        putInto(text, carried);
      });
    });
    // Refused, as by a session left: the page holds it all the same.
    if (text.toJSON() !== expected) return expected;
    this.#held = next;
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
    this.#run();
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const stop of this.#stops.splice(0)) stop();
  }

  #schedule(wait = TAKE_MS) {
    if (this.#destroyed) return;
    if (this.#reading) return void (this.#again = true);
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
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
    const text = this.#body.text.toJSON();
    if (text === this.#held) return this.#caughtUp();
    const taking = this.#editor.take(text);
    if (taking instanceof Promise) {
      this.#reading = true;
      void taking
        .catch(() => false as const)
        .then((took) => {
          this.#reading = false;
          this.#took(text, took);
        });
      return;
    }
    this.#took(text, taking);
  }

  #took(text: string, took: Taking) {
    if (this.#destroyed || !this.#body.active()) return;
    if (took === 'composing') return this.#schedule(COMPOSING_MS);
    if (!took) return this.#whole(text);
    this.#held = this.#editor.written();
    if (this.#again || this.behind) return this.#schedule();
    this.#caughtUp();
  }

  #caughtUp() {
    this.#by.clear();
    if (this.#blocked) {
      this.#blocked = false;
      this.#editor.canShow();
    }
  }

  // `text` read whole, checked first, at its pace: before then, by block
  // again. If `body` changed while it was checked, the newer text is checked
  // at once, a few times; past that, the text checked goes in, and what came
  // since follows as any change does. Only checked text is ever read whole.
  #whole(text: string, rechecks = 0) {
    const due = this.#wholeAt - performance.now();
    if (rechecks === 0 && due > 0) return this.#schedule(due);
    const started = performance.now();
    this.#wholeAt = started + WHOLE_MS;
    this.#reading = true;
    const by = [...this.#by];
    void this.#editor
      .check(text)
      .catch(() => ({ visual: false, reason: null }))
      .then((fidelity) => {
        this.#reading = false;
        this.#wholeAt = started + Math.max(WHOLE_MS, WHOLE_SHARE * (performance.now() - started));
        if (this.#destroyed || !this.#body.active()) return;
        if (!fidelity.visual) {
          this.#blocked = true;
          this.#editor.cantShow(by, fidelity.reason ?? '');
          // Later changes may make it one it can show again.
          if (this.#again) this.#schedule();
          return;
        }
        // Typing went on meanwhile, the person's and others'.
        this.write();
        const now = this.#body.text.toJSON();
        if (now !== text && rechecks < RECHECKS) return this.#whole(now, rechecks + 1);
        if (this.#editor.show(text) === 'composing') return this.#schedule(COMPOSING_MS);
        this.#held = this.#editor.written();
        if (this.#again || this.behind) return this.#schedule();
        this.#caughtUp();
      });
  }
}

/** Whether `doc` holds the binding's own change in `transaction`, as a test tells them apart. */
export const isBindingChange = (transaction: Y.Transaction) => transaction.meta.has(MINE);
