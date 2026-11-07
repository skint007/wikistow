import type { AppHost, PageViewProps, SpaceHomeProps, View } from '@wikistow/plugin-sdk';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, expect, it } from 'vite-plus/test';
import { Place, Replaceable } from '../src/plugins/places.tsx';
import { PluginsContext, type PluginRuntime, type ShownPage } from '../src/plugins/runtime.ts';
import { testRuntime } from './plugin-runtime.ts';

// A place draws the app's own part first, then plugins' views in the
// snapshot's order (the order Settings lists plugins, then the order each
// registered), each with the props the runtime gives it, and a view that
// fails says so in its place, with Disable (#281). Drawn with a runtime
// over the in-memory store, without the page route.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

const SHOWN: ShownPage = {
  page: { spaceId: 's', pageId: 'p' },
  version: 'published',
  revision: 'r1',
  draft: null,
};

/** Plugins in this order, each putting `view` in the page's aside. */
async function draw(asides: { pluginId: string; view: View<PageViewProps> }[]) {
  const made = await testRuntime(
    asides.map(({ pluginId, view }) => ({
      id: pluginId,
      activate: (host) => void host.ui.register('page.aside', { id: 'time', view }),
    })),
  );
  const { runtime } = made;
  // The table of contents reads the address, for the section linked to.
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <PluginsContext value={runtime}>
          <Place
            name="page.aside"
            shown={SHOWN}
            contents={{
              headings: [
                { id: 'one', text: 'One', level: 2 },
                { id: 'two', text: 'Two', level: 2 },
              ],
              card: null,
            }}
          />
          <Place name="page.header" shown={SHOWN} />
        </PluginsContext>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  await expect.poll(() => container.querySelector('[data-region="page.aside"]')).not.toBeNull();
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, ...made };
}

it('draws its own part, then plugin views in order with their props, and says when one fails', async () => {
  const drawn: { pluginId: string; props: PageViewProps }[] = [];
  const view = (pluginId: string) => (element: HTMLElement, props: PageViewProps) => {
    drawn.push({ pluginId, props });
    element.textContent = `${pluginId} here`;
  };
  const { container, runtime, store } = await draw([
    { pluginId: 'second', view: view('second') },
    { pluginId: 'first', view: view('first') },
    {
      pluginId: 'broken',
      view: () => {
        throw new Error('It broke');
      },
    },
  ]);

  const aside = container.querySelector('[data-region="page.aside"]');
  // The table of contents, the app's own, first; then the plugins as the snapshot lists them.
  expect([...(aside?.children ?? [])].map((child) => child.textContent)).toEqual([
    'On this pageOneTwo',
    'second here',
    'first here',
    'broken failed here.Disable',
  ]);
  // Each view gets what the runtime gave for it, by its place and ID.
  expect(drawn.map(({ pluginId }) => pluginId)).toEqual(['second', 'first']);
  for (const { pluginId, props } of drawn) {
    expect(props).toBe(runtime.pageViewProps(pluginId, 'page.aside:time', SHOWN));
    expect(props.page.page).toEqual(SHOWN.page);
  }
  const problems = () =>
    runtime.get().plugins.flatMap(({ plugin, problem }) => (problem ? [plugin.manifest.id] : []));
  expect(problems()).toEqual(['broken']);

  await userEvent.click(aside!.querySelector('button')!);
  await expect
    .poll(async () =>
      (await store.list()).plugins?.find(({ manifest }) => manifest.id === 'broken'),
    )
    .toMatchObject({ enabled: false });
  // A place with nothing in it draws nothing, not even its wrapper.
  expect(container.querySelector('[data-region="page.header"]')).toBeNull();
});

/** `node`, drawn with `runtime`'s plugins. */
async function mount(runtime: PluginRuntime, node: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<PluginsContext value={runtime}>{node}</PluginsContext>));
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

/** A plugin whose manifest replaces a space's home, and draws it with `view`. */
const homeOf = (id: string, view: View<SpaceHomeProps>) => ({
  id,
  replaces: ['space.home'],
  activate: (host: AppHost) => void host.ui.replace?.('space.home', { id: 'home', view }),
});

/** A space's home, in `spaceId`, with the app's own part. */
const home = (spaceId: string) => (
  <section data-space={spaceId}>
    <Replaceable name="space.home" inputs={{ spaceId }}>
      <p>Pick a page</p>
    </Replaceable>
  </section>
);

// Only in a space the plugin has page access in, as `host.app.spaces.list()` names them.
const inSpaceS = { spaces: async () => [{ spaceId: 's', name: 'S', icon: null }] };

it('draws a replaced region by the first plugin in order the person lets, and the app’s own part elsewhere', async () => {
  const drawing =
    (name: string): View<SpaceHomeProps> =>
    (element, { spaceId }) => {
      element.textContent = `${name} in ${spaceId}`;
    };
  const { runtime, store } = await testRuntime(
    [homeOf('first', drawing('First')), homeOf('second', drawing('Second'))],
    inSpaceS,
  );
  const container = await mount(
    runtime,
    <>
      {home('s')}
      {home('t')}
    </>,
  );
  const text = (spaceId: string) =>
    container.querySelector(`[data-space="${spaceId}"]`)?.textContent;
  await expect.poll(() => text('s')).toBe('First in s');
  // No page access there: the app's own.
  expect(text('t')).toBe('Pick a page');

  // Use the app's own, for the first: the next in order draws it; for both, the app's own.
  await act(async () => {
    await store.setOwnParts({ id: 'first', library: true }, ['space.home']);
    await runtime.refresh();
  });
  await expect.poll(() => text('s')).toBe('Second in s');
  await act(async () => {
    await store.setOwnParts({ id: 'second', library: true }, ['space.home']);
    await runtime.refresh();
  });
  await expect.poll(() => text('s')).toBe('Pick a page');
});

it('gives a replaced region back to the app’s own part, with a note, when its view throws or draws nothing', async () => {
  for (const view of [
    () => {
      throw new Error('It broke');
    },
    () => {},
  ] satisfies View<SpaceHomeProps>[]) {
    const { runtime, store } = await testRuntime([homeOf('broken', view)], inSpaceS);
    const container = await mount(runtime, home('s'));
    await expect.poll(() => container.textContent).toBe('broken failed here.DisablePick a page');
    expect(runtime.get().plugins[0]?.problem).toMatch(/^A view failed: /);
    await userEvent.click(container.querySelector('button')!);
    await expect.poll(async () => (await store.list()).plugins?.[0]?.enabled).toBe(false);
    await expect.poll(() => container.textContent).toBe('Pick a page');
  }
});

it('lets a plugin replace only what its manifest names', async () => {
  const { runtime } = await testRuntime([
    {
      id: 'unnamed',
      activate: (host) => void host.ui.replace?.('folder.view', { id: 'folder', view: () => {} }),
    },
  ]);
  expect(runtime.get().plugins[0]?.problem).toBe(
    'It failed to start: Its manifest replaces no folder.view',
  );
  expect(runtime.get().replaced['folder.view']).toBeNull();
});
