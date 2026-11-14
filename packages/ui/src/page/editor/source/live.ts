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

export { CARET_COLOURS, colourOf } from './live-colours';

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
  /** The person's caret and selection moved, as Yjs relative positions in `body`. */
  cursor(cursor: { anchor: Uint8Array; head: Uint8Array } | null): void;
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
const splits = (text: string, at: number) =>
  at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

/**
 * Put one CodeMirror transaction's changes into `text`, which held what its
 * start state did: last first, so each one's offsets still hold, each
 * widened to whole characters and inserted well-formed.
 */
export function putChanges(text: Y.Text, transaction: Transaction): void {
  const before = text.toJSON();
  const doc = transaction.startState.doc;
  const breakLength = transaction.startState.lineBreak.length;
  const changes: { from: number; to: number; insert: string }[] = [];
  transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let from = offsetOf(doc, fromA, breakLength);
    let to = offsetOf(doc, toA, breakLength);
    let insert = inserted.sliceString(0, inserted.length, transaction.startState.lineBreak);
    if (splits(before, from)) {
      from--;
      insert = before.charAt(from) + insert;
    }
    if (splits(before, to)) {
      insert += before.charAt(to);
      to++;
    }
    changes.push({ from, to, insert: insert.toWellFormed() });
  });
  for (const { from, to, insert } of changes.reverse()) {
    if (to > from) text.delete(from, to - from);
    if (insert !== '') text.insert(from, insert);
  }
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

/**
 * The offset in `text` a relative position names, or null when it isn't
 * in `text` (section 5.10, **`presence`**): resolved against `text` itself,
 * a position naming `body` as its root included, never through `doc.get`,
 * which would make any other root it names.
 */
export function resolveIn(text: Y.Text, encoded: Uint8Array): number | null {
  const doc = text.doc;
  if (!doc) return null;
  let position: Y.RelativePosition;
  try {
    position = Y.decodeRelativePosition(encoded);
  } catch {
    return null;
  }
  if (position.item === null) {
    if (position.tname !== 'body') return null;
    return position.assoc >= 0 ? text.length : 0;
  }
  let absolute: Y.AbsolutePosition | null;
  try {
    absolute = Y.createAbsolutePositionFromRelativePosition(
      new Y.RelativePosition(null, null, position.item, position.assoc),
      doc,
    );
  } catch {
    return null;
  }
  return absolute && absolute.type === text ? Math.min(absolute.index, text.length) : null;
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

/**
 * The binding: the person's changes into `body`, others' out of it, both
 * ways checked so CodeMirror always holds what `body` does, and carets.
 */
export function liveBinding(source: LiveSource): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      readonly #view: EditorView;
      readonly #stop: (() => void)[] = [];
      #destroyed = false;
      #retries = 0;
      #cursorTimer: ReturnType<typeof setTimeout> | null = null;

      constructor(view: EditorView) {
        this.#view = view;
        const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
          if (transaction.origin === source.localOrigin) return;
          this.#takeIn(event);
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
        if (update.docChanged) queueMicrotask(() => this.#drawCarets());
        // Leaving the text says so too, so others don't see a caret nobody is at.
        if (update.selectionSet || local || update.focusChanged) this.#reportCursor();
      }

      destroy() {
        this.#destroyed = true;
        for (const stop of this.#stop) stop();
        if (this.#cursorTimer) clearTimeout(this.#cursorTimer);
        source.cursor(null);
      }

      // Someone else's change, as small edits out of the person's undo history.
      #takeIn(event: Y.YTextEvent) {
        const view = this.#view;
        const changes = changesFrom(view.state, event.delta);
        if (changes.length > 0) {
          view.dispatch({
            changes,
            annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
          });
        }
        // Yjs doesn't say when a pair it split became U+FFFD: read the text again.
        if (view.state.sliceDoc() !== source.text.toJSON()) this.resync();
        this.#drawCarets();
      }

      /** Make CodeMirror hold exactly what `body` does, by the smallest change. */
      resync() {
        if (this.#destroyed) return;
        const view = this.#view;
        const now = view.state.sliceDoc();
        const wanted = source.text.toJSON();
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
          annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
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

      #drawCarets() {
        if (this.#destroyed) return;
        const view = this.#view;
        const { state } = view;
        const breakLength = state.lineBreak.length;
        const marks: { from: number; to: number; decoration: Decoration }[] = [];
        for (const caret of source.carets()) {
          const anchor = resolveIn(source.text, caret.anchor);
          const head = resolveIn(source.text, caret.head);
          if (anchor === null || head === null) continue;
          const headAt = positionOf(state.doc, head, breakLength);
          const anchorAt = positionOf(state.doc, anchor, breakLength);
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
    let local = false;
    for (const transaction of update.transactions) {
      if (!transaction.docChanged || transaction.annotation(remoteChange)) continue;
      if (transaction.annotation(sessionChange)) continue;
      local = true;
      source.edit(() => putChanges(source.text, transaction));
    }
    // A change put in well-formed may differ from what was typed: show `body`'s.
    if (local && update.state.sliceDoc() !== source.text.toJSON()) {
      queueMicrotask(() => update.view.plugin(plugin)?.resync());
    }
  });
  return [caretField, caretTheme, put, plugin];
}
