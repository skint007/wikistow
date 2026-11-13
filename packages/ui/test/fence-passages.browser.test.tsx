import { PageId, SpaceId, type ClientContext } from '@wikistow/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { readOwnText } from '../src/comments/passages.ts';
import { Markdown } from '../src/page/markdown.tsx';
import { PluginsContext, type PluginRuntime } from '../src/plugins/runtime.ts';
import { testRuntime } from './plugin-runtime.ts';

// A fence of a bare language a plugin draws (#401) reads, for a passage
// quoted over it, as the code it is without the plugin: as another viewer
// without the plugin, and the visual editor, read it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const spaceId = SpaceId.parse('s-home');
const ctx = {} as ClientContext;
const SOURCE = 'Before\n\n```dataview\nLIST FROM #soup\n```\n\nAfter\n';

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

async function read(runtime: PluginRuntime | null) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const markdown: ReactNode = (
    <Markdown
      source={SOURCE}
      passages
      attachments={{
        ctx,
        page: { spaceId, pageId: PageId.parse('p-self') },
        audience: 'published',
        attachments: [],
      }}
      pages={[]}
      links={new Map()}
      editing={null}
    />
  );
  const rootRoute = createRootRoute({
    component: () =>
      runtime ? <PluginsContext value={runtime}>{markdown}</PluginsContext> : markdown,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/s/$spaceId/p/$pageId' }),
    ]),
    history: createMemoryHistory(),
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  unmounts.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

describe('a claimed fence language, quoted', () => {
  it('reads as its code, as without the plugin', async () => {
    const { runtime } = await testRuntime([
      {
        id: 'tables',
        blocks: ['query'],
        fences: { dataview: 'query' },
        activate(host) {
          host.blocks.register({
            type: 'query',
            view: (element) => {
              element.textContent = 'A table of soups';
            },
          });
        },
      },
    ]);
    const drawn = await read(runtime);
    await expect.poll(() => drawn.textContent).toContain('A table of soups');
    const plain = await read(null);
    await expect.poll(() => plain.textContent).toContain('LIST FROM #soup');
    expect(readOwnText(drawn).text).toBe(readOwnText(plain).text);
    expect(readOwnText(drawn).text).toContain('LIST FROM #soup');
  });
});
