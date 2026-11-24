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
// - a block it wrote that others' formatting at once left not reading
//   cleanly, it puts back as it wrote it, if it's the one to
//   (`live-repair.ts`), before it takes the change in.
import * as Y from 'yjs';
import { repairs, WRITINGS, wrote, writingOf, type Writing } from './live-repair';
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
};

/** The shared `body`, as the binding reads and writes it. */
export type BoundText = {
  text: Y.Text;
  /** Make the person's own change, in one transaction. */
  edit(change: () => void): void;
  /** Hear just before someone else's change goes into the document, with who sent it (null: the person). */
  onBeforeRemote(listener: (senderId: string | null) => void): () => void;
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
// Its own change too, putting back a block, which the editor takes in as others'.
const REPAIR = Symbol('visual-binding-repair');

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
  /** Its own writing into `body`, the latest last (`live-repair.ts`). */
  readonly #writings: Writing[] = [];
  /** Someone else changed `body` since it last wrote. */
  #heard = false;
  /** The person changed `body` from elsewhere in this app since it last took a change in. */
  #elsewhere = false;
  #destroyed = false;

  constructor(body: BoundText, editor: BoundEditor) {
    this.#body = body;
    this.#editor = editor;
    this.#held = editor.written();
    this.#synced();
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      const delta = event.delta as Delta;
      const mine = transaction.meta.get(MINE) === this;
      if (this.#pending) this.#pending.map = this.#pending.map?.remote(delta, mine) ?? null;
      if (mine) return;
      const followed = this.#map;
      this.#map = followed?.remote(delta) ?? null;
      // A repair goes in as it's made, and is taken in at once.
      if (transaction.meta.get(REPAIR) === this) return;
      this.#heard = true;
      if (transaction.local) this.#elsewhere = true;
      this.#theirs++;
      this.#by.add(this.#sending);
      // Too much to follow: catch up at once, so a diff stands in as briefly as can be.
      this.#schedule(followed && !this.#map ? 0 : TAKE_MS);
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
    this.#elsewhere = false;
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
    this.#body.edit(() => {
      const doc = text.doc;
      if (!doc) return;
      doc.transact((transaction) => {
        transaction.meta.set(MINE, this);
        this.#wrote(doc, transaction, () => putInto(text, carried));
      });
    });
    // Refused, as by a session left: the page holds it all the same.
    if (text.toJSON() !== expected) return expected;
    this.#held = next;
    this.#map = expected === next ? Mapping.identity(next.length) : mapping.afterOwn(changes);
    return expected;
  }

  // `put` its own change into `body`, kept as part of its writing.
  #wrote(doc: Y.Doc, transaction: Y.Transaction, put: () => void) {
    const writing = writingOf(doc, this.#writings.at(-1), this.#heard);
    if (writing !== this.#writings.at(-1)) this.#writings.push(writing);
    if (this.#writings.length > WRITINGS) this.#writings.shift();
    this.#heard = false;
    wrote(writing, doc, transaction, performance.now(), put);
  }

  // Blocks others' changes, merged with its own, left not reading cleanly,
  // put back as it wrote them, if it's the one to.
  #repair() {
    const text = this.#body.text;
    const body = text.toJSON();
    // What the person typed elsewhere, as in split view's source pane, isn't anyone's to undo.
    if (this.#writings.length === 0 || body === this.#held || this.#elsewhere) return;
    const changes = repairs(
      text,
      body,
      this.#held,
      this.#mapNow(body),
      this.#writings,
      performance.now(),
    );
    if (changes.length === 0) return;
    this.#body.edit(() =>
      text.doc?.transact((transaction) => {
        transaction.meta.set(REPAIR, this);
        this.#wrote(transaction.doc, transaction, () => putInto(text, changes));
      }),
    );
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
    if (this.#timer !== null) {
      // Waiting already, unless this is to go at once.
      if (wait > 0) return;
      clearTimeout(this.#timer);
    }
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
    this.#repair();
    const text = this.#body.text.toJSON();
    if (text === this.#held) {
      // As changes that changed nothing it shows leave it: the same again.
      this.#map = Mapping.identity(text.length);
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
        if (this.#again || this.behind) return this.#schedule();
        this.#caughtUp();
      });
  }
}

/** Whether `doc` holds the binding's own change in `transaction`, as a test tells them apart. */
export const isBindingChange = (transaction: Y.Transaction) => transaction.meta.has(MINE);
