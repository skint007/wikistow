import { joinBackward } from '@milkdown/kit/prose/commands';
import { TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';

// The page editor, mounted for real: which editor it shows, and the text
// it gives back, as the session pushes text in and the person switches.

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

// Text the visual editor would write meaning something else.
const SOURCE_ONLY = '[a][r]\n\n[r]: https://example.test/\n';
const STAYS =
  'This page stays in source mode, because the visual editor would change its reference links.';
const UNFAITHFUL =
  'The visual editor couldn’t write your last change exactly, so this page is in source mode. Check the text below.';

type Mounted = {
  handle: EditorSurfaceHandle;
  container: HTMLElement;
  changes: string[];
  /** How often the person was said to have edited, before it was reported. */
  editing: { count: number };
  unmount: () => void;
};

const mounted: Mounted[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
  window.localStorage.clear();
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount(initial: string, mode: 'source' | 'visual'): Mounted {
  window.localStorage.setItem('wikistow.editor', mode);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const changes: string[] = [];
  const editing = { count: 0 };
  act(() =>
    root.render(
      <PageEditor
        ref={ref}
        initial={initial}
        onChange={(markdown) => changes.push(markdown)}
        onEditing={() => (editing.count += 1)}
        status={null}
        links={links}
        attachments={{ list: [], url: async () => null }}
        onFiles={() => {}}
      />,
    ),
  );
  if (!ref.current) throw new Error('The editor did not mount');
  const m: Mounted = {
    handle: ref.current,
    container,
    changes,
    editing,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(m);
  return m;
}

const visual = (m: Mounted) => m.container.querySelector<HTMLElement>('#page-visual');
const source = (m: Mounted) =>
  [...m.container.querySelectorAll('div')].some((div) =>
    div.shadowRoot?.querySelector('.cm-editor'),
  );
const shown = (m: Mounted) => (visual(m) ? 'visual' : source(m) ? 'source' : 'loading');
const note = (m: Mounted) => m.container.querySelector('[role=status]')?.textContent || null;

describe('the page editor', () => {
  it('checks text pasted while the visual editor loads, keeping it in source mode if it must', async () => {
    const m = mount('', 'visual');
    const loading = m.container.querySelector('textarea');
    const data = new DataTransfer();
    data.setData('text/plain', `---\ntitle: x\n---\n${SOURCE_ONLY}`);
    act(() => {
      loading?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await expect.poll(() => shown(m)).toBe('source');
    expect(m.handle.read()).toBe(`---\ntitle: x\n---\n${SOURCE_ONLY}`);
  });

  it('turns to source mode, text unchanged, when the session gives the visual editor text it would change', async () => {
    const m = mount('Start\n', 'visual');
    await expect.poll(() => shown(m)).toBe('visual');
    act(() => m.handle.replace(`Start\n\n${SOURCE_ONLY}`));
    await expect.poll(() => note(m)).toBe(STAYS);
    await expect.poll(() => shown(m)).toBe('source');
    expect(m.handle.read()).toBe(`Start\n\n${SOURCE_ONLY}`);
  });

  it('takes no edit in the visual editor while text the session gave is checked, then shows it', async () => {
    const m = mount('Start\n', 'visual');
    await expect.poll(() => shown(m)).toBe('visual');
    const editor = visual(m);
    if (!editor) throw new Error('No visual editor');
    const view = viewOf(editor);
    act(() => {
      m.handle.replace('Start\n\nFrom the session\n');
      view.dispatch(view.state.tr.insertText(' typed', view.state.doc.content.size - 1));
    });
    expect(view.state.doc.textContent).toBe('Start');
    expect(m.handle.read()).toBe('Start\n\nFrom the session\n');
    await expect.poll(() => view.state.doc.textContent).toBe('StartFrom the session');
    act(() => view.dispatch(view.state.tr.insertText('!', view.state.doc.content.size - 1)));
    await expect.poll(() => m.changes.at(-1)).toBe('Start\n\nFrom the session!\n');
    expect(m.editing.count).toBe(1);
  });

  it('holds the newest text the session gives while text pasted is checked', async () => {
    const m = mount('', 'visual');
    await expect.poll(() => shown(m)).toBe('visual');
    const data = new DataTransfer();
    data.setData('text/plain', 'Pasted');
    act(() => {
      visual(m)?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
      m.handle.replace('From the session\n');
    });
    expect(m.handle.read()).toBe('From the session\n');
    await expect.poll(() => shown(m)).toBe('visual');
    await expect.poll(() => visual(m)?.textContent).toBe('From the session');
    expect(m.handle.read()).toBe('From the session\n');
  });

  it('keeps every key typed through an edit it can’t write, going on in source mode at the cursor', async () => {
    const m = mount('# Title\n\n<div>\nx\n</div>\n\nEnd\n', 'visual');
    await expect.poll(() => shown(m)).toBe('visual');
    const editor = visual(m);
    if (!editor) throw new Error('No visual editor');
    const view = viewOf(editor);
    editor.focus();
    getSelection()?.selectAllChildren(editor);
    getSelection()?.collapseToEnd();
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.keyboard('abc');
    // Backspace at the HTML's start joins it to the heading, which can't
    // hold it, and typing goes on there, before and after the switch.
    act(() => {
      const start = (view.state.doc.firstChild?.nodeSize ?? 0) + 1;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
      joinBackward(view.state, view.dispatch);
    });
    for (const key of 'defgh') {
      await userEvent.keyboard(key);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await expect.poll(() => shown(m)).toBe('source');
    expect(note(m)).toBe(UNFAITHFUL);
    await userEvent.keyboard('ij');
    const page = 'Titledefghij<div>\nx\n</div>\n======\n\nEndabc\n';
    await expect.poll(() => m.handle.read()).toBe(page);
    // What's saved is what's shown.
    expect(m.changes.at(-1)).toBe(page);
  });
});
