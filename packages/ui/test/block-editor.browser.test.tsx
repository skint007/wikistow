import { PluginError, type BlockProps } from '@wikistow/plugin-sdk';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import {
  PluginsContext,
  type PluginBlock,
  type PluginRuntime,
  type PluginsSnapshot,
} from '../src/plugins/runtime.ts';
import '@milkdown/kit/prose/view/style/prosemirror.css';

// A plugin block in the visual editor sets the page's properties as the
// person's edit (#212): the draft's frontmatter changes, only that value,
// and the block is drawn again as the properties change, but not for its
// own change.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

/** A block that records each time it is drawn, with the props it got. */
function recorder() {
  const drawn: BlockProps[] = [];
  const block: PluginBlock = {
    pluginId: 'test',
    type: 'servings',
    view: (element, props) => {
      drawn.push(props);
      element.textContent = `Serves ${JSON.stringify(props.properties?.['servings'])}`;
    },
  };
  // Only what the visual editor asks of the runtime.
  const snapshot: Pick<PluginsSnapshot, 'blocks'> = {
    blocks: new Map([['plugin:test/servings', block]]),
  };
  const runtime = {
    get: () => snapshot,
    subscribe: () => () => {},
    viewFailed: () => {},
  } as unknown as PluginRuntime;
  return { drawn, runtime };
}

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
          page={{ spaceId: 's', pageId: 'p' }}
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

const PAGE = '---\nservings: 4 # people\nnotes: |\n  Fresh.\n---\n```plugin:test/servings\n```\n';

describe('a plugin block in the visual editor', () => {
  it('sets a property as the person’s edit, drawn again for others’ changes but not its own', async () => {
    const { drawn, runtime } = recorder();
    const m = mount(PAGE, runtime);
    await expect.poll(() => drawn.length).toBe(1);
    const [first] = drawn;
    expect(first?.properties).toEqual({ servings: 4, notes: 'Fresh.\n' });
    if (!first?.setProperty) throw new Error('The block can’t set properties');

    act(() => first.setProperty?.('Servings', 6));
    await expect.poll(() => m.changes.at(-1)).toBe(PAGE.replace('servings: 4', 'servings: 6'));
    expect(m.handle.read()).toBe(PAGE.replace('servings: 4', 'servings: 6'));
    await act(async () => {});
    expect(drawn).toHaveLength(1);

    // A key the page hasn't is added at the block's end.
    act(() => first.setProperty?.('rating', 5));
    await expect.poll(() => m.handle.read()).toContain('  Fresh.\nrating: 5\n---\n');
    await act(async () => {});
    expect(drawn).toHaveLength(1);

    // Changed elsewhere, as Properties or the session would: drawn again with the new value.
    act(() => m.handle.replace(m.handle.read().replace('servings: 6', 'servings: 8')));
    await expect.poll(() => drawn.length).toBe(2);
    expect(drawn[1]?.properties?.['servings']).toBe(8);
  });

  it('refuses what can’t be set in place, and what isn’t a property, changing nothing', async () => {
    const { drawn, runtime } = recorder();
    const m = mount(PAGE, runtime);
    await expect.poll(() => drawn.length).toBe(1);
    const set = drawn[0]?.setProperty;
    expect(() => set?.('notes', 'Stale.')).toThrow(PluginError);
    expect(() => set?.('a.b', 1)).toThrow(PluginError);
    expect(() => set?.('servings', { a: 1 } as never)).toThrow(PluginError);
    expect(m.changes).toEqual([]);
    expect(m.handle.read()).toBe(PAGE);
  });
});
