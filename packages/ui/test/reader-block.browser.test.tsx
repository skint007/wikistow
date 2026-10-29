import { readProperties, splitFrontmatter } from '@wikistow/client';
import { PluginError, type BlockProps } from '@wikistow/plugin-sdk';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageProperties } from '../src/page/body-context.ts';
import { ReadingChanges } from '../src/page/reading-changes.tsx';
import { applyChanges, type ReadingChange } from '../src/page/reading-changes-model.ts';
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
async function mount() {
  const drawn: BlockProps[] = [];
  const queued: ReadingChange[] = [];
  const block: PluginBlock = {
    pluginId: 'test',
    type: 'servings',
    view: (element, props) => {
      drawn.push(props);
      element.textContent = `Serves ${JSON.stringify(props.properties?.['servings'])}`;
    },
  };
  const snapshot: Pick<PluginsSnapshot, 'plugins'> = { plugins: [] };
  const runtime = {
    get: () => snapshot,
    subscribe: () => () => {},
    viewFailed: () => {},
  } as unknown as PluginRuntime;
  let settle = () => {};
  function Page() {
    const [changes, setChanges] = useState<ReadingChange[]>([]);
    settle = () => setChanges([]);
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
            <ReaderBlock block={block} source="" page={{ spaceId: 's', pageId: 'p' }} />
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
  return { drawn, queued, settle: () => act(async () => settle()) };
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
});
