import type { PageViewProps, View } from '@wikistow/plugin-sdk';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vite-plus/test/browser/context';
import { afterEach, expect, it } from 'vite-plus/test';
import { Place } from '../src/plugins/places.tsx';
import { PluginsContext, type ShownPage } from '../src/plugins/runtime.ts';
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
