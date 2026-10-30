import type {
  ClientContext,
  copyOperations,
  PageId,
  SpaceId,
  spaceOperations,
  UnlockedVault,
} from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  ownerToConfirmQuery,
  sharedWithMeQuery,
  spacesQuery,
  treeQuery,
} from '../src/data/queries.ts';
import { MoveDialog, type Moving } from '../src/page/move-dialog.tsx';
import type { Tree } from '../src/sharing/names.ts';
import { vaultStore } from '../src/vault/store.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Preview = copyOperations.CopyPreview;
type Made = copyOperations.MadeCopy;
type Progress = copyOperations.CopyProgress;

// The copy worked out and made, in place of a server: each test sets them.
const fake = vi.hoisted(() => ({
  preview: (_copyId: string): Preview => {
    throw new Error('No preview');
  },
  make: async (_preview: Preview, _onProgress: (progress: Progress) => void): Promise<Made> => {
    throw new Error('No copy');
  },
  events: [] as string[],
}));
vi.mock('@wikistow/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wikistow/client')>();
  let copies = 0;
  return {
    ...actual,
    copyOperations: {
      ...actual.copyOperations,
      previewCopy: async () => fake.preview(`copy-${++copies}`),
      makeCopy: (_ctx: unknown, preview: Preview, options: { onProgress: (p: Progress) => void }) =>
        fake.make(preview, options.onProgress),
    },
  };
});
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => async () => void fake.events.push('navigated'),
}));

// Nothing else here reaches a server: a query not answered from the cache
// fails as a dropped connection would.
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
const space = (id: SpaceId, name: string) =>
  ({
    id,
    kind: 'shared',
    role: 'owner',
    canPublish: true,
    permissionVersion: 1,
    metadata: named(name),
  }) as unknown as Spaces[number];
const treeOf = (name: string) =>
  ({
    space: { role: 'owner', canPublish: true, metadata: named(name) },
    shares: [],
    folders: [],
    pages: [{ id: BEANS, parentId: null }],
  }) as unknown as Tree;

const PERSONAL = 'personal-space' as SpaceId;
const WORK = 'work-space' as SpaceId;
const BEANS = 'bean-plan-page' as PageId;

const previewOf = (copyId: string, more: Partial<Preview> = {}): Preview => ({
  kind: 'copy',
  copyId,
  source: { spaceId: PERSONAL, nodeId: BEANS, kind: 'page', permissionVersion: 1 },
  destination: { spaceId: WORK, parentId: null, permissionVersion: 1, region: 'space' as never },
  bringsPublished: true,
  nodes: [
    {
      sourceId: BEANS,
      nodeId: 'bean-copy' as PageId,
      kind: 'page',
      parentId: null,
      name: 'Bean plan',
    },
  ],
  audience: null,
  losses: [],
  unpublished: [],
  links: [],
  inbound: [],
  ends: null,
  ...more,
});

// Queries answer, and their answers render, a task later than an act sees.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

let cleanup = () => {};
afterEach(() => {
  cleanup();
  fake.events = [];
});

// Open the dialog on Bean plan, choose the top of Work, and go on to confirm.
async function confirmInWork(action: 'move' | 'copy') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  queryClient.setQueryData(spacesQuery(ctx).queryKey, [
    space(PERSONAL, 'Personal'),
    space(WORK, 'Work'),
  ]);
  queryClient.setQueryData(sharedWithMeQuery(ctx).queryKey, []);
  for (const [spaceId, name] of [
    [PERSONAL, 'Personal'],
    [WORK, 'Work'],
  ] as const) {
    queryClient.setQueryData(treeQuery(ctx, spaceId).queryKey, treeOf(name));
    queryClient.setQueryData(ownerToConfirmQuery(ctx, spaceId).queryKey, null);
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = (moving: Moving | null) =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <MoveDialog
          spaceId={PERSONAL}
          moving={moving}
          // The native dialog says it closed again a task later.
          onOpenChange={(open) => {
            if (open || !moving) return;
            fake.events.push('closed');
            render(null);
          }}
        />
      </QueryClientProvider>,
    );
  await act(async () => render({ id: BEANS, kind: 'page', name: 'Bean plan', action }));
  await settle();
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  await act(async () => {
    picker('Space').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  await act(async () => {
    const options = document.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    [...options].find((o) => o.textContent === 'Work')?.click();
  });
  await act(async () => button('Next').click());
  await settle();
}

const picker = (label: string) => {
  const found = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
  const element = document.getElementById(found?.htmlFor ?? '');
  if (!(element instanceof HTMLButtonElement)) throw new Error(`No ${label} list`);
  return element;
};
const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === name,
  );
  if (!found) throw new Error(`No ${name} button`);
  return found;
};
const linksNote = () =>
  document.querySelector('[aria-label="Links that won’t work there"] p:last-child')?.textContent;

it('closes before it opens the copy, so the dialog isn’t shown for the space it went to', async () => {
  fake.preview = (copyId) => previewOf(copyId);
  fake.make = async () => ({ spaceId: WORK, nodeId: 'bean-copy' as PageId, copies: new Map() });
  await confirmInWork('copy');

  await act(async () => button('Copy').click());
  await settle();
  expect(fake.events).toEqual(['closed', 'navigated']);
});

it('stops only while it sends, then moves focus on from the buttons that go', async () => {
  fake.preview = (copyId) => previewOf(copyId);
  let progress: (p: Progress) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  fake.make = (_preview, onProgress) => {
    progress = onProgress;
    return new Promise((_, reject) => (fail = reject));
  };
  await confirmInWork('copy');

  await act(async () => {
    button('Copy').focus();
    button('Copy').click();
  });
  expect(button('Stop').disabled).toBe(false);
  await act(async () => progress({ stage: 'finishing', sent: 1, total: 1 }));
  expect(button('Stop').disabled).toBe(true);

  await act(async () => fail(new ApiError(429, 'rate-limited', 'Slow down')));
  await settle();
  expect(document.body.textContent).toContain(
    'The server is busy, so nothing was copied. Wait a moment, then look at it again.',
  );
  expect(document.activeElement).toBe(button('Look again'));

  await act(async () => button('Look again').click());
  await settle();
  expect(() => button('Look again')).toThrow();
  expect(document.activeElement).toBe(button('Copy'));
  expect(button('Copy').disabled).toBe(false);
});

it('says wikilinks find a page by title there, and address links in a move stop working', async () => {
  const wikilink = { kind: 'wikilink', page: 'pantry', text: 'Pantry', count: 1 } as const;
  const address = { kind: 'page-link', page: `${PERSONAL}/x`, text: 'Soup', count: 2 } as const;
  const TITLE = 'Wikilinks to pages that don’t go with it each find a page with the same title';
  const STOPS = 'Links to the address of a page or folder the move deletes';

  fake.preview = (copyId) => previewOf(copyId, { kind: 'move', links: [address] });
  await confirmInWork('move');
  expect(linksNote()).toContain(STOPS);
  expect(linksNote()).not.toContain(TITLE);
  cleanup();

  fake.preview = (copyId) => previewOf(copyId, { links: [wikilink] });
  await confirmInWork('copy');
  expect(linksNote()).toContain(TITLE);
  expect(linksNote()).not.toContain(STOPS);
});
