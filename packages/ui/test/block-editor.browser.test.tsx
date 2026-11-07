import { PluginError, type BlockProps } from '@wikistow/plugin-sdk';
import type { BlockSpec } from '@wikistow/plugin-sdk/protocol';
import { act, createRef } from 'react';
import { userEvent } from 'vite-plus/test/browser/context';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { PluginsContext, type PluginRuntime } from '../src/plugins/runtime.ts';
import '@milkdown/kit/prose/view/style/prosemirror.css';
import { openVault, PAGE_REF } from './page-view.ts';
import { fakeScript, testRuntime, testSession } from './plugin-runtime.ts';

// A plugin block in the visual editor sets the page's properties as the
// person's edit (#212): the draft's frontmatter changes, only that value,
// and the block is drawn again as the properties change, but not for its
// own change.

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

/** A plugin's block that records each time it is drawn, with the props it got. */
async function recorder() {
  const drawn: BlockProps[] = [];
  const { runtime } = await testRuntime([
    {
      id: 'test',
      blocks: ['servings'],
      activate: (host) =>
        void host.blocks.register({
          type: 'servings',
          view: (element, props) => {
            drawn.push(props);
            element.textContent = `Serves ${JSON.stringify(props.properties?.['servings'])}`;
          },
        }),
    },
  ]);
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

const PAGE = '---\nservings: 4 # people\nnotes: |\n  Fresh.\n---\n```plugin:test/servings\n```\n';

describe('a plugin block in the visual editor', () => {
  it('sets a property as the person’s edit, drawn again for others’ changes but not its own', async () => {
    const { drawn, runtime } = await recorder();
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
    const { drawn, runtime } = await recorder();
    const m = mount(PAGE, runtime);
    await expect.poll(() => drawn.length).toBe(1);
    const set = drawn[0]?.setProperty;
    expect(() => set?.('notes', 'Stale.')).toThrow(PluginError);
    expect(() => set?.('a.b', 1)).toThrow(PluginError);
    expect(() => set?.('servings', { a: 1 } as never)).toThrow(PluginError);
    expect(m.changes).toEqual([]);
    expect(m.handle.read()).toBe(PAGE);
  });

  it('shows the failure note for a view that throws as its plugin starts', async () => {
    // The runtime tells its listeners of the failure at once, while the editor draws.
    const { runtime, session } = await testRuntime(
      [
        {
          id: 'test',
          blocks: ['servings'],
          activate: (host) =>
            void host.blocks.register({
              type: 'servings',
              view: () => {
                throw new Error('No');
              },
            }),
        },
      ],
      { session: testSession(false) },
    );
    const m = mount(PAGE, runtime);
    // Its code block is shown as text first, then the plugin starts.
    await expect.poll(() => m.container.querySelector('.code-block')).not.toBeNull();
    act(() => session.open());
    await expect.poll(() => m.container.textContent).toContain('test failed here.');
    expect(runtime.get().plugins.map(({ problem }) => problem)).toEqual(['A view failed: No']);
  });
});

/** A script's two blocks' forms, the first with a field bound to `servings`, as the runtime draws them. */
async function forms(): Promise<PluginRuntime> {
  const recipe: BlockSpec = {
    type: 'recipe',
    fields: { servings: { type: 'number', label: 'Servings', property: 'servings' } },
    outputs: {},
  };
  const product: BlockSpec = {
    type: 'product',
    fields: { quantity: { type: 'number', label: 'Quantity', default: 1 } },
    outputs: {},
  };
  const script = fakeScript([
    { type: 'block', block: recipe },
    { type: 'block', block: product },
  ]);
  const { runtime } = await testRuntime([
    { id: 'test', blocks: ['recipe', 'product'], script: script.launch },
  ]);
  return runtime;
}

/** The input labelled `label` in `container`. */
function field(container: HTMLElement, label: string): HTMLInputElement {
  const input = [...container.querySelectorAll('label')]
    .find((found) => found.textContent?.startsWith(label))
    ?.querySelector('input');
  if (!input) throw new Error(`No field ${label}`);
  return input;
}

describe('a script block’s form in the visual editor', () => {
  it('stays as it is, focus and text, when another block’s bound field sets a property', async () => {
    const m = mount(
      '---\nservings: 4\n---\n```plugin:test/recipe\n```\n\n```plugin:test/product\nquantity: 1\n```\n',
      await forms(),
    );
    await expect.poll(() => m.container.querySelectorAll('.plugin-block input').length).toBe(2);
    const quantity = field(m.container, 'Quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '3');
    const servings = field(m.container, 'Servings');
    expect(servings.value).toBe('4');
    await userEvent.clear(servings);
    await userEvent.type(servings, '6');
    // Clicking the other block's field commits this one, on blur.
    await userEvent.click(quantity);
    await expect.poll(() => m.handle.read()).toContain('servings: 6');
    await act(async () => {});
    expect(m.container.contains(quantity)).toBe(true);
    expect(document.activeElement).toBe(quantity);
    expect(quantity.value).toBe('3');
    // The bound field's own form took the page's value in place.
    expect(field(m.container, 'Servings')).toBe(servings);
    expect(servings.value).toBe('6');
  });
});
