import { type ClientContext, type PageId, type SpaceId } from '@wikistow/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { Markdown } from '../src/page/markdown.tsx';
import { ReadingChanges } from '../src/page/reading-changes.tsx';
import {
  applyChanges,
  type ReadingChange,
  type ReadingRights,
} from '../src/page/reading-changes-model.ts';

// A page's task checkboxes in the reader (#212): ticked where the page can
// change while it's read, each tick queued and shown at once; disabled
// anywhere else.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PAGE = `---
title: Shopping
---
- [ ] milk
- [x] bread
  - [ ] crumbs *fine*

<ul><li class="task-list-item"><input type="checkbox"> mine</li></ul>
`;

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

/**
 * The reader's body of `source`, with `rights` to change it while it's
 * read, or none; each change is queued in `changes` and made in what's
 * shown, as the page's queue does.
 */
async function render(source: string, rights: ReadingRights | null) {
  const changes: ReadingChange[] = [];
  function Reading() {
    const [queued, setQueued] = useState<ReadingChange[]>([]);
    const markdown = applyChanges(source, queued).markdown;
    const body = (
      <Markdown
        source={markdown}
        attachments={{
          ctx: {} as ClientContext,
          page: { spaceId: 's-home' as SpaceId, pageId: 'p-self' as PageId },
          audience: 'published',
          attachments: [],
        }}
        pages={[]}
        links={new Map()}
        editing={null}
      />
    );
    if (!rights) return body;
    const change = (made: ReadingChange) => {
      changes.push(made);
      setQueued((before) => [...before, made]);
    };
    return <ReadingChanges value={{ markdown, rights, change }}>{body}</ReadingChanges>;
  }
  const node: ReactNode = <Reading />;
  const rootRoute = createRootRoute({ component: () => node });
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory(),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
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
  await expect.poll(() => container.querySelector('.page-body li')).not.toBeNull();
  const box = (label: string) => {
    const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (!found) throw new Error(`No checkbox “${label}”`);
    return found;
  };
  return { container, changes, box };
}

describe('a task’s checkbox in the reader', () => {
  it('ticks where the page can change, queuing the change and showing it at once', async () => {
    const { box, changes } = await render(PAGE, { allowed: true });
    expect([box('milk').disabled, box('bread').disabled, box('crumbs fine').disabled]).toEqual([
      false,
      false,
      false,
    ]);
    expect(box('bread').checked).toBe(true);
    box('milk').focus();
    expect(document.activeElement).toBe(box('milk'));
    await act(async () => box('milk').click());
    await act(async () => box('bread').click());
    expect(changes).toEqual([
      { kind: 'task', offset: PAGE.indexOf('- [ ] milk'), line: 'milk', checked: true },
      { kind: 'task', offset: PAGE.indexOf('- [x] bread'), line: 'bread', checked: false },
    ]);
    // Shown as queued, whether or not the body has been read again yet.
    expect([box('milk').checked, box('bread').checked]).toEqual([true, false]);
    await act(async () => box('crumbs fine').click());
    expect(changes.at(-1)).toEqual({
      kind: 'task',
      offset: PAGE.indexOf('- [ ] crumbs'),
      line: 'crumbs *fine*',
      checked: true,
    });
    expect(box('crumbs fine').checked).toBe(true);
  });

  it('stays disabled where this person can’t change the page, with a hint when there’s a reason', async () => {
    const hinted = await render(PAGE, {
      allowed: false,
      hint: 'Open the draft to tick this: it has unpublished changes',
    });
    expect(hinted.box('milk').disabled).toBe(true);
    expect(hinted.box('milk').getAttribute('data-hint')).toBe(
      'Open the draft to tick this: it has unpublished changes',
    );
    await act(async () => hinted.box('milk').click());
    expect(hinted.changes).toEqual([]);

    const reader = await render(PAGE, { allowed: false, hint: null });
    expect(reader.box('milk').disabled).toBe(true);
    expect(reader.box('milk').hasAttribute('data-hint')).toBe(false);
  });

  it('is the reader’s disabled box anywhere nothing can change, and for the page’s own HTML', async () => {
    const { container, box } = await render(PAGE, null);
    expect(box('milk').disabled).toBe(true);
    const boxes = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect(boxes.map((input) => input.disabled)).toEqual([true, true, true, true]);
    const own = await render(PAGE, { allowed: true });
    const mine = [...own.container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].at(
      -1,
    );
    expect(mine?.disabled).toBe(true);
    expect(mine?.hasAttribute('data-task')).toBe(false);
  });
});
