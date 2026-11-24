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
// - a run it formatted that someone else formatted too, at once, is one
//   run again: two whole runs side by side, the second goes.
import * as Y from 'yjs';
import {
  applyTo,
  Mapping,
  ownChanges,
  putInto,
  wordsOf,
  type Delta,
  type TextChange,
} from './live-text';

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
// How long a run it formatted is looked out for, as someone else's
// formatting of the same words, made before they had it, may yet arrive.
const RUN_MS = 10_000;

/** A run the editor formatted, put in whole: where it is in `body`, its first and last character, and when. */
type OwnRun = { start: Y.RelativePosition; end: Y.RelativePosition; at: number };

// Whether `id`, a character's, is one of `run`'s, which Yjs numbers in turn.
const inRun = (run: OwnRun, id: Y.ID | null) => {
  const [first, last] = [run.start.item, run.end.item];
  return (
    !!id &&
    !!first &&
    !!last &&
    id.client === first.client &&
    id.clock >= first.clock &&
    id.clock <= last.clock
  );
};

/**
 * Whether the character at `at` in `text`, someone else's, went in beside
 * `run` after they had it, by what Yjs put it in next to: after the run's
 * last character, if it's the first of what they put in after it, or
 * before its first, if it's the last of what they put in before it.
 */
function hadIt(text: Y.Text, run: OwnRun, at: number, after: boolean): boolean {
  const id = Y.createRelativePositionFromTypeIndex(text, at).item;
  const store = text.doc?.store;
  if (!id || !store) return false;
  const item = Y.getItem(store, id);
  if (!(item instanceof Y.Item)) return false;
  if (!after) return inRun(run, item.rightOrigin);
  // A part of what they put in, after another part: its own origin says nothing.
  const origin = item.origin;
  if (item.id.clock !== id.clock || !origin) return false;
  // After the run, Yjs puts what's typed after the word it took the place
  // of, deleted: put in after the run or what's deleted between, they had it.
  for (let left = item.left; left; left = left.left) {
    const holds =
      left.id.client === origin.client &&
      origin.clock >= left.id.clock &&
      origin.clock < left.id.clock + left.length;
    if (holds) return left.deleted || inRun(run, origin);
    if (!left.deleted) return false;
  }
  return false;
}

/**
 * Whether `run` went in beside what someone else put in from `from` to
 * `to` in `text` after this app had it: Yjs put its first character after
 * one of theirs, or its last before one.
 */
function ownHadIt(text: Y.Text, run: OwnRun, { from, to }: { from: number; to: number }): boolean {
  const doc = text.doc;
  if (!doc) return false;
  const placeOf = (id: Y.ID | null) =>
    id &&
    Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON({ item: id }),
      doc,
    )?.index;
  const within = (at: number | null | undefined) => at != null && at >= from && at < to;
  const [first, last] = [run.start.item, run.end.item];
  const firstItem = first && Y.getItem(doc.store, first);
  const lastItem = last && Y.getItem(doc.store, last);
  return (
    (firstItem instanceof Y.Item &&
      firstItem.id.clock === first?.clock &&
      within(placeOf(firstItem.origin))) ||
    (lastItem instanceof Y.Item && within(placeOf(lastItem.rightOrigin)))
  );
}

/** Whether `run`'s tags don't all close in it, as one end of a tag over several words. */
const endOfTag = (run: string) => {
  const tags = run.match(/<\/?[A-Za-z][^<>]*>/g) ?? [];
  const closing = tags.filter((tag) => tag.startsWith('</')).length;
  return closing * 2 !== tags.length;
};

const MINE = Symbol('visual-binding');

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
  /** Runs it formatted, within `RUN_MS`. */
  #runs: OwnRun[] = [];
  /** It's taking a run out, settling it with someone else's. */
  #settling = false;
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
      // Each change of theirs apart, while a run may be settled with one.
      this.#map = followed?.remote(delta, false, this.#runs.length > 0) ?? null;
      // A run it took out, settling, is nobody else's change.
      if (!this.#settling) {
        this.#theirs++;
        this.#by.add(this.#sending);
      }
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
        putInto(text, carried);
      });
    });
    // Refused, as by a session left: the page holds it all the same.
    if (text.toJSON() !== expected) return expected;
    this.#held = next;
    this.#map = expected === next ? Mapping.identity(next.length) : mapping.afterOwn(changes);
    this.#noteRuns(carried);
    return expected;
  }

  // Each run of `carried`, just put in, to settle with someone else's of the same words.
  #noteRuns(carried: readonly TextChange[]) {
    const { text } = this.#body;
    const at = performance.now();
    let shift = 0;
    for (const change of carried) {
      const from = change.from + shift;
      shift += change.insert.length - change.remove;
      if (!change.run || change.insert === '') continue;
      const start = Y.createRelativePositionFromTypeIndex(text, from);
      const end = Y.createRelativePositionFromTypeIndex(text, from + change.insert.length, -1);
      this.#runs.push({ start, end, at });
    }
  }

  /**
   * A run it formatted, beside one someone else put in that reads as the
   * same words, both whole: they formatted the same text at once, neither
   * having the other's (#720). The second in `body` goes, which is the
   * same run for everyone, so whoever takes it out, and however many do,
   * the text reads as the first one's formatting. Beside one whose words
   * take in its own, as of a sentence formatted while it formatted a word
   * in it, its own goes. Only while how `body` changed is followed, to
   * tell their run from the rest.
   */
  #settleRuns(): void {
    const now = performance.now();
    this.#runs = this.#runs.filter((run) => now - run.at < RUN_MS);
    if (this.#runs.length === 0 || !this.#map) return;
    const { text } = this.#body;
    const doc = text.doc;
    if (!doc) return;
    const body = text.toJSON();
    if (this.#map.bodyLength !== body.length) return;
    const added = this.#map.added();
    const place = (at: Y.RelativePosition) =>
      Y.createAbsolutePositionFromRelativePosition(at, doc)?.index ?? null;
    for (const run of this.#runs.slice()) {
      const from = place(run.start);
      const to = place(run.end);
      if (from === null || to === null || to <= from) {
        this.#runs.splice(this.#runs.indexOf(run), 1);
        continue;
      }
      const own = body.slice(from, to);
      const words = wordsOf(own);
      if (words.trim() === '') continue;
      let gone: { from: number; to: number } | null = null;
      for (const theirs of added) {
        if (theirs.to !== from && theirs.from !== to) continue;
        const after = theirs.from === to;
        if (hadIt(text, run, after ? theirs.from : theirs.to - 1, after)) continue;
        // Formatting, as theirs must be: words with marks or tags; or any,
        // when this run went in beside theirs, written before the editor
        // showed it, as only this app can tell then.
        const put = body.slice(theirs.from, theirs.to);
        const their = wordsOf(put);
        const marked = their !== put;
        // The same words, exactly, so nothing else put in beside them goes
        // with them.
        if (their === words && (marked || ownHadIt(text, run, theirs))) {
          // One end of a tag over several words beside a whole run: the
          // whole one goes, so the tag keeps both ends. Else the second.
          const [mineEnd, theirEnd] = [endOfTag(own), endOfTag(put)];
          const theirsGoes = mineEnd !== theirEnd ? mineEnd : after;
          gone = theirsGoes ? theirs : { from, to };
        }
        if (gone) break;
      }
      if (!gone) continue;
      this.#runs.splice(this.#runs.indexOf(run), 1);
      const { from: at, to: end } = gone;
      // As someone else's change: the editor takes in what's left.
      this.#settling = true;
      try {
        this.#body.edit(() => text.delete(at, end - at));
      } finally {
        this.#settling = false;
      }
      return this.#settleRuns();
    }
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
    // The editor's own edit, before others' changes go in over it, and
    // before a run goes, which would take an edit in it with it.
    this.write();
    this.#settleRuns();
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
