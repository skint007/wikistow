// The source editor's binding to a live session's `body` (ADR 0015
// decision 3), its state alone: CRLF positions converted both ways, the
// person's changes widened to whole characters, others' changes as small
// edits, and carets resolved only inside `body`.
import { EditorState, type TransactionSpec } from '@codemirror/state';
import * as Y from 'yjs';
import { describe, expect, it } from 'vite-plus/test';
import {
  changesFrom,
  offsetOf,
  positionOf,
  putChanges,
  resolveIn,
} from '../src/page/editor/source/live.ts';

const editor = (doc: string, lineBreak = '\n') =>
  EditorState.create({ doc, extensions: EditorState.lineSeparator.of(lineBreak) });

function bodyOf(text: string) {
  const doc = new Y.Doc();
  const body = doc.getText('body');
  body.insert(0, text);
  return body;
}

/** One person's edit, through the binding, and what another's editor makes of it. */
function relay(text: string, lineBreak: string, spec: (state: EditorState) => TransactionSpec) {
  const mine = editor(text, lineBreak);
  const theirs = editor(text, lineBreak);
  const body = bodyOf(text);
  const transaction = mine.update(spec(mine));
  const deltas: Parameters<typeof changesFrom>[1][] = [];
  body.observe((event) => deltas.push(event.delta));
  body.doc?.transact(() => putChanges(body, transaction));
  let after = theirs;
  for (const delta of deltas) after = after.update({ changes: changesFrom(after, delta) }).state;
  return { mine: transaction.state.sliceDoc(), body: body.toJSON(), theirs: after.sliceDoc() };
}

describe('the source editor’s live binding', () => {
  it('converts positions on a page with CRLF line breaks', () => {
    const state = editor('one\r\ntwo\r\nthree', '\r\n');
    // "two" starts at 4 in CodeMirror, which counts each CRLF once, and at 5 in `body`.
    expect(offsetOf(state.doc, 4, 2)).toBe(5);
    expect(positionOf(state.doc, 5, 2)).toBe(4);
    expect(positionOf(state.doc, 10, 2)).toBe(8);
    // Between a CR and its LF: the line's end.
    expect(positionOf(state.doc, 4, 2)).toBe(3);
    expect(positionOf(editor('a\nb').doc, 2, 1)).toBe(2);
  });

  it('puts typing in at the right place in a CRLF page, for everyone', () => {
    const result = relay('one\r\ntwo\r\nthree', '\r\n', (state) => ({
      changes: { from: state.doc.line(2).to, insert: state.toText(' and\r\nmore') },
    }));
    expect(result.body).toBe('one\r\ntwo and\r\nmore\r\nthree');
    expect(result.theirs).toBe(result.body);
    expect(result.mine).toBe(result.body);
  });

  it('widens a change inside an emoji’s two halves to the whole emoji', () => {
    // 😀 is D83D DE00 and 😁 is D83D DE01: a change of the second half alone.
    const result = relay('a😀b', '\n', () => ({ changes: { from: 2, to: 3, insert: '\ude01' } }));
    expect(result.body).toBe('a😁b');
    expect(result.theirs).toBe('a😁b');
    expect(result.body.isWellFormed()).toBe(true);
  });

  it('deletes across lines and emoji alike, the same for everyone', () => {
    const result = relay('x😀\r\ny', '\r\n', () => ({ changes: { from: 1, to: 4 } }));
    expect(result.body).toBe('xy');
    expect(result.theirs).toBe('xy');
  });

  it('resolves a caret only inside `body`', () => {
    const body = bodyOf('hello');
    const doc = body.doc as Y.Doc;
    const at = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(body, 2));
    expect(resolveIn(body, at)).toBe(2);
    // One in the title isn't shown, and none names a root the document lacks.
    const title = doc.getText('title');
    title.insert(0, 'Title');
    const inTitle = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(title, 1));
    expect(resolveIn(body, inTitle)).toBeNull();
    const named = Y.encodeRelativePosition(new Y.RelativePosition(null, 'other', null, 0));
    expect(resolveIn(body, named)).toBeNull();
    expect(doc.share.has('other')).toBe(false);
    expect(resolveIn(body, new Uint8Array([255, 255, 255]))).toBeNull();
    // A position at the end of `body`, named by its root.
    const end = Y.encodeRelativePosition(new Y.RelativePosition(null, 'body', null, 0));
    expect(resolveIn(body, end)).toBe(5);
  });
});
