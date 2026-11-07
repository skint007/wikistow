import { inlineSpan, type BlockProps } from '@wikistow/plugin-sdk';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { transformer } from '../src/page/editor/visual/config.ts';
import { fidelityOf } from '../src/page/editor/visual/fidelity.ts';
import {
  PluginsContext,
  type PluginBlock,
  type PluginRuntime,
  type PluginsSnapshot,
} from '../src/plugins/runtime.ts';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { openVault, PAGE_REF } from './page-view.ts';

// Inline code a plugin claims (ADR 0011, decision 7) in the visual editor:
// an atom holding the span's Markdown, written back byte for byte however
// it was written, and the plugin's `setText` changing only the span.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
openVault();

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

// Claimed spans as people and plugins write them, in the places Markdown holds code.
const PAGES = [
  'Rated `plugin:test/stars 3` today.\n',
  'Empty `plugin:test/stars`, and `plugin:test/stars  two spaces ` kept.\n',
  'Ticks ``plugin:test/stars a`b`` and `` plugin:test/stars ends` `` too.\n',
  '*In `plugin:test/stars 4` emphasis* and [a `plugin:test/stars 5` link](https://x.test).\n',
  // A table as the editor writes it, which writes any table it's given aligned.
  '| Rating                   | Note |\n| ------------------------ | ---- |\n| `plugin:test/stars 2\\|3` | ok   |\n',
  '- An item `plugin:test/stars across\n  two lines` here\n',
  '> A quote `plugin:test/stars across\n> two lines` here\n',
  '# A heading `plugin:test/stars 1`\n',
  // Not claims: code that only looks like one, which stays code.
  'Not `plugin:Test/stars 1` nor `plugin:test/Stars x` nor `plugin:test/stars\tx` nor ` plugin:test/stars x`.\n',
];

describe('a claimed span in the visual editor', () => {
  it('is an atom written back byte for byte, wherever it is', async () => {
    const t = await transformer();
    for (const page of PAGES) {
      expect(t.serialize(t.parse(page)), page).toBe(page);
      expect(fidelityOf(page, t), page).toEqual({ visual: true });
    }
    // Each claim is one atom holding its Markdown, and nothing else is.
    const held: string[] = [];
    for (const page of PAGES)
      t.parse(page).descendants((node) => {
        if (node.type.name === 'plugin_inline') held.push(String(node.attrs['source']));
      });
    expect(held).toEqual([
      '`plugin:test/stars 3`',
      '`plugin:test/stars`',
      '`plugin:test/stars  two spaces `',
      '``plugin:test/stars a`b``',
      '`` plugin:test/stars ends` ``',
      '`plugin:test/stars 4`',
      '`plugin:test/stars 5`',
      // In a table cell its bar as code reads it, escaped again as it's written there.
      '`plugin:test/stars 2|3`',
      // Its later lines without the container's indent or marker, which it writes again.
      '`plugin:test/stars across\ntwo lines`',
      '`plugin:test/stars across\ntwo lines`',
      '`plugin:test/stars 1`',
    ]);
  });

  it('is drawn by its plugin, whose setText changes only the span, as the person’s edit', async () => {
    const drawn: { text: string; setText: ((text: string) => void) | null }[] = [];
    const span: PluginBlock = {
      pluginId: 'test',
      type: 'stars',
      // As the runtime adapts the span's view (`spanBlockView`).
      view: (element, { source, setSource }: BlockProps) => {
        drawn.push({ text: source, setText: setSource });
        element.textContent = `★ ${source}`;
      },
    };
    const snapshot: Pick<PluginsSnapshot, 'blocks' | 'inline' | 'plugins'> = {
      blocks: new Map(),
      inline: new Map([['plugin:test/stars', span]]),
      plugins: [],
    };
    // Only what the visual editor asks of the runtime.
    const runtime = {
      get: () => snapshot,
      subscribe: () => () => {},
      viewFailed: () => {},
    } as unknown as PluginRuntime;
    const page = 'One `plugin:test/stars 3` and ``plugin:test/stars a`b``, as typed.\n';
    const m = mount(page, runtime);
    await expect.poll(() => drawn.map(({ text }) => text)).toEqual(['3', 'a`b']);
    expect(m.container.querySelectorAll('.plugin-inline')).toHaveLength(2);
    expect(m.changes).toEqual([]);

    act(() => drawn[0]?.setText?.('5'));
    const next = page.replace('`plugin:test/stars 3`', inlineSpan('test', 'stars', '5'));
    await expect.poll(() => m.changes.at(-1)).toBe(next);
    expect(m.handle.read()).toBe(next);
    await act(async () => {});
    // Not drawn again for its own change.
    expect(drawn).toHaveLength(2);
  });
});

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  window.localStorage.clear();
});

function mount(initial: string, runtime: PluginRuntime) {
  window.localStorage.setItem('wikistow.editor', 'visual');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const ref = createRef<EditorSurfaceHandle>();
  const changes: string[] = [];
  act(() =>
    root.render(
      <PluginsContext value={runtime}>
        <PageEditor
          ref={ref}
          initial={initial}
          onChange={(markdown) => changes.push(markdown)}
          status={null}
          links={links}
          attachments={{ list: [], url: async () => null }}
          onFiles={() => {}}
          page={PAGE_REF}
        />
      </PluginsContext>,
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  if (!ref.current) throw new Error('The editor did not mount');
  return { handle: ref.current, changes, container };
}
