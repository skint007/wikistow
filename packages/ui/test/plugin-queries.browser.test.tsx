import type { AppHost, BlockProps, View } from '@wikistow/plugin-sdk';
import { describe, expect, it } from 'vite-plus/test';
import { fakeScript, testRuntime, type TestPlugin } from './plugin-runtime.ts';

// What #401 gives plugins in the runtime: bare fence languages they claim
// in their manifests (`fences`), drawn by one plugin each, and
// `index.changed`, told only where the plugin can read.

const view: View<BlockProps> = () => {};

/** A plugin whose manifest claims `dataview` fences as its `query` block, which it draws if `draws`. */
const claiming = (
  id: string,
  { draws = true, ownParts }: { draws?: boolean; ownParts?: string[] } = {},
): TestPlugin => ({
  id,
  blocks: ['query'],
  fences: { dataview: 'query' },
  ...(ownParts ? { ownParts } : {}),
  activate: draws
    ? (host: AppHost) => {
        host.blocks.register({ type: 'query', view });
      }
    : () => {},
});

describe('bare fence languages', () => {
  it('draws one with the first plugin in Settings’ order that draws its block', async () => {
    const { runtime } = await testRuntime([claiming('alpha'), claiming('beta')]);
    const { blocks } = runtime.get();
    expect(blocks.get('dataview')).toMatchObject({ pluginId: 'alpha', type: 'query' });
    // Each still draws its own `plugin:<id>/<type>` fences.
    expect(blocks.get('plugin:beta/query')).toMatchObject({ pluginId: 'beta' });
  });

  it('passes over a plugin that draws no such block, or one the person gave the language back from', async () => {
    const quiet = await testRuntime([claiming('alpha', { draws: false }), claiming('beta')]);
    expect(quiet.runtime.get().blocks.get('dataview')?.pluginId).toBe('beta');
    const given = await testRuntime([
      claiming('alpha', { ownParts: ['fence:dataview'] }),
      claiming('beta'),
    ]);
    expect(given.runtime.get().blocks.get('dataview')?.pluginId).toBe('beta');
    const neither = await testRuntime([
      claiming('alpha', { ownParts: ['fence:dataview'] }),
      claiming('beta', { ownParts: ['fence:dataview'] }),
    ]);
    // Code, as without the plugins.
    expect(neither.runtime.get().blocks.has('dataview')).toBe(false);
    expect(neither.runtime.get().blocks.has('plugin:alpha/query')).toBe(true);
  });

  it('fills in a script’s form for a bare language it claims', async () => {
    const script = fakeScript([
      {
        type: 'block',
        block: {
          type: 'recipe',
          fields: { servings: { type: 'number', label: 'Servings', default: 2 } },
          outputs: {},
        },
      },
    ]);
    const { runtime } = await testRuntime([
      { id: 'cook', script: script.launch, blocks: ['recipe'], fences: { recipe: 'recipe' } },
    ]);
    const page = { spaceId: 's', pageId: 'p' };
    const results = await runtime.blockResults('recipe', page, 'servings: 6');
    expect(results?.fields['servings']).toMatchObject({ value: 6 });
    expect(await runtime.blockResults('plugin:cook/recipe', page, '')).not.toBeNull();
    expect(await runtime.blockResults('dataview', page, '')).toBeNull();
  });
});

describe('index.changed', () => {
  it('is told only where the plugin can read a page that changed, and keeps the index followed while heard', async () => {
    let following = 0;
    const heard: Record<string, string[][]> = { tables: [], blind: [] };
    const stops: (() => void)[] = [];
    const listener = (id: string) => ({
      id,
      access: 'read' as const,
      activate: (host: AppHost) => {
        stops.push(
          host.events.on('index.changed', ({ spaceIds }) => {
            heard[id]?.push(spaceIds);
          }),
        );
      },
    });
    const { runtime, session } = await testRuntime([listener('tables'), listener('blind')], {
      watchIndex: () => {
        following += 1;
        return () => (following -= 1);
      },
    });
    await runtime.setAccess({ id: 'tables', library: true }, [
      { spaceId: 's', folderId: 'f', access: 'read' },
      { spaceId: 'u', folderId: null, access: 'read' },
    ]);
    await runtime.setAccess({ id: 'blind', library: true }, [
      { spaceId: 'elsewhere', folderId: null, access: 'read' },
    ]);
    expect(following).toBe(2);

    runtime.indexChanged([
      { spaceId: 's', folderIds: ['top', 'f'] },
      { spaceId: 's', folderIds: ['g'] },
      { spaceId: 't', folderIds: [] },
    ]);
    // Outside its folder: nothing.
    runtime.indexChanged([{ spaceId: 's', folderIds: ['g'] }]);
    await expect.poll(() => heard['tables']).toEqual([['s']]);
    expect(heard['blind']).toEqual([]);

    // Waiting together, told as one.
    runtime.indexChanged([{ spaceId: 'u', folderIds: [] }]);
    runtime.indexChanged([{ spaceId: 's', folderIds: ['f'] }]);
    runtime.indexChanged([{ spaceId: 'u', folderIds: ['x'] }]);
    await expect.poll(() => heard['tables']).toEqual([['s'], ['u'], ['s', 'u']]);

    stops[0]?.();
    expect(following).toBe(1);
    session.lock();
    expect(following).toBe(0);
  });
});
