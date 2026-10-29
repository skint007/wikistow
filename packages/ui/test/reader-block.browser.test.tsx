import { readProperties, splitFrontmatter } from '@wikistow/client';
import { PluginError, type BlockProps } from '@wikistow/plugin-sdk';
import type { BlockSpec } from '@wikistow/plugin-sdk/protocol';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageProperties } from '../src/page/body-context.ts';
import { ReadingChanges } from '../src/page/reading-changes.tsx';
import { applyChanges, type ReadingChange } from '../src/page/reading-changes-model.ts';
import { formView } from '../src/plugins/block-form.tsx';
import { ReaderBlock } from '../src/plugins/blocks.tsx';
import {
  PluginsContext,
  type PluginBlock,
  type PluginRuntime,
  type PluginsSnapshot,
} from '../src/plugins/runtime.ts';

// A plugin block in the reader sets the page's properties through the
// page's queue (#212): only a change that applies to the page as shown,
// and the view goes back to the page's value when a queued change doesn't
// stick.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PAGE = '---\nservings: 4\nnotes: |\n  Fresh.\n---\nBody\n';

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

/**
 * A reader block on `PAGE`, whose view records each time it is drawn. Its
 * changes are queued as the page's queue would, made in what's shown;
 * `settle()` empties the queue, as a flush that left them in the draft or
 * found them unchanged does.
 */
async function mount(extra: { block: PluginBlock; source: string }[] = []) {
  const drawn: BlockProps[] = [];
  const queued: ReadingChange[] = [];
  const recording = (element: HTMLElement, props: BlockProps) => {
    drawn.push(props);
    element.textContent = `Serves ${JSON.stringify(props.properties?.['servings'])}`;
  };
  const block: PluginBlock = { pluginId: 'test', type: 'servings', view: recording };
  // The same plugin's view again, as it reloads: another function, drawing the same.
  const reloaded: PluginBlock = { ...block, view: (element, props) => recording(element, props) };
  let reload = () => {};
  const snapshot: Pick<PluginsSnapshot, 'plugins'> = { plugins: [] };
  const runtime = {
    get: () => snapshot,
    subscribe: () => () => {},
    viewFailed: () => {},
  } as unknown as PluginRuntime;
  let settle = () => {};
  function Page() {
    const [changes, setChanges] = useState<ReadingChange[]>([]);
    const [shown, setShown] = useState(block);
    settle = () => setChanges([]);
    reload = () => setShown(reloaded);
    const markdown = applyChanges(PAGE, changes).markdown;
    const read = readProperties(splitFrontmatter(markdown).frontmatter);
    // The same function every render, as the page's queue gives it.
    const [change] = useState(() => (made: ReadingChange) => {
      queued.push(made);
      setChanges((before) => [...before, made]);
    });
    return (
      <PluginsContext value={runtime}>
        <ReadingChanges value={{ markdown, rights: { allowed: true }, change }}>
          <PageProperties value={read.ok ? read.properties : null}>
            <ReaderBlock block={shown} source="" page={{ spaceId: 's', pageId: 'p' }} />
            {extra.map((more, i) => (
              <ReaderBlock
                key={i}
                block={more.block}
                source={more.source}
                page={{ spaceId: 's', pageId: 'p' }}
              />
            ))}
          </PageProperties>
        </ReadingChanges>
      </PluginsContext>
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Page />));
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    drawn,
    queued,
    settle: () => act(async () => settle()),
    reload: () => act(async () => reload()),
  };
}

describe('a plugin block in the reader', () => {
  it('queues a change that applies, not drawn again for it', async () => {
    const m = await mount();
    expect(m.drawn).toHaveLength(1);
    await act(async () => m.drawn[0]?.setProperty?.('servings', 6));
    expect(m.queued).toEqual([{ kind: 'property', key: 'servings', value: 6 }]);
    expect(m.drawn).toHaveLength(1);
  });

  it('refuses a change that can’t be made in place, queuing nothing', async () => {
    const m = await mount();
    const set = m.drawn[0]?.setProperty;
    expect(() => set?.('notes', 'Stale.')).toThrow(PluginError);
    expect(() => set?.('notes', 'Stale.')).toThrow(/notes couldn’t be changed/);
    expect(m.queued).toEqual([]);
    expect(m.drawn).toHaveLength(1);
  });

  it('goes back to the page’s value when the change doesn’t stick', async () => {
    const m = await mount();
    await act(async () => m.drawn[0]?.setProperty?.('servings', 6));
    // Left in the draft, or found unchanged: the page shows its own value again.
    await m.settle();
    expect(m.drawn).toHaveLength(2);
    expect(m.drawn[1]?.properties?.['servings']).toBe(4);
  });

  it('drawn again for a reloaded view, shows the properties as they are then', async () => {
    const m = await mount();
    await act(async () => m.drawn[0]?.setProperty?.('servings', 6));
    expect(m.drawn).toHaveLength(1);
    await m.reload();
    expect(m.drawn).toHaveLength(2);
    expect(m.drawn[1]?.properties?.['servings']).toBe(6);
  });
});

describe('a script block’s form in the reader', () => {
  it('stays as it is, text and all, when another block’s bound field sets a property', async () => {
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
    const m = await mount([
      {
        block: { pluginId: 'test', type: 'recipe', view: formView(recipe, async () => ({})) },
        source: '',
      },
      {
        block: { pluginId: 'test', type: 'product', view: formView(product, async () => ({})) },
        source: '',
      },
    ]);
    const field = (label: string) => {
      const input = [...m.container.querySelectorAll('label')]
        .find((found) => found.textContent?.startsWith(label))
        ?.querySelector('input');
      if (!input) throw new Error(`No field ${label}`);
      return input;
    };
    await expect.poll(() => m.container.querySelectorAll('input').length).toBe(2);
    const quantity = field('Quantity');
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '3');
    const servings = field('Servings');
    expect(servings.value).toBe('4');
    await userEvent.clear(servings);
    await userEvent.type(servings, '6{Enter}');
    expect(m.queued).toEqual([{ kind: 'property', key: 'servings', value: 6 }]);
    await act(async () => {});
    expect(m.container.contains(quantity)).toBe(true);
    expect(quantity.value).toBe('3');
    expect(field('Servings')).toBe(servings);
    expect(servings.value).toBe('6');
    // The queue settles without it, as into the draft: the form shows the page's value again, in place.
    await m.settle();
    expect(field('Servings')).toBe(servings);
    expect(servings.value).toBe('4');
    expect(quantity.value).toBe('3');
  });
});
