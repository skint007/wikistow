import { EditorState, TextSelection } from '@milkdown/kit/prose/state';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import type { AttachmentRef } from '@wikistow/client';
import type { EditorSurfaceHandle } from '../src/page/editor/surface.ts';
import { loadSyntaxNodes, transformer } from '../src/page/editor/visual/config.ts';
import { fidelityOf, withLf, writesAsShown } from '../src/page/editor/visual/fidelity.ts';
import { FORMATS, heading, quoteAs, type Format } from '../src/page/editor/visual/formatting.ts';
import {
  insertAttachment,
  insertLink,
  linkAround,
  removeLink,
  setLink,
} from '../src/page/editor/visual/links.ts';
import VisualSurface from '../src/page/editor/visual/visual-surface.tsx';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { viewOf } from './editor-view.ts';

// The visual editor's formatting toolbar, in Chromium: each control, on
// any page and selection, leaves a document the write-time guard takes.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

/** The visual editor's element, mounted on `initial`. */
async function mount(initial: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  // Loaded first: the editor waits for them, which `act` doesn't.
  await loadSyntaxNodes();
  await act(async () =>
    root.render(
      <VisualSurface
        ref={ref}
        initial={initial}
        onChange={() => {}}
        links={{
          pages: [],
          targets: () => null,
          selfId: 'self',
          table: new Map(),
          headings: async () => [],
          ownHeadings: async () => [],
          create: () => {},
          pick: () => {},
          choose: () => {},
        }}
        attachments={{ list: [], url: async () => '' }}
        onFiles={() => {}}
        onUnfaithful={() => {}}
      />,
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
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return dom;
}

const PHOTO = {
  id: 'a1',
  name: 'bed photo.png',
  mediaType: 'image/png',
  size: 2048,
} as AttachmentRef;
const NOTES = {
  id: 'b2',
  name: 'notes.pdf',
  mediaType: 'application/pdf',
  size: 2048,
} as AttachmentRef;

const corpus = import.meta.glob<string>('../../client/test/corpus/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

it('leaves no page the editor opens in a state the write-time guard refuses', async () => {
  const t = await transformer();
  // The editor's own plugins, which keep what it shows writable as it changes.
  const { plugins } = viewOf(await mount('')).state;
  const inLink = (state: EditorState) => linkAround(state) !== null;
  const formats: Record<string, Format> = {
    ...FORMATS,
    ...Object.fromEntries([0, 1, 2, 3].map((l) => [`h${l}`, heading(l)])),
    plainQuote: quoteAs(null),
    note: quoteAs('note'),
    warning: quoteAs('warning'),
    link: { active: inLink, run: setLink('https://example.com') },
    insertLink: { active: inLink, run: insertLink('a link', 'https://example.com') },
    removeLink: { active: inLink, run: removeLink },
    image: { active: inLink, run: insertAttachment(PHOTO) },
    file: { active: inLink, run: insertAttachment(NOTES) },
  };
  const refused: string[] = [];
  for (const [path, markdown] of Object.entries(corpus)) {
    if (!fidelityOf(markdown, t).visual) continue;
    const doc = t.parse(withLf(markdown));
    // A cursor in, and a selection of, each text block; and the whole page.
    const selections: [number, number][] = [[0, doc.content.size]];
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      selections.push([pos + 1, pos + 1], [pos + 1, pos + 1 + node.content.size]);
      return false;
    });
    for (const [from, to] of selections)
      for (const [name, format] of Object.entries(formats)) {
        const state = EditorState.create({
          doc,
          plugins,
          selection: TextSelection.between(doc.resolve(from), doc.resolve(to)),
        });
        // Telling whether it's on mustn't fail anywhere either.
        format.active(state);
        format.run(state, (tr) => {
          const next = state.apply(tr).doc;
          if (!writesAsShown(next, t.serialize(next), t.parse))
            refused.push(`${path.split('/').at(-1)} ${name} at ${from}-${to}`);
        });
      }
  }
  expect(refused).toEqual([]);
});
