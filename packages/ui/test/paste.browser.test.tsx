import { AllSelection } from '@milkdown/kit/prose/state';
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';
import { loadSyntaxNodes } from '../src/page/editor/visual/config.ts';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import { MARKDOWN_MARK, markOf } from '../src/page/editor/visual/copy-marks.ts';
import { inertHost } from '../src/page/editor/visual/host.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import { viewOf } from './editor-view.ts';

// What the visual editor makes of what's pasted into it, in Chromium.

type Mounted = { handle: EditorSurfaceHandle; dom: HTMLElement; unmount: () => void };

// How to take down each editor mounted, after each test.
const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A visual editor showing `initial`, focused. */
async function mount(initial: string): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const host = inertHost();
  // Loaded first: the editor waits for them, which `act` doesn't.
  await loadSyntaxNodes();
  await act(async () =>
    root.render(
      <StrictMode>
        <VisualSurface
          ref={ref}
          initial={initial}
          onChange={() => {}}
          links={host.links()}
          attachments={host.attachments()}
          onFiles={() => {}}
        />
      </StrictMode>,
    ),
  );
  // The first loads Milkdown, which takes a while under load.
  await act(() =>
    expect
      .poll(() => container.querySelectorAll('.ProseMirror').length, { timeout: 10_000 })
      .toBe(1),
  );
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!ref.current || !dom) throw new Error('The editor did not mount');
  dom.focus();
  const m: Mounted = {
    handle: ref.current,
    dom,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  unmounts.push(m.unmount);
  return m;
}

/** A page editor showing an empty page in the visual editor, which reads what's pasted into it first. */
async function mountPage(): Promise<Mounted> {
  localStorage.setItem('wikistow.editor', 'visual');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const host = inertHost();
  act(() =>
    root.render(
      <PageEditor
        ref={ref}
        initial=""
        onChange={() => {}}
        status={null}
        links={host.links()}
        attachments={host.attachments()}
        onFiles={() => {}}
      />,
    ),
  );
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
    localStorage.removeItem('wikistow.editor');
  };
  unmounts.push(unmount);
  await expect
    .poll(() => container.querySelector('#page-visual') !== null, { timeout: 10_000 })
    .toBe(true);
  const dom = container.querySelector<HTMLElement>('#page-visual');
  if (!ref.current || !dom) throw new Error('The visual editor did not mount');
  return { handle: ref.current, dom, unmount };
}

/** Paste `data`, by type. */
const paste = (m: Mounted, data: Record<string, string>) => {
  const transfer = new DataTransfer();
  for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
  m.dom.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
  );
};

describe('pasting from another tab', () => {
  /** Copy all of `m`'s document, as Ctrl+A then Ctrl+C would. */
  const copy = (m: Mounted) => {
    const view = viewOf(m.dom);
    act(() => view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc))));
    const copied = new DataTransfer();
    m.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: copied, bubbles: true, cancelable: true }),
    );
    return copied;
  };

  // What `copied` holds, as another tab's: its HTML has that tab's token.
  const asAnotherTab = (copied: DataTransfer) =>
    Object.fromEntries(
      copied.types.map((type) => [
        type,
        copied.getData(type).replaceAll(/data-copied="\w+"/g, 'data-copied="0123456789abcdef"'),
      ]),
    );

  const page = 'See [[Plan|the plan]] and ![bed](attachment:a1) and A[^1].\n\n[^1]: Note.\n';

  it('reads Markdown another tab copied, marked so, as Markdown', async () => {
    const m = await mount(page);
    const copied = copy(m);
    m.unmount();
    expect(copied.getData('text/plain')).toBe(page);
    expect(copied.getData(MARKDOWN_MARK)).toMatch(/^[0-9a-f]{96}$/);
    const other = await mount('');
    paste(other, asAnotherTab(copied));
    await expect.poll(() => other.handle.read()).toBe(page);
  });

  it('reads another tab’s Markdown into an empty page whole', async () => {
    // An empty page takes it whole, as the page editor reads text pasted
    // into one, even text the visual editor can't keep whole, which opens
    // in the source editor.
    const references = '[a][r]\n\n[r]: https://example.test/\n';
    const empty = await mountPage();
    paste(empty, {
      'text/html': '<p data-copied="0123456789abcdef">a</p>',
      'text/plain': references,
      [MARKDOWN_MARK]: markOf(references) ?? '',
    });
    await expect.poll(() => empty.handle.read()).toBe(references);
  });
});
