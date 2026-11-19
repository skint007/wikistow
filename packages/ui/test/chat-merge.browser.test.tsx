// Merge… for an approved chat edit that overlaps the live page (ADR 0015
// decision 8, #523): the page's merge view in a dialog, naming the
// assistant's side and the live page, and handing back what the person
// settled, or nothing when they cancel; and the chat's approvals waiting on it.
import {
  newPayload,
  pageMerge,
  type agentTools,
  type ClientContext,
  type IdentityId,
  type PageId,
  type PagePayload,
  type RevisionId,
  type SpaceId,
  type UnlockedVault,
} from '@wikistow/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, it, vi } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser/context';
import { ChatColumn } from '../src/ai/chat-column.tsx';
import { ChatMerge, ChatMerges } from '../src/ai/chat-merge.tsx';
import { AgentChat, chatStore, type Merging } from '../src/ai/chat.ts';
import { vaultStore } from '../src/vault/store.ts';

// The agent's session, its tools and its saves, in place of a server: the
// chat proposes through `propose`, and an approved edit always overlaps.
const fake = vi.hoisted(() => ({
  propose: null as ((change: never) => number) | null,
  applied: [] as (string | null)[],
  merge: null as unknown as agentTools.ProposalMerge,
}));
vi.mock('@wikistow/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wikistow/client')>();
  const agent = { agentId: 'helper', name: 'Helper' };
  return {
    ...actual,
    listAppAgents: () => [agent],
    closeSession: () => {},
    appAgentOperations: { ...actual.appAgentOperations, openAppAgent: async () => ({}) },
    agentTools: {
      ...actual.agentTools,
      listScope: async () => [
        { spaceId: 'space', folderId: null, name: 'Notes', access: 'editor' },
      ],
      agentTools: (options: { propose: (change: never) => number }) => {
        fake.propose = options.propose;
        return [];
      },
      applyProposal: async (
        _ctx: unknown,
        _proposal: unknown,
        options: agentTools.ApplyOptions = {},
      ): Promise<agentTools.Applied> => {
        const settled = (await options.merge?.(fake.merge)) ?? null;
        fake.applied.push(settled?.markdown ?? null);
        return settled
          ? {
              status: 'done',
              spaceId: 'space' as SpaceId,
              pageId: 'page' as PageId,
              folderId: null,
            }
          : { status: 'cancelled' };
      },
    },
  };
});
vi.mock('../src/ai/chat-panel.tsx', () => ({ ChatPanel: () => <p>The chat panel</p> }));
vi.mock('../src/ai/session.ts', () => ({
  aiStatusQuery: { queryKey: ['ai-status'] },
  // A reply that runs until stopped, so the agent's tools may propose.
  openAiSession: () => ({
    state: () => ({ status: 'running', messages: [] }),
    subscribe: () => () => {},
    stop: () => {},
    close: () => {},
    send: async () => {},
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vaultStore.unlock({} as ClientContext, {} as UnlockedVault);

const draft = (markdown: string) => newPayload({ title: 'Plan', markdown });

function merging(live: boolean): Merging {
  return {
    proposalId: 1,
    ask: 1,
    opened: {
      merge: pageMerge.mergePayloads(
        draft('One.\n\nTwo.\n'),
        draft('One, edited.\n\nTwo.\n'),
        draft('One, typed live.\n\nTwo, too.\n'),
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
afterAll(() => page.viewport(414, 896));
afterEach(() => {
  cleanup();
  cleanup = () => {};
  chatStore.end();
  fake.applied = [];
});

async function render(node: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
  );
  await settle();
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
}

async function mount(onSettle: (payload: PagePayload | null) => void) {
  await render(<ChatMerge merging={merging(true)} agentName="Helper" onSettle={onSettle} />);
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

/** A chat with Helper, its two edits waiting, and Merge… on screen when asked for. */
async function chatWithEdits() {
  fake.merge = merging(true).opened;
  const chat = new AgentChat(
    { contacts: { book: { payloads: [] } } } as unknown as ClientContext,
    { agentId: 'helper' as IdentityId, name: 'Helper' },
    { onChanged: () => {} },
  );
  chatStore.start(chat);
  await vi.waitFor(() => expect(chat.state().phase).toBe('ready'));
  for (const markdown of ['One, edited.\n\nTwo.\n', 'One.\n\nTwo, edited.\n']) {
    fake.propose?.({
      kind: 'edit-page',
      summary: 'Edit',
      spaceId: 'space',
      pageId: 'page',
      base: 'base',
      shareId: null,
      before: { title: 'Plan', markdown: 'One.\n\nTwo.\n' },
      title: 'Plan',
      markdown,
    } as never);
  }
  await render(<ChatMerges />);
  const states = () => chat.state().proposals.map((item) => item.state);
  return { chat, states };
}

const shown = () => document.querySelector('dialog[open]');

it('waits on Merge…, and a cancel leaves it and the rest of the batch to approve again', async () => {
  const { chat, states } = await chatWithEdits();
  let approving!: Promise<void>;
  await act(async () => {
    approving = chat.approve([1, 2], async () => null);
  });
  await settle();
  expect(states()).toEqual(['merging', 'pending']);
  const dialog = shown();
  if (!dialog) throw new Error('no Merge…');
  await act(async () => button(dialog, 'Cancel').click());
  await act(() => approving);
  expect(fake.applied).toEqual([null]);
  expect(states()).toEqual(['pending', 'pending']);
  expect(chat.state()).toMatchObject({ applying: false, merging: null });
  expect(shown()).toBeNull();

  await act(async () => {
    approving = chat.approve([1], async () => null);
  });
  await settle();
  const again = shown();
  if (!again) throw new Error('no Merge…');
  await act(async () => button(again, 'Use Helper’s').click());
  await act(async () => button(again, 'Review merged draft').click());
  await act(async () => button(again, 'Save merged draft').click());
  await act(() => approving);
  expect(fake.applied).toEqual([null, 'One, edited.\n\nTwo, too.\n']);
  expect(states()).toEqual(['done', 'pending']);
});

it('cancels Merge… once nothing on screen shows it, and doesn’t open one then', async () => {
  const { chat, states } = await chatWithEdits();
  let approving!: Promise<void>;
  await act(async () => {
    approving = chat.approve([1], async () => null);
  });
  await settle();
  expect(states()).toEqual(['merging', 'pending']);
  cleanup();
  cleanup = () => {};
  await act(() => approving);
  expect(states()).toEqual(['pending', 'pending']);
  await act(() => chat.approve([2], async () => null));
  expect(fake.applied).toEqual([null, null]);
  expect(states()).toEqual(['pending', 'pending']);
});

it('keeps Merge… on top when the chat would become a sheet, and opens the sheet after', async () => {
  await page.viewport(1300, 800);
  const { chat } = await chatWithEdits();
  // ChatColumn in place of the ChatMerges chatWithEdits rendered, which goes once this one holds Merge….
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatColumn />
      </QueryClientProvider>,
    ),
  );
  cleanup();
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() => chatStore.setOpen(true));
  expect(document.body.textContent).toContain('The chat panel');
  let approving!: Promise<void>;
  await act(async () => {
    approving = chat.approve([1], async () => null);
  });
  await settle();
  const top = () =>
    document
      .elementFromPoint(innerWidth / 2, innerHeight / 2)
      ?.closest('dialog')
      ?.querySelector('h2')?.textContent;
  expect(top()).toBe('Merge Helper’s edit');

  // Narrower than the column: the sheet waits for Merge…, rather than opening over it.
  await page.viewport(800, 800);
  await settle();
  expect(top()).toBe('Merge Helper’s edit');
  expect(document.body.textContent).not.toContain('The chat panel');
  const dialog = shown();
  if (!dialog) throw new Error('no Merge…');
  await act(async () => button(dialog, 'Cancel').click());
  await act(() => approving);
  await settle();
  expect(top()).toBe('Assistant');
  expect(document.body.textContent).toContain('The chat panel');
});
