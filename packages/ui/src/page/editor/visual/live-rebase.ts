// The visual editor's own formatting, made again over someone else's change
// made alongside it (ADR 0015, **Decided while building it**). Two people
// formatting the same text at once each write the smallest change in
// characters from the text they last took in, and Yjs merging the two can
// splice one's tags inside the other's (#720). So, as prosemirror-collab
// rebases, one of them, by Yjs client, takes its own write out again with a
// `Y.UndoManager` that holds that write alone, which leaves the other
// person's text exactly as they wrote it, and the editor then makes its
// formatting again on top of it and writes once more.
//
// Here is the Yjs side: which writes may be made again, whose changes were
// made alongside them, judged by what those changes' items show their
// writer had, and taking the writes out. Nothing here reads Markdown.
import * as Y from 'yjs';
import type { RemoteUpdate } from '../source/live';

/** How long after it's written a formatting write may be made again. */
export const REBASE_MS = 3_000;
/** How long the side that doesn't make its write again waits for the one that does. */
export const WAIT_MS = 1_000;
/**
 * Typing placed just after what a write took out may have been typed with
 * the write in, or beside those characters while they still stood: Yjs
 * places the two alike. A change that comes this long after the write
 * counts as the first, as one made alongside comes back within a round trip.
 */
export const BESIDE_MS = 750;
/** How many times one formatting change is made again, at most. */
const MAX_REBASES = 3;

type DeleteSet = ReturnType<typeof Y.createDeleteSet>;
type StackItem = Y.UndoManager['undoStack'][number];
type Range = { clock: number; len: number };
/** Runs of Yjs IDs, by client, each client's in order and none touching. */
type Ranges = Map<number, Range[]>;

function add(ranges: Ranges, client: number, clock: number, len: number): void {
  if (len <= 0) return;
  const list = ranges.get(client) ?? [];
  list.push({ clock, len });
  list.sort((a, b) => a.clock - b.clock);
  const merged: Range[] = [];
  for (const range of list) {
    const last = merged.at(-1);
    if (last && range.clock <= last.clock + last.len) {
      last.len = Math.max(last.len, range.clock + range.len - last.clock);
    } else merged.push({ ...range });
  }
  ranges.set(client, merged);
}

function addAll(ranges: Ranges, ds: DeleteSet): void {
  for (const [client, list] of ds.clients)
    for (const { clock, len } of list) add(ranges, client, clock, len);
}

/** Whether any of `client`'s IDs from `clock`, `len` of them, is in `ranges`. */
function touches(ranges: Ranges, client: number, clock: number, len: number): boolean {
  const list = ranges.get(client);
  if (!list) return false;
  let [lo, hi] = [0, list.length - 1];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = list[mid] as Range;
    if (range.clock + range.len <= clock) lo = mid + 1;
    else if (range.clock >= clock + len) hi = mid - 1;
    else return true;
  }
  return false;
}

/** `ds` without what's in `out`, as a Yjs delete set. */
function without(ds: DeleteSet, out: Ranges): DeleteSet {
  const left = Y.createDeleteSet();
  for (const [client, list] of ds.clients) {
    const gone = out.get(client) ?? [];
    const kept: Range[] = [];
    for (const { clock, len } of list) {
      let at = clock;
      const end = clock + len;
      for (const range of gone) {
        if (range.clock + range.len <= at || range.clock >= end) continue;
        if (range.clock > at) kept.push({ clock: at, len: range.clock - at });
        at = Math.max(at, range.clock + range.len);
      }
      if (at < end) kept.push({ clock: at, len: end - at });
    }
    // A delete set's runs are its `DeleteItem`s, which Yjs reads by these two fields.
    if (kept.length > 0) left.clients.set(client, kept as never);
  }
  return left;
}

/** What one change put in and took out. */
type Change = { readonly inserts: Ranges; readonly deletes: Ranges };

const change = (): Change => ({ inserts: new Map(), deletes: new Map() });

/**
 * Whether `a` and `b` changed the same text in `text`: something each put
 * in or took out stands beside the other's, with no character between
 * them that neither touched, standing or taken out before. Changes to the same word apart, as one to its
 * first letter and one to its last, don't meet.
 */
export function meet(text: Y.Text, a: Change, b: Change): boolean {
  let [inA, inB] = [false, false];
  for (let item = text._start; item; item = item.right) {
    const { client, clock } = item.id;
    const hit = (c: Change) =>
      touches(c.inserts, client, clock, item.length) ||
      touches(c.deletes, client, clock, item.length);
    const [hitA, hitB] = [hit(a), hit(b)];
    // A character neither touched stands between them, taken out before or not:
    // Yjs places typing after what was taken out at its place, so typing there
    // later is apart from a write's tags just before it.
    if (!hitA && !hitB) {
      if (item.countable) [inA, inB] = [false, false];
      continue;
    }
    inA ||= hitA;
    inB ||= hitB;
    if (inA && inB) return true;
  }
  return false;
}

/** The runs of `client`'s IDs from `clock`, `len` of them, each in `ranges` or not. */
function parts(ranges: Ranges, client: number, clock: number, len: number) {
  const out: { at: number; len: number; inside: boolean }[] = [];
  let at = clock;
  const end = clock + len;
  for (const range of ranges.get(client) ?? []) {
    if (range.clock + range.len <= at) continue;
    if (range.clock >= end) break;
    if (range.clock > at) out.push({ at, len: range.clock - at, inside: false });
    const stop = Math.min(end, range.clock + range.len);
    out.push({
      at: Math.max(at, range.clock),
      len: stop - Math.max(at, range.clock),
      inside: true,
    });
    at = stop;
  }
  if (at < end) out.push({ at, len: end - at, inside: false });
  return out;
}

/** One of the editor's formatting writes, while it may be made again. */
type Write = {
  /** What the editor makes again, as it gave it. */
  readonly intent: unknown;
  /** Holds this write alone, as `item`. */
  readonly undo: Y.UndoManager;
  readonly item: StackItem;
  /** What it took out, which its undo keeps from Yjs's clean-up while it's kept. */
  readonly kept: DeleteSet;
  /** Its own items, by this client's clocks. */
  readonly from: number;
  readonly to: number;
  readonly at: number;
  /** How many times its formatting has been made again before. */
  readonly rebases: number;
  /** What it put in and took out. */
  readonly own: Change;
  /** Others' changes made alongside it, by client. */
  readonly theirs: Map<number, Change>;
  /** What others' updates made alongside it took out, there to take out here or not. */
  readonly gone: Ranges;
  /** Clients whose change made alongside it meets it, and when that came first. */
  readonly met: Map<number, number>;
  /** Someone's change made with it in meets it: they wrote over its text, so it's never taken out. */
  built: boolean;
};

/**
 * The visual editor's formatting writes into `text` for a few seconds after
 * each, and what's heard of others' changes made alongside them.
 */
export class OwnFormatting {
  readonly #text: Y.Text;
  readonly #writes: Write[] = [];
  /** By client, how far into this client's clocks its changes show it had. */
  readonly #knows = new Map<number, number>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(text: Y.Text) {
    this.#text = text;
  }

  get #doc(): Y.Doc | null {
    return this.#text.doc;
  }

  /**
   * Make one of the editor's writes, `write`, which calls `mark` with its
   * transaction; and if it's formatting alone (`intent`), keep it to make
   * again. Not code (`literal`): text in code reads as written and outside
   * it as Markdown, so taking it out would change what others typed beside
   * or inside it. Any other is as the person's own change (`own`).
   */
  capture(
    intent: unknown,
    { rebases, literal }: { rebases: number; literal: boolean },
    write: (mark: (transaction: Y.Transaction) => void) => void,
  ): void {
    const doc = this.#doc;
    this.#prune();
    let made: Y.Transaction | null = null;
    let captured: Y.Transaction | null = null;
    const undo =
      doc && intent !== null && !literal && rebases <= MAX_REBASES
        ? new Y.UndoManager(this.#text, {
            captureTimeout: 0,
            captureTransaction: (transaction) => transaction === captured,
            trackedOrigins: new Set(),
          })
        : null;
    const from = doc ? Y.getState(doc.store, doc.clientID) : 0;
    write((transaction) => {
      made = captured = transaction;
      undo?.addTrackedOrigin(transaction.origin);
    });
    captured = null;
    const item = undo?.undoStack[0];
    const to = doc ? Y.getState(doc.store, doc.clientID) : 0;
    // A write that only takes text out is kept for nothing: nothing of
    // anyone's later change could show they had it (`heard`).
    if (!doc || !undo || !item || undo.undoStack.length !== 1 || to === from) {
      undo?.clear();
      undo?.destroy();
      if (made) this.own(made);
      return;
    }
    const own = change();
    add(own.inserts, doc.clientID, from, to - from);
    addAll(own.deletes, item.deletions);
    this.#writes.push({
      intent,
      undo,
      item,
      kept: item.deletions,
      from,
      to,
      at: performance.now(),
      rebases,
      own,
      theirs: new Map(),
      gone: new Map(),
      met: new Map(),
      built: false,
    });
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      this.#prune();
    }, REBASE_MS + 1);
  }

  /**
   * A change of the person's own to `text` that isn't a formatting write
   * kept, as their typing or the source pane's in split view: a kept
   * write it touches can't be made again without undoing it, so none is.
   */
  own(transaction: Y.Transaction): void {
    if (this.#writes.length === 0) return;
    const doc = this.#doc;
    if (!doc) return;
    const theirs = this.#changeOf(transaction, doc.clientID);
    if (this.#writes.some((write) => meet(this.#text, write.own, theirs))) this.clear();
  }

  /** Someone else's change to `text`, as it went in, with what came with it. */
  heard(transaction: Y.Transaction, from: RemoteUpdate | null): void {
    const doc = this.#doc;
    this.#prune();
    if (!doc || this.#writes.length === 0) return;
    const me = doc.clientID;
    const client = from?.client ?? this.#clientOf(transaction, me);
    if (client === null || client === me) return;
    const update = from ? Y.decodeUpdate(from.update) : null;
    this.#learn(client, transaction, update?.ds ?? null, me);
    this.#learnBeside(client, transaction, update?.ds ?? null, me);
    const known = this.#knows.get(client) ?? 0;
    const now = performance.now();
    const made = this.#changeOf(transaction, me);
    for (const write of this.#writes) {
      // Made with this write in: its items go out in one message, so having
      // one is having all. Over its text, it stays as it is.
      if (known > write.from) {
        write.built ||= meet(this.#text, write.own, made);
        continue;
      }
      const theirs = this.#theirs(write, client);
      for (const [c, list] of made.inserts)
        for (const r of list) add(theirs.inserts, c, r.clock, r.len);
      for (const [c, list] of made.deletes)
        for (const r of list) add(theirs.deletes, c, r.clock, r.len);
      if (update) addAll(write.gone, update.ds);
      // A change that only takes text out shows nothing of what its writer
      // had, however long after it came: it merges as Yjs merges it, even
      // after typing of theirs made alongside.
      // Judged by the change that came alone: one of theirs from before
      // that showed nothing doesn't make a later one meet.
      const typed = made.inserts.size > 0;
      if (typed && !write.met.has(client) && meet(this.#text, write.own, made))
        write.met.set(client, now);
    }
  }

  /**
   * Where the writes to make again start: the first kept write a change made
   * alongside it by a lower client met, if nothing after it is held. One a
   * higher client's change met is theirs to make theirs again over, and one
   * someone wrote over is theirs too: such a write is never taken out, nor
   * any before it, as they may have written over its text already. -1 if
   * none is due.
   */
  #first(): number {
    this.#prune();
    const me = this.#doc?.clientID ?? 0;
    const clients = (write: Write) => [...write.met.keys()];
    const held = this.#writes.findLastIndex(
      (write) => write.built || clients(write).some((c) => c > me),
    );
    return this.#writes.findIndex((write, i) => i > held && clients(write).some((c) => c < me));
  }

  /** Whether a kept write is to be made again (`rebase`). */
  get due(): boolean {
    return this.#first() >= 0;
  }

  /**
   * Until when to wait before taking in others' changes: while a higher
   * client's change met a kept write made alongside it, and nothing of
   * theirs shows they have it yet, for `WAIT_MS` from then, as they're
   * to make theirs again over it. Null if not.
   */
  waitUntil(): number | null {
    this.#prune();
    const me = this.#doc?.clientID ?? 0;
    let until: number | null = null;
    for (const write of this.#writes) {
      for (const [client, at] of write.met) {
        if (client < me || (this.#knows.get(client) ?? 0) > write.from) continue;
        const end = at + WAIT_MS;
        if (end > performance.now()) until = Math.max(until ?? 0, end);
      }
    }
    return until;
  }

  /**
   * The writes due, as `rebase` would take them out: `text` without them,
   * as it would be then, and what the editor would make again of them.
   * Null if none is due.
   */
  pending(): { text: string; intents: unknown[] } | null {
    const first = this.#first();
    if (first < 0) return null;
    const writes = this.#writes.slice(first);
    const me = this.#doc?.clientID ?? 0;
    const mine: Ranges = new Map();
    for (const write of writes) add(mine, me, write.from, write.to - write.from);
    const back: Ranges = new Map();
    const gone = this.#gone(writes);
    for (const write of writes) addAll(back, without(write.kept, gone));
    let text = '';
    for (let item = this.#text._start; item; item = item.right) {
      if (!item.countable || !(item.content instanceof Y.ContentString)) continue;
      const { str } = item.content;
      const { client, clock } = item.id;
      for (const part of parts(item.deleted ? back : mine, client, clock, item.length)) {
        if (part.inside === item.deleted)
          text += str.slice(part.at - clock, part.at - clock + part.len);
      }
    }
    return { text, intents: writes.map((write) => write.intent) };
  }

  /**
   * Make none of the writes due again for what met them so far: `text`
   * reads as it would after. They're kept, for a change that meets them next.
   */
  settle(): void {
    const first = this.#first();
    if (first >= 0) for (const write of this.#writes.slice(first)) write.met.clear();
  }

  // Whatever someone else took out alongside any of `writes`.
  #gone(writes: readonly Write[]): Ranges {
    const gone: Ranges = new Map();
    for (const write of writes) {
      for (const [client, list] of write.gone)
        for (const r of list) add(gone, client, r.clock, r.len);
      for (const theirs of write.theirs.values()) {
        for (const [client, list] of theirs.deletes)
          for (const r of list) add(gone, client, r.clock, r.len);
      }
    }
    return gone;
  }

  /**
   * Take out again the first write that's due and every kept write after
   * it, in `run`'s transaction, never what others took out alongside them;
   * and what to make again of them, in order, and how many times it has
   * been already. Null if none is due.
   */
  rebase(run: (undo: () => void) => void): { intents: unknown[]; rebases: number } | null {
    const first = this.#first();
    if (first < 0) return null;
    const writes = this.#writes.splice(first);
    // Whatever someone else took out alongside any of them stays out.
    const gone = this.#gone(writes);
    run(() => {
      for (const write of writes.toReversed()) {
        write.item.deletions = without(write.kept, gone);
        write.undo.undo();
      }
    });
    for (const write of writes) this.#dispose(write);
    return {
      intents: writes.map((write) => write.intent),
      rebases: Math.max(...writes.map((write) => write.rebases)) + 1,
    };
  }

  /** Keep no write to make again. */
  clear(): void {
    for (const write of this.#writes.splice(0)) this.#dispose(write);
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #prune() {
    const now = performance.now();
    while (this.#writes.length > 0 && now - (this.#writes[0] as Write).at >= REBASE_MS) {
      this.#dispose(this.#writes.shift() as Write);
    }
    if (this.#writes.length > 0 && !this.#timer) {
      const next = (this.#writes[0] as Write).at + REBASE_MS - now;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#prune();
      }, next + 1);
    }
  }

  // What its undo kept of the text it took out goes, as Yjs would have let it.
  #dispose(write: Write) {
    write.undo.destroy();
    const doc = this.#doc;
    if (!doc) return;
    doc.transact((transaction) => {
      Y.iterateDeletedStructs(transaction, write.kept, (struct) => {
        if (struct instanceof Y.Item) struct.keep = false;
      });
    });
    if (doc.gc) Y.tryGc(write.kept, doc.store, doc.gcFilter);
  }

  #theirs(write: Write, client: number): Change {
    const known = write.theirs.get(client);
    if (known) return known;
    const made = change();
    write.theirs.set(client, made);
    return made;
  }

  /** What `transaction` put into and took out of `text` here, but for `me`'s. */
  #changeOf(transaction: Y.Transaction, me: number): Change {
    const made = change();
    for (const [client, after] of transaction.afterState) {
      const before = transaction.beforeState.get(client) ?? 0;
      if (client !== me || transaction.local) add(made.inserts, client, before, after - before);
    }
    addAll(made.deletes, transaction.deleteSet);
    return made;
  }

  /** The client other than `me` whose items `transaction` put in, if just one. */
  #clientOf(transaction: Y.Transaction, me: number): number | null {
    const clients = [...transaction.afterState].filter(
      ([client, after]) => client !== me && after > (transaction.beforeState.get(client) ?? 0),
    );
    return clients.length === 1 ? (clients[0] as [number, number])[0] : null;
  }

  /**
   * What `client`'s change shows it had of the kept writes by what they took
   * out: Yjs puts typing after the deleted characters at its place, so a
   * new item placed just after one a write took out, which the change
   * itself didn't take out, was typed with that write in, if it came long
   * enough after it (`BESIDE_MS`).
   */
  #learnBeside(client: number, transaction: Y.Transaction, ds: DeleteSet | null, me: number) {
    const own: Ranges = new Map();
    if (ds) addAll(own, ds);
    let known = this.#knows.get(client) ?? 0;
    const doc = transaction.doc;
    for (const [writer, after] of transaction.afterState) {
      if (writer === me) continue;
      let clock = transaction.beforeState.get(writer) ?? 0;
      while (clock < after) {
        const struct = Y.getItem(doc.store, Y.createID(writer, clock));
        const origin = struct.origin;
        if (origin && !touches(own, origin.client, origin.clock, 1)) {
          for (const write of this.#writes) {
            if (performance.now() - write.at < BESIDE_MS) continue;
            if (touches(write.own.deletes, origin.client, origin.clock, 1))
              known = Math.max(known, write.from + 1);
          }
        }
        clock = struct.id.clock + struct.length;
      }
    }
    this.#knows.set(client, known);
  }

  /**
   * What `client`'s change shows it had of `me`'s items: those its new
   * items were placed beside, and those it took out. Yjs places a
   * client's items in clock order, so having one it had all before it.
   */
  #learn(client: number, transaction: Y.Transaction, ds: DeleteSet | null, me: number) {
    let known = this.#knows.get(client) ?? 0;
    const doc = transaction.doc;
    for (const [writer, after] of transaction.afterState) {
      if (writer === me) continue;
      let clock = transaction.beforeState.get(writer) ?? 0;
      while (clock < after) {
        const struct = Y.getItem(doc.store, Y.createID(writer, clock));
        for (const id of [struct.origin, struct.rightOrigin]) {
          if (id?.client === me) known = Math.max(known, id.clock + 1);
        }
        clock = struct.id.clock + struct.length;
      }
    }
    for (const sets of [transaction.deleteSet, ds]) {
      for (const { clock, len } of sets?.clients.get(me) ?? [])
        known = Math.max(known, clock + len);
    }
    this.#knows.set(client, known);
  }
}
