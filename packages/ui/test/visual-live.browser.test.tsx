import { undo } from '@milkdown/kit/prose/history';
import type { Node } from '@milkdown/kit/prose/model';
import { TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import * as Y from 'yjs';
import type { LiveSource, RemoteCaret } from '../src/page/editor/source/live.ts';
import { resolveIn } from '../src/page/editor/live-cursor.ts';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';
import { pollActing } from './acting.ts';

// The visual editor in a live session (ADR 0015 decision 3), mounted for
// real over a real Yjs `body`: its own edits go in as the blocks it
// changed, others' come in a block at a time, a composition waits, a change
// past its block is read whole, what it can't show is said, and others'
// carets show as bars beside their blocks (decision 7).

const links: LinkAssist = {
  pages: [],
  targets: () => null,
  selfId: 'self',
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
  doc: Y.Doc;
  text: Y.Text;
  live: LiveSource;
  /** Someone else's change, as the participant applies it. */
  theirs: (sender: string, change: (text: Y.Text) => void) => void;
  carets: RemoteCaret[];
  setCarets: (carets: RemoteCaret[]) => void;
  sent: { cursor: { anchor: Uint8Array; head: Uint8Array } | null; editor: string | undefined }[];
};

function session(initial: string): Session {
  const doc = new Y.Doc();
  const text = doc.getText('body');
  text.insert(0, initial);
  const remote = new Y.Doc();
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  const before = new Set<(sender: string) => void>();
  const listeners = new Set<() => void>();
  const s: Session = {
    doc,
    text,
    carets: [],
    sent: [],
    setCarets: (carets) => {
      s.carets = carets;
      for (const listener of listeners) listener();
    },
    theirs: (sender, change) => {
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(remote)));
      change(remote.getText('body'));
      const update = Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc));
      for (const listener of before) listener(sender);
      Y.applyUpdate(doc, update, 'remote');
    },
    live: {
      text,
      edit: (change) => doc.transact(change, LOCAL),
      localOrigin: LOCAL,
      carets: () => s.carets,
      onCarets(listener) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      cursor: (cursor, editor) => void s.sent.push({ cursor, editor }),
      onBeforeRemote(listener) {
        before.add(listener);
        return () => void before.delete(listener);
      },
      nameOf: (id) => (id === 'sam' ? 'Sam' : 'Someone'),
    },
  };
  return s;
}

type Mounted = {
  handle: EditorSurfaceHandle;
  dom: HTMLElement;
  changes: string[];
  cantShow: (string | null)[];
  behind: string[];
  /** Draw it again, bound to `live` (or none). */
  rebind: (live: LiveSource | null) => void;
  unmount: () => void;
};

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
  const cantShow: (string | null)[] = [];
  const behind: string[] = [];
  const attachments = { list: [], url: async () => null };
  const draw = (live: LiveSource | null) =>
    root.render(
      <StrictMode>
        <VisualSurface
          ref={ref}
          initial={s.text.toJSON()}
          onChange={(markdown) => changes.push(markdown)}
          links={links}
          attachments={attachments}
          onFiles={() => {}}
          live={live}
          onCantShow={(by) => cantShow.push(by)}
          onBehind={(text) => behind.push(text)}
        />
      </StrictMode>,
    );
  await act(async () => draw(s.live));
  await pollActing(() => container.querySelectorAll('.ProseMirror').length).toBe(1);
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!ref.current || !dom) throw new Error('The editor did not mount');
  await act(() => expect.poll(() => viewOf(dom).state.doc.childCount).toBeGreaterThan(0));
  let gone = false;
  const m: Mounted = {
    handle: ref.current,
    dom,
    changes,
    cantShow,
    behind,
    rebind: (live) => act(() => draw(live)),
    unmount: () => {
      if (gone) return;
      gone = true;
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(m);
  return m;
}

// The first text node with `text` in it, and where `text` is in it.
function find(doc: Node, text: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    const i = node.isText ? (node.text ?? '').indexOf(text) : -1;
    if (at < 0 && i >= 0) at = pos + i;
  });
  if (at < 0) throw new Error(`No text ${text}`);
  return at;
}

const shownText = (m: Mounted) => viewOf(m.dom).state.doc.textContent;

// Type `text` at the place `before` names, as the person does.
function type(m: Mounted, before: string, text: string, offset = 0) {
  const view = viewOf(m.dom);
  const at = find(view.state.doc, before) + offset;
  act(() => view.dispatch(view.state.tr.insertText(text, at)));
}

describe('its own edits', () => {
  it('go into body as the blocks it changed, others kept as written', async () => {
    const page = '* one\n* two\n\nA __bold__ word.\n\nLast.\n';
    const s = session(page);
    const m = await mount(s);
    const started = performance.now();
    type(m, 'Last.', ' Edited', 4);
    await expect
      .poll(() => s.text.toJSON())
      .toBe('* one\n* two\n\nA __bold__ word.\n\nLast Edited.\n');
    // Within the report's 150 ms, and a little time for the test.
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(m.changes.at(-1)).toBe(s.text.toJSON());
  });

  it('carry through someone else’s change it hasn’t taken in yet', async () => {
    const s = session('The cat sat.\n\nNext.\n');
    const m = await mount(s);
    s.theirs('sam', (text) => text.insert(4, 'black '));
    // Typed before the tenth of a second it waits for others' changes.
    type(m, 'sat', ' down', 3);
    m.handle.read();
    expect(s.text.toJSON()).toBe('The black cat sat down.\n\nNext.\n');
    await expect.poll(() => shownText(m)).toContain('The black cat sat down.');
  });

  it('keep an emoji whole on a CRLF page', async () => {
    const s = session('Smile 😀 here.\r\n\r\nNext.\r\n');
    const m = await mount(s);
    type(m, 'here', '😁', 0);
    await expect.poll(() => s.text.toJSON()).toBe('Smile 😀 😁here.\r\n\r\nNext.\r\n');
    expect(s.text.toJSON().isWellFormed()).toBe(true);
  });
});

describe('others’ changes', () => {
  it('go in by block, the cursor where it was, and out of undo', async () => {
    const s = session('First block.\n\nSecond block.\n');
    const m = await mount(s);
    const view = viewOf(m.dom);
    const caret = find(view.state.doc, 'Second') + 3;
    act(() =>
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret))),
    );
    s.theirs('sam', (text) => text.insert(0, 'Sam: '));
    await expect.poll(() => shownText(m)).toBe('Sam: First block.Second block.');
    // The caret is still after "Sec".
    const now = viewOf(m.dom).state;
    expect(now.doc.textBetween(now.selection.from - 3, now.selection.from)).toBe('Sec');
    // Undo has nothing of theirs to undo.
    act(() => void undo(now, view.dispatch));
    expect(shownText(m)).toBe('Sam: First block.Second block.');
  });

  it('wait for a composition in their block to end', async () => {
    const s = session('Typing here.\n\nOther.\n');
    const m = await mount(s);
    const view = viewOf(m.dom);
    const at = find(view.state.doc, 'here');
    act(() => {
      view.focus();
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    });
    act(() => void m.dom.dispatchEvent(new CompositionEvent('compositionstart', { data: '' })));
    expect(view.composing).toBe(true);
    s.theirs('sam', (text) => text.insert(0, 'Hi. '));
    s.theirs('sam', (text) => text.insert(text.length - 1, ' Too'));
    // The other block goes in; the one being composed in waits.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(shownText(m)).toBe('Typing here.Other.');
    act(() => void m.dom.dispatchEvent(new CompositionEvent('compositionend', { data: '' })));
    await expect.poll(() => shownText(m)).toBe('Hi. Typing here.Other. Too');
  });

  it('read whole when a change reaches past its block', async () => {
    const s = session('One.\n\nTwo.\n\nThree.\n');
    const m = await mount(s);
    s.theirs('sam', (text) => text.insert(text.toJSON().indexOf('Two'), '```\n'));
    await expect.poll(() => viewOf(m.dom).state.doc.lastChild?.type.name).toBe('code_block');
    expect(viewOf(m.dom).state.doc.lastChild?.textContent).toBe('Two.\n\nThree.');
    expect(m.cantShow).toEqual([]);
  });

  it('say who added what it can’t show', async () => {
    const s = session('One.\n\nTwo.\n');
    const m = await mount(s);
    // A link definition nothing uses, which the visual editor would drop.
    s.theirs('sam', (text) => text.insert(text.length, '\n[unused]: https://example.com\n'));
    await expect.poll(() => m.cantShow).toEqual(['sam']);
  });

  it('left a session, what wasn’t taken in yet goes to the page', async () => {
    const s = session('One.\n\nTwo.\n');
    const m = await mount(s);
    s.theirs('sam', (text) => text.insert(0, 'New. '));
    m.rebind(null);
    expect(m.behind).toEqual(['New. One.\n\nTwo.\n']);
  });
});

describe('presence', () => {
  it('shows a bar by the block someone’s caret is in', async () => {
    const s = session('One.\n\nTwo.\n\nThree.\n');
    const m = await mount(s);
    const at = s.text.toJSON().indexOf('Two') + 2;
    const position = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(s.text, at));
    act(() =>
      s.setCarets([{ key: 'sam 1', name: 'Sam', colour: 3, anchor: position, head: position }]),
    );
    await expect
      .poll(() => m.dom.querySelector('.live-block')?.getAttribute('data-live-block'))
      .toBe('Sam');
    const bar = m.dom.querySelector('.live-block');
    expect(bar?.textContent).toBe('Two.');
    expect(bar?.classList.contains('live-block-3')).toBe(true);
    expect(bar?.hasAttribute('style')).toBe(false);
    // It follows their caret as the text moves under it.
    s.theirs('sam', (text) => text.insert(0, 'Zero.\n\n'));
    await expect.poll(() => m.dom.querySelector('.live-block')?.textContent).toBe('Two.');
  });

  it('sends the person’s caret, from the visual editor', async () => {
    const s = session('One.\n\nTwo.\n');
    const m = await mount(s);
    const view = viewOf(m.dom);
    act(() => {
      view.focus();
      const at = find(view.state.doc, 'Two') + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
    });
    await expect.poll(() => s.sent.at(-1)?.cursor !== null && s.sent.at(-1)?.editor).toBe('visual');
    const head = s.sent.at(-1)?.cursor?.head;
    if (!head) throw new Error('No caret sent');
    expect(resolveIn(s.text, head)).toBe(s.text.toJSON().indexOf('Two') + 1);
  });
});
