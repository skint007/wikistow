import type {
  ClientContext,
  FolderId,
  PageId,
  RevisionId,
  SpaceId,
  spaceOperations,
  UnlockedVault,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import { PickForm } from '../src/agents/pick-form.tsx';
import {
  ownerToConfirmQuery,
  sharedWithMeQuery,
  spacesQuery,
  treeQuery,
} from '../src/data/queries.ts';
import { MoveDialog } from '../src/page/move-dialog.tsx';
import { PublishDialog } from '../src/page/publish-dialog.tsx';
import type { Tree } from '../src/sharing/names.ts';
import { vaultStore } from '../src/vault/store.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Nothing here reaches a server: every query is answered from the cache, and
// one that isn't fails as a dropped connection would.
const ctx = {
  api: {
    call: async () => {
      throw new ApiError(0, 'network', 'No answer');
    },
  },
} as unknown as ClientContext;
vaultStore.unlock(ctx, {} as UnlockedVault);

type Spaces = Awaited<ReturnType<typeof spaceOperations.loadSpaces>>;

const named = (name: string) => ({ opened: { kind: 'current', metadata: { name } } });
// A space as `loadSpaces` lists it, owned by this person unless `role` says otherwise.
const space = (id: SpaceId, name: string, role = 'owner') =>
  ({
    id,
    kind: 'shared',
    role,
    canPublish: true,
    permissionVersion: 1,
    metadata: named(name),
  }) as unknown as Spaces[number];
// A space's tree as `loadTree` gives it, with only what the pickers read:
// its folders at the top, unless `under` puts one in another.
const treeOf = (
  name: string,
  folders: Record<string, FolderId>,
  { role = 'owner', under = {} }: { role?: string; under?: Record<string, FolderId> } = {},
) =>
  ({
    space: { role, canPublish: true, metadata: named(name) },
    shares: [],
    folders: Object.entries(folders).map(([folder, id]) => ({
      id,
      parentId: under[folder] ?? null,
      metadata: named(folder),
    })),
    pages: [{ id: BEANS, parentId: null }],
  }) as unknown as Tree;

const PERSONAL = 'personal-space' as SpaceId;
const WORK = 'work-space' as SpaceId;
const ARCHIVE = 'archive-space' as SpaceId;
const KITCHEN = 'kitchen-folder' as FolderId;
const GARDEN = 'garden-folder' as FolderId;
const BEANS = 'bean-plan-page' as PageId;

let queryClient: QueryClient;
let cleanup = () => {};
afterEach(() => cleanup());

// Mount `ui` on a cache holding these spaces and trees, each confirmed as owned.
async function mount(ui: ReactNode, spaces: Spaces, trees: Record<SpaceId, Tree>) {
  // As the app's own, it doesn't retry by itself (router.tsx).
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(spacesQuery(ctx).queryKey, spaces);
  queryClient.setQueryData(sharedWithMeQuery(ctx).queryKey, []);
  for (const [spaceId, tree] of Object.entries(trees)) {
    queryClient.setQueryData(treeQuery(ctx, spaceId as SpaceId).queryKey, tree);
    queryClient.setQueryData(ownerToConfirmQuery(ctx, spaceId as SpaceId).queryKey, null);
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>),
  );
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
}

/** A refetch that comes back with `data`. */
const refetched = (queryKey: readonly unknown[], data: unknown) =>
  act(async () => void queryClient.setQueryData(queryKey, data));

// A picker (components/ui/picker), by its label.
const field = (label: string) => {
  const found = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
  const picker = document.getElementById(found?.htmlFor ?? '');
  if (!(picker instanceof HTMLButtonElement)) throw new Error(`No ${label} list`);
  return picker;
};
const shown = (label: string) => field(label).textContent;
const choose = async (label: string, text: string) => {
  await act(async () => {
    field(label).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await act(async () => {
    const options = document.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    const option = [...options].find((o) => o.textContent === text);
    if (!option) throw new Error(`No ${text} in ${label}`);
    option.click();
  });
};

const GONE = 'The folder you picked is no longer available. Choose again.';
const SPACE_GONE = 'The space you picked is no longer available. Choose again.';
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No ${name} button`);
  return found;
};

it('asks again, with nothing picked, when the folder picked for an agent goes', async () => {
  const kitchen = treeOf('Personal', { Kitchen: KITCHEN, Garden: GARDEN });
  await mount(<PickForm onPick={() => {}} />, [space(PERSONAL, 'Personal')], {
    [PERSONAL]: kitchen,
  });
  await choose('Folder', 'Personal › Kitchen — not shared yet');
  await choose('Access', 'Editor + publish');

  // Deleted in another window: the whole space, first in the list, doesn't stand in for it.
  await refetched(treeQuery(ctx, PERSONAL).queryKey, treeOf('Personal', { Garden: GARDEN }));
  expect(alerts()).toEqual([GONE]);
  expect(shown('Folder')).toBe('Choose a folder');
  expect(shown('Access')).toBe('Editor + publish');
  expect(button('Add').disabled).toBe(true);

  await choose('Folder', 'Personal › Garden — not shared yet');
  expect(alerts()).toEqual([]);
  expect(button('Add').disabled).toBe(false);
});

it('keeps an agent pick’s space once shown, and asks again when it goes', async () => {
  await mount(<PickForm onPick={() => {}} />, [space(PERSONAL, 'Personal')], {
    [PERSONAL]: treeOf('Personal', { Kitchen: KITCHEN }),
    [ARCHIVE]: treeOf('Archive', {}),
  });
  await choose('Folder', 'Personal › Kitchen — not shared yet');
  await choose('Access', 'Editor + publish');

  // Made in another window, it comes first in the list but isn't picked.
  await refetched(spacesQuery(ctx).queryKey, [
    space(ARCHIVE, 'Archive'),
    space(PERSONAL, 'Personal'),
  ]);
  expect(shown('Space')).toBe('Personal');
  expect(shown('Folder')).toBe('Personal › Kitchen — not shared yet');

  await refetched(spacesQuery(ctx).queryKey, [space(ARCHIVE, 'Archive')]);
  expect(alerts()).toEqual([SPACE_GONE]);
  expect(shown('Space')).toBe('Choose a space');
  expect(() => button('Add')).toThrow();

  // Listed again, it comes back with the folder and access picked, not the whole space.
  await refetched(spacesQuery(ctx).queryKey, [
    space(ARCHIVE, 'Archive'),
    space(PERSONAL, 'Personal'),
  ]);
  expect(alerts()).toEqual([]);
  expect(shown('Folder')).toBe('Personal › Kitchen — not shared yet');
  expect(shown('Access')).toBe('Editor + publish');

  await refetched(spacesQuery(ctx).queryKey, [space(ARCHIVE, 'Archive')]);
  await choose('Space', 'Archive');
  expect(alerts()).toEqual([]);
  expect(button('Add').disabled).toBe(false);
});

it('keeps the space picked to publish to, and asks again when it goes', async () => {
  await mount(
    <PublishDialog
      page={{ spaceId: PERSONAL, pageId: BEANS }}
      title="Bean plan"
      version={{ revisionId: 'bean-revision' as RevisionId, audience: 'published' }}
      open
      onOpenChange={() => {}}
    />,
    [space(PERSONAL, 'Personal'), space(WORK, 'Work')],
    {
      [PERSONAL]: treeOf('Personal', {}),
      [WORK]: treeOf('Work', {}),
      [ARCHIVE]: treeOf('Archive', {}),
    },
  );
  const listed = (...spaces: Spaces) =>
    refetched(spacesQuery(ctx).queryKey, [space(PERSONAL, 'Personal'), ...spaces]);
  // Shown first, it is kept when a space listed before it is added.
  await listed(space(ARCHIVE, 'Archive'), space(WORK, 'Work'));
  expect(shown('Space')).toBe('Work');
  expect(shown('Folder')).toBe('Top of Work');
  await choose('Folder', 'Top of Work');

  // The top of Archive doesn't stand in for the top of Work.
  await listed(space(ARCHIVE, 'Archive'));
  expect(alerts()).toEqual([SPACE_GONE]);
  expect(shown('Space')).toBe('Choose a space');
  expect(button('Next').disabled).toBe(true);

  await choose('Space', 'Archive');
  expect(alerts()).toEqual([]);
  expect(shown('Folder')).toBe('Top of Archive');
  expect(button('Next').disabled).toBe(false);
});

// The options a picker offers, by its label.
const options = async (label: string) => {
  await act(async () => {
    field(label).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  const listed = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map(
    (o) => o.textContent,
  );
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
  });
  return listed;
};
const title = () => document.querySelector('[data-slot="dialog-title"]')?.textContent;

it('moves within the space, or for its owner into another, from one dialog', async () => {
  await mount(
    <MoveDialog
      spaceId={PERSONAL}
      moving={{ id: BEANS, kind: 'page', name: 'Bean plan' }}
      onOpenChange={() => {}}
    />,
    [space(PERSONAL, 'Personal'), space(WORK, 'Work')],
    {
      [PERSONAL]: treeOf('Personal', { Kitchen: KITCHEN, Garden: GARDEN }),
      [WORK]: treeOf('Work', {}),
    },
  );
  expect(title()).toBe('Move “Bean plan”');
  expect(shown('Space')).toBe('Personal (this space)');
  // Not where it is already.
  expect(await options('Folder')).toEqual(['Garden', 'Kitchen']);

  await choose('Space', 'Work');
  expect(await options('Folder')).toEqual(['Top of Work']);
  expect(button('Next').disabled).toBe(false);
});

it('tells an editor who isn’t an owner that only owners move into another space', async () => {
  await mount(
    <MoveDialog
      spaceId={PERSONAL}
      moving={{ id: BEANS, kind: 'page', name: 'Bean plan' }}
      onOpenChange={() => {}}
    />,
    [space(PERSONAL, 'Family', 'editor'), space(WORK, 'Work')],
    {
      [PERSONAL]: treeOf('Family', { Kitchen: KITCHEN }, { role: 'editor' }),
      [WORK]: treeOf('Work', {}),
    },
  );
  expect(await options('Space')).toEqual(['Family (this space)']);
  expect(document.body.textContent).toContain(
    'Only an owner of this space can move things into another space. You can copy it there instead.',
  );

  await act(async () => button('Copy instead').click());
  expect(title()).toBe('Copy “Bean plan”');
  expect(await options('Space')).toEqual(['Family (this space)', 'Work']);
  expect(document.body.textContent).not.toContain('Only an owner');
});

it('copies a folder anywhere in its space but inside itself, beside it included', async () => {
  await mount(
    <MoveDialog
      spaceId={PERSONAL}
      moving={{ id: KITCHEN, kind: 'folder', name: 'Kitchen', action: 'copy' }}
      onOpenChange={() => {}}
    />,
    [space(PERSONAL, 'Personal')],
    {
      [PERSONAL]: treeOf(
        'Personal',
        { Kitchen: KITCHEN, Pantry: 'pantry-folder' as FolderId, Garden: GARDEN },
        { under: { Pantry: KITCHEN } },
      ),
    },
  );
  expect(title()).toBe('Copy “Kitchen”');
  expect(await options('Folder')).toEqual(['Top of Personal', 'Garden']);
});
