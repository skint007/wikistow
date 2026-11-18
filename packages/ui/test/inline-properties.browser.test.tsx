import { readProperties, splitFrontmatter } from '@wikistow/client';
import { PluginError, type InlineProps } from '@wikistow/plugin-sdk';
import type { InlineSpec } from '@wikistow/plugin-sdk/protocol';
import { act, createRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { PageProperties } from '../src/page/body-context.ts';
import { PageEditor } from '../src/page/editor/page-editor.tsx';
import type { EditorSurfaceHandle, LinkAssist } from '../src/page/editor/surface.ts';
import { ReadingChanges } from '../src/page/reading-changes.tsx';
import { applyChanges, type ReadingChange } from '../src/page/reading-changes-model.ts';
import { ReaderSpan } from '../src/plugins/blocks.tsx';
import { spanProperty } from '../src/plugins/inline-field.tsx';
import { PluginsContext, type PluginRuntime } from '../src/plugins/runtime.ts';
import { openVault, PAGE_REF } from './page-view.ts';
import { fakeScript, testRuntime } from './plugin-runtime.ts';

// Claimed spans and the page's properties (#402): an app plugin's span
// gets `properties` and `setProperty` under a block's rules, and a
// script's span is one field the app draws, bound to a property. In the
// editor a change is the person's edit; in the reader it is queued as a
// tick is, and the span's text never changes there.

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

/** An app plugin's span that records each time it is drawn, with the props it got. */
async function recorder() {
  const drawn: InlineProps[] = [];
  const { runtime } = await testRuntime([
    {
      id: 'test',
      inline: ['stars'],
      activate: (host) =>
        void host.inline.register({
          type: 'stars',
          view: (element, props) => {
            drawn.push(props);
            element.textContent = `★ ${JSON.stringify(props.properties?.['rating'])}`;
          },
        }),
    },
  ]);
  return { drawn, runtime };
}

const DONE: InlineSpec = {
  type: 'done',
  field: { type: 'boolean', label: 'Done', property: 'done' },
};
const STATUS: InlineSpec = {
  type: 'status',
  field: {
    type: 'choice',
    label: 'Status',
    property: 'status',
    options: [
      { value: 'todo', label: 'To do' },
      { value: 'done', label: 'Done' },
    ],
  },
};
const GUESTS: InlineSpec = {
  type: 'guests',
  field: { type: 'number', label: 'Guests', min: 1, max: 6, slider: true, property: 'guests' },
};

/** A script's spans, as the runtime draws them; `inline` what its manifest claims. */
async function scriptSpans(inline = ['done', 'status', 'guests']) {
  const script = fakeScript([
    { type: 'inline', inline: DONE },
    { type: 'inline', inline: STATUS },
    { type: 'inline', inline: GUESTS },
  ]);
  return testRuntime([{ id: 'test', inline, script: script.launch }]);
}

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  window.localStorage.clear();
});

function mountEditor(initial: string, runtime: PluginRuntime) {
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

/**
 * The reader's spans in `markdown` (each `[type, text]`), on a page whose
 * changes are queued as the page's queue would, made in what's shown;
 * `allowed` false where the person can't change the page while reading.
 */
function mountReader(
  runtime: PluginRuntime,
  page: string,
  spans: [string, string][],
  allowed = true,
) {
  const queued: ReadingChange[] = [];
  function Page() {
    const [changes, setChanges] = useState<ReadingChange[]>([]);
    const { inline } = useSyncExternalStore(runtime.subscribe, runtime.get);
    const markdown = applyChanges(page, changes).markdown;
    const read = readProperties(splitFrontmatter(markdown).frontmatter);
    const [change] = useState(() => (made: ReadingChange) => {
      queued.push(made);
      setChanges((before) => [...before, made]);
    });
    return (
      <PluginsContext value={runtime}>
        <ReadingChanges
          value={{
            markdown,
            rights: allowed ? { allowed: true } : { allowed: false, hint: null },
            change,
          }}
        >
          <PageProperties value={read.ok ? read.properties : null}>
            <p>
              {spans.map(([type, text], i) => {
                const span = inline.get(`plugin:test/${type}`);
                return (
                  span && (
                    <ReaderSpan
                      key={i}
                      span={span}
                      text={text}
                      page={{ spaceId: 's', pageId: 'p' }}
                    />
                  )
                );
              })}
            </p>
          </PageProperties>
        </ReadingChanges>
      </PluginsContext>
    );
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Page />));
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, queued };
}

const PAGE =
  '---\nrating: 3 # of five\nnotes: |\n  Fresh.\n---\nRated `plugin:test/stars` today.\n';

describe('an app plugin’s span in the visual editor', () => {
  it('gets the properties and sets one as the person’s edit, drawn again for others’ changes but not its own', async () => {
    const { drawn, runtime } = await recorder();
    const m = mountEditor(PAGE, runtime);
    await expect.poll(() => drawn.length).toBe(1);
    const [first] = drawn;
    expect(first?.properties).toEqual({ rating: 3, notes: 'Fresh.\n' });
    expect(first?.setText).not.toBeNull();
    if (!first?.setProperty) throw new Error('The span can’t set properties');

    act(() => first.setProperty?.('Rating', 5));
    await expect.poll(() => m.handle.read()).toBe(PAGE.replace('rating: 3', 'rating: 5'));
    await act(async () => {});
    expect(drawn).toHaveLength(1);

    // Changed elsewhere, as Properties or the live session would: drawn again with the new value.
    act(() => m.handle.replace(m.handle.read().replace('rating: 5', 'rating: 1')));
    await expect.poll(() => drawn.length).toBe(2);
    expect(drawn[1]?.properties?.['rating']).toBe(1);
  });

  it('refuses what can’t be set in place, changing nothing', async () => {
    const { drawn, runtime } = await recorder();
    const m = mountEditor(PAGE, runtime);
    await expect.poll(() => drawn.length).toBe(1);
    expect(() => drawn[0]?.setProperty?.('notes', 'Stale.')).toThrow(PluginError);
    expect(() => drawn[0]?.setProperty?.('a.b', 1)).toThrow(PluginError);
    expect(m.changes).toEqual([]);
  });
});

describe('an app plugin’s span in the reader', () => {
  it('sets properties through the page’s queue, and never its text', async () => {
    const { drawn, runtime } = await recorder();
    mountReader(runtime, PAGE, [['stars', '']]);
    await expect.poll(() => drawn.length).toBe(1);
    expect(drawn[0]?.setText).toBeNull();
    expect(drawn[0]?.properties?.['rating']).toBe(3);
    act(() => drawn[0]?.setProperty?.('rating', 4));
    await act(async () => {});
    // Its own change, now shown, doesn't draw it again.
    expect(drawn).toHaveLength(1);
    // One that can't apply to the page as shown is refused, and nothing is queued.
    expect(() => drawn[0]?.setProperty?.('notes', 'Stale.')).toThrow(PluginError);
  });

  it('can’t set them where the page can’t change while it’s read', async () => {
    const { drawn, runtime } = await recorder();
    mountReader(runtime, PAGE, [['stars', '']], false);
    await expect.poll(() => drawn.length).toBe(1);
    expect(drawn[0]?.setProperty).toBeNull();
    expect(drawn[0]?.properties?.['rating']).toBe(3);
  });
});

const SCRIPTED =
  '---\ndone: false\nstatus: todo\n---\n' +
  'Done `plugin:test/done`, reviewed `plugin:test/done reviewed`, ' +
  'status `plugin:test/status`, guests `plugin:test/guests`.\n';

describe('a script’s span in the visual editor', () => {
  it('draws its field bound to a property, which it sets as the person’s edit', async () => {
    const { runtime } = await scriptSpans();
    const m = mountEditor(SCRIPTED, runtime);
    await expect
      .poll(() => m.container.querySelectorAll('.plugin-inline [role=switch]').length)
      .toBe(2);
    const [done, reviewed] = m.container.querySelectorAll<HTMLElement>(
      '.plugin-inline [role=switch]',
    );
    // Named by its label, or by the property its text names.
    expect(done?.getAttribute('aria-label')).toBe('Done');
    expect(reviewed?.getAttribute('aria-label')).toBe('reviewed');
    expect(done?.getAttribute('aria-checked')).toBe('false');

    await userEvent.click(done!);
    await expect.poll(() => m.handle.read()).toBe(SCRIPTED.replace('done: false', 'done: true'));
    // A key the page hasn't is added.
    await userEvent.click(reviewed!);
    await expect.poll(() => m.handle.read()).toContain('status: todo\nreviewed: true\n---\n');
    // The span's text, the body, never changes for it.
    expect(m.handle.read()).toContain(SCRIPTED.slice(SCRIPTED.indexOf('Done `')));

    // Changed elsewhere, the field shows the page's value.
    act(() => m.handle.replace(m.handle.read().replace('done: true', 'done: false')));
    await expect.poll(() => done?.getAttribute('aria-checked')).toBe('false');
  });

  it('shows a value it can’t take as invalid, and text that isn’t a property’s name', async () => {
    const { runtime } = await scriptSpans();
    const page =
      '---\nstatus: later\nguests: 9\n---\nA `plugin:test/status` `plugin:test/guests` `plugin:test/done a.b`.\n';
    const m = mountEditor(page, runtime);
    await expect.poll(() => m.container.querySelectorAll('.plugin-inline').length).toBe(3);
    await expect
      .poll(() => m.container.querySelector('[aria-invalid=true][data-slot=picker]'))
      .not.toBeNull();
    // Each span's field is a React root of its own, drawn in its own time.
    await expect
      .poll(() => m.container.querySelector('input[type=range][aria-invalid=true]'))
      .not.toBeNull();
    await expect
      .poll(() => m.container.querySelector('.plugin-inline code')?.textContent)
      .toBe('a.b: Not a property’s name');
    expect(m.changes).toEqual([]);
  });
});

describe('a script’s span in the reader', () => {
  it('sets its property through the page’s queue', async () => {
    const { runtime } = await scriptSpans();
    const { container, queued } = mountReader(runtime, SCRIPTED, [
      ['done', ''],
      ['done', 'reviewed'],
    ]);
    await expect.poll(() => container.querySelectorAll('[role=switch]').length).toBe(2);
    const [done] = container.querySelectorAll<HTMLElement>('[role=switch]');
    await userEvent.click(done!);
    await expect.poll(() => queued).toEqual([{ kind: 'property', key: 'done', value: true }]);
    await expect.poll(() => done?.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps a value entered where the page can’t change, setting nothing', async () => {
    const { runtime } = await scriptSpans();
    const { container, queued } = mountReader(runtime, SCRIPTED, [['done', '']], false);
    await expect.poll(() => container.querySelector('[role=switch]')).not.toBeNull();
    const done = container.querySelector<HTMLElement>('[role=switch]');
    await userEvent.click(done!);
    await expect.poll(() => done?.getAttribute('aria-checked')).toBe('true');
    expect(queued).toEqual([]);
  });
});

describe('a script’s span its manifest doesn’t claim', () => {
  it('isn’t drawn, and the plugin says why', async () => {
    const { runtime } = await scriptSpans(['done']);
    await expect.poll(() => runtime.get().inline.size).toBe(1);
    expect([...runtime.get().inline.keys()]).toEqual(['plugin:test/done']);
    expect(runtime.get().plugins[0]?.problem).toContain('Its manifest claims no inline code');
  });
});

describe('the property a script’s span is bound to', () => {
  it('is the one its text names, else the field’s own', () => {
    const field = { type: 'boolean', label: 'Done', property: 'done' } as const;
    expect(spanProperty(field, '')).toBe('done');
    expect(spanProperty(field, ' reviewed ')).toBe('reviewed');
    expect(spanProperty(field, 'two words')).toBe('two words');
    expect(spanProperty(field, 'a.b')).toBeUndefined();
    expect(spanProperty({ type: 'boolean', label: 'Done' }, '')).toBeUndefined();
  });
});
