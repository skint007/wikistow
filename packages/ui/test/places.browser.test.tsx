import { REGIONS, type PageHandle, type PageViewProps } from '@wikistow/plugin-sdk';
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
import {
  PluginsContext,
  type Contribution,
  type PluginRuntime,
  type PluginsSnapshot,
  type ShownPage,
} from '../src/plugins/runtime.ts';

// A place draws the app's own part first, then plugins' views in the
// snapshot's order (the order Settings lists plugins, then the order each
// registered), each with the props the runtime gives it, and a view that
// fails says so in its place, with Disable (#281). Drawn with a fake
// runtime, without the page route.

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

/** Every region empty but those given. */
const regions = (some: Partial<PluginsSnapshot['regions']>) => ({
  ...(Object.fromEntries(
    Object.keys(REGIONS).map((name) => [name, []]),
  ) as unknown as PluginsSnapshot['regions']),
  ...some,
});

async function draw(asides: Contribution<'page.aside'>[]) {
  const given = new Map<string, PageViewProps>();
  const failed: string[] = [];
  const disabled: string[] = [];
  const snapshot: Pick<PluginsSnapshot, 'regions' | 'plugins'> = {
    regions: regions({ 'page.aside': asides }),
    plugins: [],
  };
  const runtime: Pick<
    PluginRuntime,
    'get' | 'subscribe' | 'pageViewProps' | 'viewFailed' | 'disable'
  > = {
    get: () => snapshot as PluginsSnapshot,
    subscribe: () => () => {},
    // The same props while the page shown stays, as the runtime's.
    pageViewProps(pluginId, viewId, shown) {
      const key = `${pluginId} ${viewId}`;
      const handle: PageHandle = {
        page: shown.page,
        read: () => Promise.reject(new Error('Not here')),
        edit: null,
      };
      const props = given.get(key) ?? { page: handle };
      given.set(key, props);
      return props;
    },
    viewFailed: (pluginId) => void failed.push(pluginId),
    disable: async (pluginId) => void disabled.push(pluginId),
  };
  // The table of contents reads the address, for the section linked to.
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <PluginsContext value={runtime as unknown as PluginRuntime}>
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
  return { container, given, failed, disabled };
}

it('draws its own part, then plugin views in order with their props, and says when one fails', async () => {
  const drawn: { pluginId: string; props: PageViewProps }[] = [];
  const view = (pluginId: string) => (element: HTMLElement, props: PageViewProps) => {
    drawn.push({ pluginId, props });
    element.textContent = `${pluginId} here`;
  };
  const { container, given, failed, disabled } = await draw([
    { pluginId: 'second', id: 'time', view: view('second') },
    { pluginId: 'first', id: 'time', view: view('first') },
    {
      pluginId: 'broken',
      id: 'time',
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
    expect(props).toBe(given.get(`${pluginId} page.aside:time`));
    expect(props.page.page).toEqual(SHOWN.page);
  }
  expect(failed).toEqual(['broken']);

  await userEvent.click(aside!.querySelector('button')!);
  expect(disabled).toEqual(['broken']);
  // A place with nothing in it draws nothing, not even its wrapper.
  expect(container.querySelector('[data-region="page.header"]')).toBeNull();
});
