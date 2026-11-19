import { EditorView } from '@codemirror/view';
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import * as Y from 'yjs';
import CodeMirrorSurface from '../src/page/editor/source/codemirror.tsx';
import { resolveIn } from '../src/page/editor/live-cursor.ts';
import {
  sessionChange,
  type LiveSource,
  type RemoteCaret,
} from '../src/page/editor/source/live.ts';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';

// The source editor in a live session (ADR 0015 decision 3), mounted for
// real over a real Yjs `body`: the person's typing goes in and stays
// shown, as `body` holds it, others' comes in, and others' carets move
// with the text as Yjs moves them, without being found again.

const links: LinkAssist = {
  pages: null,
  targets: () => null,
  selfId: 'p-self',
  table: new Map(),
  headings: async () => [],
  ownHeadings: async () => [],
  create: () => {},
  pick: () => {},
  choose: () => {},
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const LOCAL = Symbol('local');

type Session = {
  text: Y.Text;
  live: LiveSource;
  /** Someone else's change, made in their copy and sent over. */
  theirs: (change: (text: Y.Text) => void) => void;
  /** The person's own change, made not through this editor, as the visual editor's. */
  mine: (change: (text: Y.Text) => void) => void;
  /** A copy of the document as it is now, as another app holds it. */
  copy: () => Y.Doc;
  /** A copy's changes, sent over. */
  from: (copy: Y.Doc) => void;
  setCarets: (carets: RemoteCaret[]) => void;
  /** Whether the session still takes the person's changes. */
  active: boolean;
};

function session(initial: string): Session {
  const doc = new Y.Doc();
  const text = doc.getText('body');
  text.insert(0, initial);
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  const listeners = new Set<() => void>();
  let carets: RemoteCaret[] = [];
  const s: Session = {
    text,
    active: true,
    setCarets: (next) => {
      carets = next;
      for (const listener of listeners) listener();
    },
    theirs: (change) => {
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(remote)));
      change(remote.getText('body'));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), 'remote');
    },
    mine: (change) => doc.transact(() => change(text), LOCAL),
    copy: () => {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      return copy;
    },
    from: (copy) =>
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(copy, Y.encodeStateVector(doc)), 'remote'),
    live: {
      text,
      // As the participant does: nothing once the session isn't live.
      edit: (change) => {
        if (s.active) doc.transact(change, LOCAL);
      },
      active: () => s.active,
      localOrigin: LOCAL,
      carets: () => carets,
      onCarets(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      cursor: () => {},
    },
  };
  return s;
}

type Mounted = { view: EditorView; changes: string[]; unmount: () => void };

const mounted: Mounted[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

async function mount(s: Session): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const changes: string[] = [];
  act(() =>
    root.render(
      <StrictMode>
        <CodeMirrorSurface
          ref={ref}
          initial={s.text.toJSON()}
          onChange={(markdown) => changes.push(markdown)}
          links={links}
          attachments={{ list: [], url: async () => null }}
          onFiles={() => {}}
          live={s.live}
        />
      </StrictMode>,
    ),
  );
  const host = [...container.querySelectorAll('div')].find((div) => div.shadowRoot);
  const editor = host?.shadowRoot?.querySelector('.cm-editor');
  const view = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null;
  if (!view) throw new Error('The editor did not mount');
  const m: Mounted = {
    view,
    changes,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(m);
  // The binding starts once the editor is made.
  await microtasks();
  return m;
}

const microtasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** The person types `insert` at `at`, as CodeMirror's input does. */
const typeAt = (m: Mounted, at: number, insert: string, to = at) =>
  act(() => m.view.dispatch({ changes: { from: at, to, insert }, userEvent: 'input.type' }));

const caretAt = (s: Session, at: number, key = 'sam') => {
  const position = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(s.text, at));
  return { key, name: 'Sam', colour: 0, anchor: position, head: position };
};

/** Where others' carets show, in the editor's positions. */
const caretsShown = (m: Mounted) =>
  [...m.view.contentDOM.querySelectorAll('.cm-live-caret')].map((caret) => m.view.posAtDOM(caret));

describe('the source editor in a live session', () => {
  it('puts the person’s typing into `body`', async () => {
    const s = session('Hello.');
    const m = await mount(s);
    typeAt(m, 6, ' More.');
    await microtasks();
    expect(s.text.toJSON()).toBe('Hello. More.');
    expect(m.view.state.sliceDoc()).toBe('Hello. More.');
  });

  it('keeps a keystroke made just as the session ended on screen, reported once (#513)', async () => {
    const s = session('Hello.');
    const m = await mount(s);
    // Ended, but not unbound yet: the session takes nothing more.
    s.active = false;
    typeAt(m, 6, '!');
    await microtasks();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    // The draft saves it from outside the session, as the surface reported it.
    expect(m.view.state.sliceDoc()).toBe('Hello.!');
    expect(m.changes).toEqual(['Hello.!']);
    expect(s.text.toJSON()).toBe('Hello.');
  });

  it('shows `body`’s U+FFFD for half of a pair typed alone', async () => {
    const s = session('ab');
    const m = await mount(s);
    typeAt(m, 1, '\ud83d');
    await microtasks();
    expect(s.text.toJSON()).toBe('a\ufffdb');
    expect(m.view.state.sliceDoc()).toBe('a\ufffdb');
  });

  it('shows what Yjs made of a pair another person split, as `body` holds it', async () => {
    const s = session('a😀b');
    const m = await mount(s);
    s.theirs((text) => text.insert(2, 'x'));
    expect(s.text.toJSON()).toBe('a\ufffdx\ufffdb');
    expect(m.view.state.sliceDoc()).toBe(s.text.toJSON());
  });

  it('catches up, a second later, with a split nothing in the change says', async () => {
    const s = session('a😀b');
    const m = await mount(s);
    // Put in and taken out again before it was sent: only the split is left.
    s.theirs((text) =>
      text.doc?.transact(() => {
        text.insert(2, 'x');
        text.delete(2, 1);
      }),
    );
    expect(s.text.toJSON()).toBe('a\ufffd\ufffdb');
    await expect.poll(() => m.view.state.sliceDoc(), { timeout: 3000 }).toBe('a\ufffd\ufffdb');
  });

  it('moves others’ carets with the text, as Yjs does, until they move', async () => {
    const s = session('one two three');
    const m = await mount(s);
    // Before "two" and before "three".
    act(() => s.setCarets([caretAt(s, 4), caretAt(s, 8, 'rita')]));
    expect(caretsShown(m)).toEqual([4, 8]);
    // Typed before them, at one of them, and someone else's change before both.
    typeAt(m, 0, '1 ');
    typeAt(m, 6, 'and ');
    s.theirs((text) => text.insert(0, '0 '));
    await microtasks();
    expect(m.view.state.sliceDoc()).toBe('0 1 one and two three');
    // Text put in at a caret goes before it, as at its relative position.
    expect(caretsShown(m)).toEqual([12, 16]);
    // A caret's text taken out: it stays where it was.
    s.theirs((text) => text.delete(12, 4));
    await microtasks();
    expect(caretsShown(m)).toEqual([12, 12]);
    // A caret that moved is found again.
    act(() => s.setCarets([caretAt(s, 0), caretAt(s, 12, 'rita')]));
    expect(caretsShown(m)).toEqual([0, 12]);
  });

  it('shows a caret once the text it is in arrives', async () => {
    const s = session('one');
    const m = await mount(s);
    // Rita typed "two" and is before its last letter, which this app hasn't heard of yet.
    const rita = new Y.Doc();
    Y.applyUpdate(rita, Y.encodeStateAsUpdate(s.text.doc as Y.Doc));
    const theirs = rita.getText('body');
    theirs.insert(3, ' two');
    const position = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(theirs, 6));
    act(() =>
      s.setCarets([{ key: 'rita', name: 'Rita', colour: 1, anchor: position, head: position }]),
    );
    expect(caretsShown(m)).toEqual([]);
    Y.applyUpdate(
      s.text.doc as Y.Doc,
      Y.encodeStateAsUpdate(rita, Y.encodeStateVector(s.text.doc as Y.Doc)),
      'remote',
    );
    await microtasks();
    expect(m.view.state.sliceDoc()).toBe('one two');
    expect(caretsShown(m)).toEqual([6]);
  });
  it('finds a caret again where text at it was replaced, as Yjs places it', async () => {
    const s = session('abcde');
    const m = await mount(s);
    const sam = caretAt(s, 2);
    act(() => s.setCarets([sam]));
    expect(caretsShown(m)).toEqual([2]);
    // The person types over "bcd", the caret's character among them.
    typeAt(m, 1, 'XY', 4);
    await microtasks();
    expect(s.text.toJSON()).toBe('aXYe');
    // Before the text put in, where Yjs places it, not after it.
    expect(resolveIn(s.text, sam.head)).toBe(1);
    expect(caretsShown(m)).toEqual([1]);
  });

  it('keeps a caret by its character when one change of the session’s spans it', async () => {
    const s = session('one\ntwo\nthree');
    const m = await mount(s);
    act(() => s.setCarets([caretAt(s, 5)]));
    expect(caretsShown(m)).toEqual([5]);
    // The draft session changes the first and last lines in `body`, and the
    // editor by one change from the first difference to the last.
    s.mine((text) => {
      text.insert(13, '!');
      text.insert(0, '1 ');
    });
    act(() =>
      m.view.dispatch({
        changes: { from: 0, to: 13, insert: '1 one\ntwo\nthree!' },
        annotations: sessionChange.of(true),
      }),
    );
    await microtasks();
    expect(m.view.state.sliceDoc()).toBe('1 one\ntwo\nthree!');
    expect(caretsShown(m)).toEqual([7]);
  });

  it('places a caret whose character went as Yjs does, by the text’s history', async () => {
    const s = session('abc');
    const m = await mount(s);
    // Sam is before "b"; Bob takes "b" out while Carol puts "X" in after it.
    const sam = caretAt(s, 1);
    act(() => s.setCarets([sam]));
    const bob = s.copy();
    const carol = s.copy();
    bob.getText('body').delete(1, 1);
    carol.getText('body').insert(2, 'X');
    s.from(bob);
    s.from(carol);
    await microtasks();
    expect(m.view.state.sliceDoc()).toBe('aXc');
    // Before "X", put in after the "b" Sam was at.
    expect(resolveIn(s.text, sam.head)).toBe(1);
    expect(caretsShown(m)).toEqual([1]);
  });

  it('reads the text whole when the person’s own change went in elsewhere just before others’', async () => {
    const s = session('Hello.');
    const m = await mount(s);
    // The visual editor writes its edit just before someone else's change comes in.
    s.mine((text) => text.insert(0, 'Oh. '));
    s.theirs((text) => text.insert(text.length, ' Bye.'));
    expect(m.view.state.sliceDoc()).toBe('Oh. Hello. Bye.');
  });
});
