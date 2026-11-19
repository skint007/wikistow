// The source editor bound to a live session's `body` (ADR 0015 decision 3),
// as `y-codemirror.next` binds one, through an adapter of the app's own:
// - on a page with CRLF line breaks, CodeMirror counts each as one
//   position (`lineSeparator`) where `body` holds two characters, so
//   positions are converted both ways;
// - each change of the person's goes in widened to whole characters, as
//   CodeMirror's own diff can start or end inside an emoji's two halves,
//   which Yjs would store as two U+FFFD for everyone else;
// - others' changes arrive as small edits, kept out of the person's undo
//   history, and the text at their edges is read again from `body`;
// - others' carets and selections show in their colour, with their name.
import {
  Annotation,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSet,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import * as Y from 'yjs';
import { CARET_COLOURS } from './live-colours';
import { resolveIn } from '../live-cursor';

export { CARET_COLOURS, colourOf } from './live-colours';
export { resolveIn } from '../live-cursor';

/** Another person's caret and selection, as their presence says. */
export type RemoteCaret = {
  /** Their join, which keeps the caret's place from one presence to the next. */
  key: string;
  name: string;
  /** Their colour, by number in `CARET_COLOURS`. */
  colour: number;
  /** Yjs relative positions in `body`, encoded. */
  anchor: Uint8Array;
  head: Uint8Array;
};

/** What the source editor binds to while the page is edited live. */
export type LiveSource = {
  /** The page's body in the shared document. */
  text: Y.Text;
  /** Make the person's own change to the document, in one transaction. */
  edit(change: () => void): void;
  /** The origin of the person's own changes, which the binding doesn't take back in. */
  localOrigin: unknown;
  /** Others' carets, and hearing when they change. */
  carets(): readonly RemoteCaret[];
  onCarets(listener: () => void): () => void;
  /**
   * The person's caret and selection moved, as Yjs relative positions in
   * `body`, in `editor` (the source editor's by default). None from an
   * editor the cursor already left for another changes nothing.
   */
  cursor(
    cursor: { anchor: Uint8Array; head: Uint8Array } | null,
    editor?: 'source' | 'visual',
  ): void;
  /**
   * Hear just before someone else's change goes into the document, with
   * who sent it (null: the person, from another tab or device), so an edit
   * not yet in it goes in first (the visual editor's).
   */
  onBeforeRemote?(listener: (senderId: string | null) => void): () => void;
  /** The name a person is shown by, as their caret is. */
  nameOf?(id: string): string;
  /** Whether the session still takes the person's changes: not once it has been left. */
  active?(): boolean;
};

// Others' changes, which aren't reported as the person's edits.
export const remoteChange = Annotation.define<boolean>();

/**
 * A change the draft session made (`replace`), which isn't reported as the
 * person's edit either: in a live session, it has put it into the document
 * itself.
 */
export const sessionChange = Annotation.define<boolean>();

/** Where offset `y` in the text as `body` holds it falls in `doc`, whose line breaks are `breakLength` long. */
export function positionOf(doc: Text, y: number, breakLength: number): number {
  if (breakLength === 1) return Math.min(y, doc.length);
  // The last line starting at or before `y`, by its start in `body`.
  let low = 1;
  let high = doc.lines;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const start = doc.line(mid).from + (mid - 1) * (breakLength - 1);
    if (start <= y) low = mid;
    else high = mid - 1;
  }
  const line = doc.line(low);
  const start = line.from + (low - 1) * (breakLength - 1);
  // Inside a line break: its line's end.
  return line.from + Math.min(y - start, line.length);
}

/** The offset in `body` of position `pos` in `doc`. */
export const offsetOf = (doc: Text, pos: number, breakLength: number): number =>
  breakLength === 1 ? pos : pos + (doc.lineAt(pos).number - 1) * (breakLength - 1);

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
// The UTF-16 unit at `pos` in `doc`, or NaN past either end: read without copying the text.
const unitAt = (doc: Text, pos: number) =>
  pos >= 0 && pos < doc.length ? doc.sliceString(pos, pos + 1).charCodeAt(0) : NaN;
// Whether position `pos` in `doc` falls between an emoji's two halves.
const splits = (doc: Text, pos: number) => isHigh(unitAt(doc, pos - 1)) && isLow(unitAt(doc, pos));
// Whether position `pos` in `doc` falls between whole characters: not after a
// pair's first half, alone or not, nor before a second half.
const between = (doc: Text, pos: number) =>
  !isHigh(unitAt(doc, pos - 1)) && !isLow(unitAt(doc, pos));

/**
 * Put one CodeMirror transaction's changes into `text`, which held what its
 * start state did: last first, so each one's offsets still hold, each
 * widened to whole characters and inserted well-formed. The characters at
 * each edge are read from the start state, which holds the same text, so
 * the work is the change's, never the page's. Whether `text` now holds
 * just what was typed: false when a half of a pair had to go in as U+FFFD.
 */
export function putChanges(text: Y.Text, transaction: Transaction): boolean {
  const doc = transaction.startState.doc;
  const breakLength = transaction.startState.lineBreak.length;
  const changes: { from: number; to: number; insert: string }[] = [];
  let exact = true;
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let from = offsetOf(doc, fromA, breakLength);
    let to = offsetOf(doc, toA, breakLength);
    let insert = inserted.sliceString(0, inserted.length, transaction.startState.lineBreak);
    // A pair is never a line break, so its halves are as many apart in both texts.
    if (splits(doc, fromA)) {
      from--;
      insert = doc.sliceString(fromA - 1, fromA) + insert;
    }
    if (splits(doc, toA)) {
      insert += doc.sliceString(toA, toA + 1);
      to++;
    }
    const wellFormed = insert.toWellFormed();
    if (wellFormed !== insert) exact = false;
    changes.push({ from, to, insert: wellFormed });
  });
  for (const { from, to, insert } of changes.reverse()) {
    if (to > from) text.delete(from, to - from);
    if (insert !== '') text.insert(from, insert);
  }
  return exact;
}

/**
 * Whether, after `delta` went from `before` into `after`, the editor's text
 * may differ from `body`'s, read only at the change's edges. Yjs stores
 * each half of a pair it splits as U+FFFD and doesn't say so: a split falls
 * at an edge, where `after` then holds a half alone, or two halves a
 * deletion brought together. And on a page with CRLF line breaks, an edge
 * inside one in `before` is a change the editor can't take as it came.
 */
export function mayDiffer(
  before: EditorState,
  after: EditorState,
  delta: readonly { insert?: unknown; delete?: number | undefined; retain?: number | undefined }[],
): boolean {
  const breakLength = before.lineBreak.length;
  const inBreak = (y: number) =>
    breakLength > 1 &&
    offsetOf(before.doc, positionOf(before.doc, y, breakLength), breakLength) !== y;
  const split = (y: number) => !between(after.doc, positionOf(after.doc, y, breakLength));
  // Offsets in the text before the change, and after it.
  let old = 0;
  let y = 0;
  for (const op of delta) {
    if (op.retain !== undefined) {
      old += op.retain;
      y += op.retain;
    } else if (op.delete !== undefined) {
      if (inBreak(old) || inBreak(old + op.delete) || split(y)) return true;
      old += op.delete;
    } else if (typeof op.insert === 'string') {
      if (inBreak(old) || split(y)) return true;
      y += op.insert.length;
      if (split(y)) return true;
    }
  }
  return false;
}

/**
 * The CodeMirror changes that make `state`'s text what `body` became, from
 * Yjs's delta of it: in positions of `state`, which held what `body` did.
 */
export function changesFrom(
  state: EditorState,
  delta: readonly { insert?: unknown; delete?: number | undefined; retain?: number | undefined }[],
): ChangeSpec[] {
  const breakLength = state.lineBreak.length;
  const changes: ChangeSpec[] = [];
  let y = 0;
  for (const op of delta) {
    if (op.retain !== undefined) y += op.retain;
    else if (op.delete !== undefined) {
      const from = positionOf(state.doc, y, breakLength);
      const to = positionOf(state.doc, y + op.delete, breakLength);
      changes.push({ from, to });
      y += op.delete;
    } else if (typeof op.insert === 'string') {
      const at = positionOf(state.doc, y, breakLength);
      changes.push({ from: at, insert: state.toText(op.insert) });
    }
  }
  return changes;
}

const setCarets = StateEffect.define<DecorationSet>();

class CaretWidget extends WidgetType {
  readonly name: string;
  readonly colour: number;
  constructor(name: string, colour: number) {
    super();
    this.name = name;
    this.colour = colour;
  }
  override eq(other: CaretWidget) {
    return other.name === this.name && other.colour === this.colour;
  }
  toDOM() {
    // Colours go in through the DOM, which the policy allows, never a `style` attribute.
    const caret = document.createElement('span');
    caret.className = 'cm-live-caret';
    caret.dataset['liveCaret'] = '';
    caret.style.borderColor = CARET_COLOURS[this.colour] ?? CARET_COLOURS[0];
    caret.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'cm-live-name';
    name.textContent = this.name;
    name.style.backgroundColor = CARET_COLOURS[this.colour] ?? CARET_COLOURS[0];
    caret.append(name);
    return caret;
  }
  override ignoreEvent() {
    return true;
  }
}

const caretField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(carets, transaction) {
    let next = carets.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setCarets)) next = effect.value;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const caretTheme = EditorView.baseTheme({
  '.cm-live-caret': {
    position: 'relative',
    borderLeft: '2px solid',
    marginLeft: '-1px',
    marginRight: '-1px',
  },
  '.cm-live-name': {
    position: 'absolute',
    left: '-2px',
    bottom: '100%',
    padding: '0 4px',
    borderRadius: '3px 3px 3px 0',
    color: '#fff',
    fontSize: '11px',
    lineHeight: '15px',
    fontFamily: 'sans-serif',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  ...Object.fromEntries(
    CARET_COLOURS.map((colour, i) => [
      `.cm-live-selection-${i}`,
      { backgroundColor: `${colour}33` },
    ]),
  ),
});

// How often the person's cursor is reported: at most every tenth of a second.
const CURSOR_MS = 100;

// How long after a change the whole texts are compared, once for any number of changes.
const CHECK_MS = 1000;

// A change the binding made to hold what `body` does, after which each caret is found again.
const resynced = Annotation.define<boolean>();

// Which way a caret moves for text put in where it is, as its relative
// position says: after it (1), which names the character it is before, or
// before it (-1), which names the one it is after.
function sideOf(encoded: Uint8Array): 1 | -1 {
  try {
    return Y.decodeRelativePosition(encoded).assoc >= 0 ? 1 : -1;
  } catch {
    return 1;
  }
}

/**
 * Whether `transaction` deleted some of what it put in itself, as text
 * someone typed and took out again before sending it: Yjs placed it, and
 * may have split a pair where it went, though the change doesn't say so.
 */
function madeAndGone(transaction: Y.Transaction): boolean {
  for (const [client, deleted] of transaction.deleteSet.clients) {
    const before = transaction.beforeState.get(client) ?? 0;
    if (deleted.some(({ clock, len }) => clock + len > before)) return true;
  }
  return false;
}

// Whether `changes` put text in at `pos`, or take out text there or either side of it.
function touches(changes: ChangeSet, pos: number): boolean {
  let touched = false;
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= pos && pos <= toA) touched = true;
  });
  return touched;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a === b || (a.length === b.length && a.every((byte, i) => byte === b[i]));

/** A caret's place in the editor, from the relative positions it was found by. */
type Placed = {
  anchor: Uint8Array;
  head: Uint8Array;
  /** Null while either isn't in `body`, as before its text arrived: looked for again. */
  at: { anchor: number; head: number; anchorSide: 1 | -1; headSide: 1 | -1 } | null;
};

/**
 * The binding: the person's changes into `body`, others' out of it, both
 * ways checked so CodeMirror always holds what `body` does, and carets.
 * The work for each change is the change's: what it touches is checked at
 * once, and the whole texts compared only a second later, once for any
 * number of changes. Each caret is found in `body` once for each presence
 * that moves it, then moves with the text, and is found again only when
 * a change is at it.
 */
export function liveBinding(source: LiveSource): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      readonly #view: EditorView;
      readonly #stop: (() => void)[] = [];
      #destroyed = false;
      #retries = 0;
      #cursorTimer: ReturnType<typeof setTimeout> | null = null;
      #checkTimer: ReturnType<typeof setTimeout> | null = null;
      // Others' carets as last found, by their join.
      readonly #placed = new Map<string, Placed>();
      /** Whether this editor's own change is going into `body` now. */
      putting = false;
      // Whether `body` took a change of the person's from elsewhere since the texts last matched.
      #apart = false;

      constructor(view: EditorView) {
        this.#view = view;
        const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
          if (transaction.origin === source.localOrigin) {
            // The person's change, but not through this editor, as the
            // visual editor's just before someone else's: this editor may
            // not show it yet, so the next change from outside is read whole.
            if (!this.putting) {
              this.#apart = true;
              // Its changes may not be the editor's, which carets would be moved by: found again.
              this.#placed.clear();
            }
            return;
          }
          this.#takeIn(event, madeAndGone(transaction));
        };
        source.text.observe(observer);
        this.#stop.push(() => source.text.unobserve(observer));
        this.#stop.push(source.onCarets(() => this.#drawCarets()));
        // The binding starts from the text `body` holds: once CodeMirror has
        // finished making or reconfiguring the view, which takes no dispatch.
        queueMicrotask(() => {
          this.resync();
          this.#drawCarets();
        });
      }

      update(update: ViewUpdate) {
        const local = update.transactions.some(
          (transaction) => transaction.docChanged && !transaction.annotation(remoteChange),
        );
        if (update.docChanged) {
          if (update.transactions.some((transaction) => transaction.annotation(resynced))) {
            // Replaced whole, a caret's place in it is found again.
            this.#placed.clear();
          } else {
            for (const placed of this.#placed.values()) {
              const { at } = placed;
              if (!at) continue;
              // A change at it, where Yjs places the caret by the order the
              // change was made in, or by the text's history once the
              // character it names is gone: found again.
              if (touches(update.changes, at.anchor) || touches(update.changes, at.head)) {
                placed.at = null;
                continue;
              }
              at.anchor = update.changes.mapPos(at.anchor, at.anchorSide);
              at.head = update.changes.mapPos(at.head, at.headSide);
            }
          }
          queueMicrotask(() => this.#drawCarets());
        }
        // Leaving the text says so too, so others don't see a caret nobody is at.
        if (update.selectionSet || local || update.focusChanged) this.#reportCursor();
      }

      destroy() {
        this.#destroyed = true;
        for (const stop of this.#stop) stop();
        if (this.#cursorTimer) clearTimeout(this.#cursorTimer);
        if (this.#checkTimer) clearTimeout(this.#checkTimer);
        source.cursor(null);
      }

      // Someone else's change, as small edits out of the person's undo history.
      #takeIn(event: Y.YTextEvent, unsaid: boolean) {
        const view = this.#view;
        const { delta } = event;
        const before = view.state;
        const changes = changesFrom(before, delta);
        if (changes.length > 0) {
          view.dispatch({
            changes,
            annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
          });
        }
        // Yjs doesn't say when a pair it split became U+FFFD: read the text again then.
        if (this.#apart || unsaid || mayDiffer(before, view.state, delta)) this.resync();
        else this.checkSoon();
        this.#drawCarets();
      }

      /**
       * Compare the whole texts a second from now, as a change may leave
       * them apart where nothing says so: a pair split by text someone put
       * in and took out again before sending it.
       */
      checkSoon() {
        if (this.#checkTimer || this.#destroyed) return;
        this.#checkTimer = setTimeout(() => {
          this.#checkTimer = null;
          this.resync();
        }, CHECK_MS);
      }

      /** Make CodeMirror hold exactly what `body` does, by the smallest change. */
      resync() {
        // Once the session no longer takes the person's changes, what they typed stays shown.
        if (this.#destroyed || source.active?.() === false) return;
        const view = this.#view;
        const now = view.state.sliceDoc();
        const wanted = source.text.toJSON();
        this.#apart = false;
        if (now === wanted) return;
        let start = 0;
        while (start < now.length && start < wanted.length && now[start] === wanted[start]) start++;
        let endNow = now.length;
        let endWanted = wanted.length;
        while (endNow > start && endWanted > start && now[endNow - 1] === wanted[endWanted - 1]) {
          endNow--;
          endWanted--;
        }
        const doc = view.state.doc;
        const breakLength = view.state.lineBreak.length;
        // Whole line breaks: a CRLF page's edges move out of any they fall in.
        const from = positionOf(doc, start, breakLength);
        const fromY = offsetOf(doc, from, breakLength);
        let to = positionOf(doc, endNow, breakLength);
        let toY = offsetOf(doc, to, breakLength);
        if (toY < endNow) {
          to = Math.min(to + 1, doc.length);
          toY = offsetOf(doc, to, breakLength);
        }
        const insert = wanted.slice(fromY, wanted.length - (now.length - toY));
        view.dispatch({
          changes: { from, to, insert: view.state.toText(insert) },
          annotations: [
            remoteChange.of(true),
            resynced.of(true),
            Transaction.addToHistory.of(false),
          ],
        });
      }

      #reportCursor() {
        if (this.#cursorTimer) return;
        this.#cursorTimer = setTimeout(() => {
          this.#cursorTimer = null;
          if (this.#destroyed) return;
          const { state } = this.#view;
          const breakLength = state.lineBreak.length;
          const { anchor, head } = state.selection.main;
          const at = (pos: number) =>
            Y.encodeRelativePosition(
              Y.createRelativePositionFromTypeIndex(
                source.text,
                Math.min(offsetOf(state.doc, pos, breakLength), source.text.length),
              ),
            );
          source.cursor(this.#view.hasFocus ? { anchor: at(anchor), head: at(head) } : null);
        }, CURSOR_MS);
      }

      // Where `caret` is in the editor, found in `body`, which walks its text up to there.
      #place(caret: RemoteCaret): Placed['at'] {
        const anchor = resolveIn(source.text, caret.anchor);
        const head = resolveIn(source.text, caret.head);
        if (anchor === null || head === null) return null;
        const { state } = this.#view;
        const breakLength = state.lineBreak.length;
        return {
          anchor: positionOf(state.doc, anchor, breakLength),
          head: positionOf(state.doc, head, breakLength),
          anchorSide: sideOf(caret.anchor),
          headSide: sideOf(caret.head),
        };
      }

      #drawCarets() {
        if (this.#destroyed) return;
        const view = this.#view;
        const marks: { from: number; to: number; decoration: Decoration }[] = [];
        const shown = new Set<string>();
        for (const caret of source.carets()) {
          shown.add(caret.key);
          let placed = this.#placed.get(caret.key);
          // Found again only once it moved, or wasn't found.
          if (
            !placed?.at ||
            !sameBytes(placed.anchor, caret.anchor) ||
            !sameBytes(placed.head, caret.head)
          ) {
            placed = { anchor: caret.anchor, head: caret.head, at: this.#place(caret) };
            this.#placed.set(caret.key, placed);
          }
          if (!placed.at) continue;
          const { anchor: anchorAt, head: headAt } = placed.at;
          const from = Math.min(headAt, anchorAt);
          const to = Math.max(headAt, anchorAt);
          if (to > from) {
            marks.push({
              from,
              to,
              decoration: Decoration.mark({ class: `cm-live-selection-${caret.colour}` }),
            });
          }
          marks.push({
            from: headAt,
            to: headAt,
            decoration: Decoration.widget({
              widget: new CaretWidget(caret.name, caret.colour),
              side: 1,
            }),
          });
        }
        for (const key of this.#placed.keys()) if (!shown.has(key)) this.#placed.delete(key);
        marks.sort((a, b) => a.from - b.from || a.to - b.to);
        const builder = new RangeSetBuilder<Decoration>();
        for (const mark of marks) builder.add(mark.from, mark.to, mark.decoration);
        // Not while CodeMirror updates: then, once it has.
        try {
          view.dispatch({ effects: setCarets.of(builder.finish()) });
          this.#retries = 0;
        } catch {
          // Once CodeMirror has finished its update: a few tries, never a spin.
          if (!this.#destroyed && this.#retries++ < 3) queueMicrotask(() => this.#drawCarets());
        }
      }
    },
  );
  // The person's changes go into `body` before anything else hears of them:
  // this listener comes before the surface's own (`codemirror.tsx`).
  const put = EditorView.updateListener.of((update) => {
    // Once the session no longer takes the person's changes, as just after
    // it ended and before the editor is unbound, they stay as typed: the
    // draft saves them from outside the session, as the surface reports them.
    if (source.active?.() === false) return;
    const bound = update.view.plugin(plugin);
    let local = false;
    let exact = true;
    for (const transaction of update.transactions) {
      if (!transaction.docChanged || transaction.annotation(remoteChange)) continue;
      if (transaction.annotation(sessionChange)) continue;
      local = true;
      let put = false;
      if (bound) bound.putting = true;
      try {
        source.edit(() => {
          put = true;
          if (!putChanges(source.text, transaction)) exact = false;
        });
      } finally {
        if (bound) bound.putting = false;
      }
      // A change the session didn't take isn't in `body`.
      if (!put) exact = false;
    }
    if (!local) return;
    // A change put in well-formed differs from what was typed: show `body`'s.
    if (!exact) queueMicrotask(() => update.view.plugin(plugin)?.resync());
    else bound?.checkSoon();
  });
  return [caretField, caretTheme, put, plugin];
}
