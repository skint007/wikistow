import { insertNewline } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { act, createRef, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import CodeMirrorSurface from '../src/page/editor/source/codemirror.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';

// The real source surface, in Chromium: the text that leaves it is the
// page's exact bytes.

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

type Mounted = {
  handle: EditorSurfaceHandle;
  view: EditorView;
  changes: string[];
  uploads: { files: File[]; place: (markdown: string) => boolean }[];
  unmount: () => void;
};

const mounted: Mounted[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.unmount();
});

// React's `act` warns unless it's told it runs in a test.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount(initial: string): Mounted {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const changes: string[] = [];
  const uploads: Mounted['uploads'] = [];
  // Strict Mode mounts the editor, unmounts it and mounts it again.
  act(() =>
    root.render(
      <StrictMode>
        <CodeMirrorSurface
          ref={ref}
          initial={initial}
          onChange={(markdown) => changes.push(markdown)}
          links={links}
          attachments={{ list: [], url: async () => null }}
          onFiles={(files, place) => uploads.push({ files, place })}
        />
      </StrictMode>,
    ),
  );
  const editor = container.firstElementChild?.shadowRoot?.querySelector('.cm-editor');
  const view = editor instanceof HTMLElement ? EditorView.findFromDOM(editor) : null;
  if (!ref.current || !view) throw new Error('The editor did not mount');
  const m: Mounted = {
    handle: ref.current,
    view,
    changes,
    uploads,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(m);
  return m;
}

const pageTexts = {
  CRLF: 'One\r\nTwo\r\n',
  'lone CR': 'One\rTwo\n',
  'tabs, trailing spaces and no final line break': '\tIndented  \n  Hard break  \ntrailing \t',
};

describe('the source surface', () => {
  for (const [name, text] of Object.entries(pageTexts)) {
    it(`gives back ${name} text exactly, and reports no edit for opening it`, () => {
      const m = mount(text);
      expect(m.handle.read()).toBe(text);
      expect(m.changes).toEqual([]);
    });

    it(`reports ${name} text exactly after an edit`, () => {
      const m = mount(text);
      act(() => m.view.dispatch({ changes: { from: 0, insert: '# ' } }));
      expect(m.changes).toEqual([`# ${text}`]);
      expect(m.handle.read()).toBe(`# ${text}`);
    });
  }

  it('makes new lines with the line break most lines end with', () => {
    for (const [text, lineBreak] of [
      ['One\r\nTwo\nThree\r\n', '\r\n'],
      ['One\nTwo\r\nThree\n', '\n'],
    ] as const) {
      const m = mount(text);
      act(() => {
        m.view.dispatch({ selection: { anchor: 3 } });
        insertNewline(m.view);
      });
      expect(m.handle.read()).toBe(`One${lineBreak}${text.slice(3)}`);
    }
  });

  it('shows a renamed link without changing any other byte, or reporting an edit', () => {
    const m = mount('See [[Old]]\r\nthen\nmore\r\n');
    act(() => m.handle.replace('See [[New title]]\r\nthen\nmore\r\n'));
    expect(m.handle.read()).toBe('See [[New title]]\r\nthen\nmore\r\n');
    act(() => m.handle.replace('See [[New title]]\r\nthen\nmore\r\n\r\n[a](attachment:a)'));
    expect(m.handle.read()).toBe('See [[New title]]\r\nthen\nmore\r\n\r\n[a](attachment:a)');
    expect(m.changes).toEqual([]);
  });

  describe('typing over several lines', () => {
    const beforeInput = (m: Mounted, init: InputEventInit) => {
      const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, ...init });
      act(() => void m.view.contentDOM.dispatchEvent(event));
      return event;
    };
    const textOfLine = (m: Mounted, n: number) => {
      const node = m.view.contentDOM.querySelectorAll('.cm-line')[n]?.firstChild;
      if (!(node instanceof Text)) throw new Error(`No text on line ${n}`);
      return node;
    };
    const replacement = (text: string) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      return data;
    };

    const range = (start: Text, startOffset: number, end: Text, endOffset: number) =>
      new StaticRange({ startContainer: start, startOffset, endContainer: end, endOffset });

    it('goes by the range the browser names, not the selection', () => {
      const m = mount('one two\nthree fuor');
      act(() => m.view.dispatch({ selection: { anchor: 0, head: m.view.state.doc.length } }));
      const [first, second] = [textOfLine(m, 0), textOfLine(m, 1)];
      // A spellcheck fix for one word: the browser can make it without joining lines.
      const fix = beforeInput(m, {
        inputType: 'insertReplacementText',
        dataTransfer: replacement('four'),
        targetRanges: [range(second, 6, second, 10)],
      });
      expect(fix.defaultPrevented).toBe(false);
      expect(m.handle.read()).toBe('one two\nthree fuor');
      // One across the lines, which the editor makes.
      const across = beforeInput(m, {
        inputType: 'insertReplacementText',
        dataTransfer: replacement('2, 3'),
        targetRanges: [range(first, 4, second, 5)],
      });
      expect(across.defaultPrevented).toBe(true);
      expect(m.handle.read()).toBe('one 2, 3 fuor');
    });
  });

  describe('files pasted', () => {
    const paste = (m: Mounted, fill: (data: DataTransfer) => void) => {
      const data = new DataTransfer();
      fill(data);
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      act(() => void m.view.contentDOM.dispatchEvent(event));
    };
    const photo = (data: DataTransfer) =>
      data.items.add(new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' }));

    it('land where they went, leaving the cursor where the person typed meanwhile', () => {
      const m = mount('Before after\n\nElsewhere');
      act(() => m.view.dispatch({ selection: { anchor: 7, head: 12 } }));
      paste(m, photo);
      expect(m.handle.read()).toBe('Before \n\nElsewhere');
      act(() => m.view.dispatch(m.view.state.replaceSelection('typed at the spot ')));
      act(() => m.view.dispatch({ selection: { anchor: m.view.state.doc.length } }));
      act(() => m.view.dispatch(m.view.state.replaceSelection(' and')));
      act(() => void m.uploads[0]?.place('![photo.png](attachment:a)'));
      act(() => m.view.dispatch(m.view.state.replaceSelection(' here')));
      expect(m.handle.read()).toBe(
        'Before ![photo.png](attachment:a)typed at the spot \n\nElsewhere and here',
      );
    });
  });
});
