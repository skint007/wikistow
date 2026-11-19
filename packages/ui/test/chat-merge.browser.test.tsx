// Merge… for an approved chat edit that overlaps the live page (ADR 0015
// decision 8, #523): the page's merge view in a dialog, naming the
// assistant's side and the live page, and handing back what the person
// settled, or nothing when they cancel.
import {
  newPayload,
  pageMerge,
  type ClientContext,
  type PageId,
  type PagePayload,
  type RevisionId,
  type SpaceId,
  type UnlockedVault,
} from '@wikistow/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vite-plus/test';
import { ChatMerge } from '../src/ai/chat-merge.tsx';
import type { Merging } from '../src/ai/chat.ts';
import { vaultStore } from '../src/vault/store.ts';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vaultStore.unlock({} as ClientContext, {} as UnlockedVault);

const page = (markdown: string) => newPayload({ title: 'Plan', markdown });

function merging(live: boolean): Merging {
  return {
    proposalId: 1,
    opened: {
      merge: pageMerge.mergePayloads(
        page('One.\n\nTwo.\n'),
        page('One, edited.\n\nTwo.\n'),
        page('One, typed live.\n\nTwo, too.\n'),
      ),
      page: { spaceId: 'space' as SpaceId, pageId: 'page' as PageId },
      head: 'head' as RevisionId,
      theirs: { authorId: 'someone', live },
      attachments: [],
    },
  };
}

// The merge view's words come from a query, which answers a task later than an act sees.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

let cleanup = () => {};
afterEach(() => cleanup());

async function mount(onSettle: (payload: PagePayload | null) => void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ChatMerge merging={merging(true)} agentName="Helper" onSettle={onSettle} />
      </QueryClientProvider>,
    ),
  );
  await settle();
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  const dialog = document.querySelector('dialog');
  if (!dialog) throw new Error('no dialog');
  return dialog;
}

const button = (within: Element, name: string) => {
  const found = [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

it('merges the assistant’s edit with the live page, and hands back what the person settled', async () => {
  const settled: (PagePayload | null)[] = [];
  const dialog = await mount((payload) => settled.push(payload));
  expect(dialog.open).toBe(true);
  expect(dialog.querySelector('#merge-heading')?.textContent).toBe(
    'Merge Helper’s changes with the live page',
  );
  expect(dialog.textContent).toContain(
    '1 of the live page’s changes combined. Both changed 1 place.',
  );
  const overlap = dialog.querySelector('li[aria-label]');
  if (!overlap) throw new Error('no overlap');
  expect(overlap.textContent).toContain('Helper’s');
  expect(overlap.textContent).toContain('The live page');
  button(overlap, 'Use the live page’s');
  await act(async () => button(overlap, 'Use Helper’s').click());
  await act(async () => button(dialog, 'Review merged draft').click());
  expect(dialog.textContent).toContain('Saving makes these changes to the live page.');
  await act(async () => button(dialog, 'Save merged draft').click());
  expect(settled.map((payload) => payload?.markdown)).toEqual(['One, edited.\n\nTwo, too.\n']);
});

it('saves nothing when the person cancels, or presses Escape', async () => {
  const settled: (PagePayload | null)[] = [];
  let dialog = await mount((payload) => settled.push(payload));
  await act(async () => button(dialog, 'Cancel').click());
  expect(settled).toEqual([null]);
  cleanup();

  dialog = await mount((payload) => settled.push(payload));
  await act(async () => {
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  });
  expect(settled).toEqual([null, null]);
});
