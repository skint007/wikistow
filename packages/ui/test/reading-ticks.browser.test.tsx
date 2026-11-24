import { splitFrontmatter, type ClientContext, type PageId, type SpaceId } from '@wikistow/client';
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
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { Markdown } from '../src/page/markdown.tsx';
import { pageReader } from '../src/page/page-reader.ts';
import { ReadingChanges } from '../src/page/reading-changes.tsx';
import {
  applyChanges,
  madeIn,
  ShownBodies,
  type ReadingChange,
  type ReadingRights,
} from '../src/page/reading-changes-model.ts';
import { openVault } from './page-view.ts';

// A page's task checkboxes in the reader (#212): ticked where the page can
// change while it's read, each tick queued and shown at once; disabled
// anywhere else.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// Its properties keep their open state in the vault's account.
openVault();

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
  vi.restoreAllMocks();
});

/**
 * The reader's body of `first`, with `rights` to change it while it's
 * read, or none; each change is kept in `changes` as the box made it, and
 * queued and made in what's shown, as the page's queue does, with what it
 * was made in (`madeIn`). `arrive` makes the page's text another, as
 * another tab's publication does; `published` publishes the first `count`
 * changes queued, as a flush does, the rest still queued.
 */
async function render(first: string, rights: ReadingRights | null) {
  const changes: ReadingChange[] = [];
  const queue: ReadingChange[] = [];
  let arrive = (_source: string) => {};
  let flush = (_count: number) => {};
  function Reading() {
    const [source, setSource] = useState(first);
    arrive = setSource;
    const [queued, setQueued] = useState<ReadingChange[]>([]);
    flush = (count) => {
      setSource(applyChanges(source, queued.slice(0, count)).markdown);
      setQueued(queued.slice(count));
    };
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
      const kept = madeIn(made, markdown, source);
      queue.push(kept);
      setQueued((before) => [...before, kept]);
    };
    const [bodies] = useState(() => new ShownBodies());
    bodies.see(source, queued);
    const shownBefore = (drawn: string) => bodies.has(drawn);
    return (
      <ReadingChanges value={{ markdown, rights, change, shownBefore }}>{body}</ReadingChanges>
    );
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
  const shown = (source: string) => act(async () => arrive(source));
  const published = (count: number) => act(async () => flush(count));
  return { container, changes, queue, box, shown, published };
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

  it('ticks on a page that starts with a byte order mark', async () => {
    const { box, changes } = await render('\uFEFF- [ ] milk\n', { allowed: true });
    await act(async () => box('milk').click());
    expect(changes).toEqual([{ kind: 'task', offset: 1, line: 'milk', checked: true }]);
    expect(box('milk').checked).toBe(true);
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

  it('ticks in the text its tree was read from while a newer one waits to be read (#728)', async () => {
    const before = '- [ ] Call\n  Mum\n- [ ] Call\n  Bob\n';
    // Another tab swapped them: the task at the first one's offset is Bob's now.
    const swapped = '- [ ] Call\n  Bob\n- [ ] Call\n  Mum\n';
    const { box, changes, queue, shown, container } = await render(before, { allowed: true });
    // The swapped text's read waits, so the tree shows the one before it.
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const run = pageReader.run.bind(pageReader);
    vi.spyOn(pageReader, 'run').mockImplementation(async (job, input, options) => {
      if (input === swapped) await held;
      return run(job, input, options);
    });
    await shown(swapped);
    expect(box('Call Mum').checked).toBe(false);
    await act(async () => box('Call Mum').click());
    expect(changes).toEqual([
      {
        kind: 'task',
        offset: 0,
        line: 'Call',
        checked: true,
        madeIn: { markdown: before, repeated: true },
      },
    ]);
    // Bob's task, now at that offset, stays as it was, and the tick is left out as #703 says.
    const made = applyChanges(swapped, queue);
    expect(made.markdown).toBe(swapped);
    expect(made.dropped.map(({ reason }) => reason)).toEqual([
      'The task “Call” is on the page more than once, and the page changed since it was ticked.',
    ]);
    await act(async () => release());
    await expect
      .poll(() => container.querySelector('input[type=checkbox]')?.getAttribute('aria-label'))
      .toBe('Call Bob');
    expect([box('Call Bob').checked, box('Call Mum').checked]).toEqual([false, false]);
  });

  it('ticks in the text its tree was read from when the newer one differs only in what is ticked', async () => {
    // The sections differ only in their Notes' boxes: swapped, the text differs only in boxes too.
    const before = '## A\n- [ ] Call\n- [x] Notes\n## A\n- [ ] Call\n- [ ] Notes\n';
    const swapped = '## A\n- [ ] Call\n- [ ] Notes\n## A\n- [ ] Call\n- [x] Notes\n';
    const { container, changes, queue, shown } = await render(before, { allowed: true });
    hold((input) => input === swapped);
    await shown(swapped);
    const first = container.querySelector<HTMLInputElement>('input[aria-label="Call"]');
    await act(async () => first?.click());
    expect(changes.map((change) => change.kind === 'task' && change.madeIn)).toEqual([
      { markdown: before, repeated: true },
    ]);
    expect(applyChanges(swapped, queue).markdown).toBe(swapped);
  });

  it('ticks in the text shown once its own ticks are published while a read of them waits', async () => {
    const page = '- [ ] Call\n  Mum\n- [ ] Call\n  Bob\n- [ ] Call\n  Ann\n';
    const { box, changes, queue, published } = await render(page, { allowed: true });
    hold(() => true);
    await act(async () => box('Call Mum').click());
    await act(async () => box('Call Bob').click());
    // Mum's tick is published, Bob's still waits, and the tree is still the page's before both.
    await published(1);
    await act(async () => box('Call Ann').click());
    expect(changes.map((change) => change.kind === 'task' && change.madeIn)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect([box('Call Mum').checked, box('Call Bob').checked, box('Call Ann').checked]).toEqual([
      true,
      true,
      true,
    ]);
    expect(applyChanges(page, queue)).toEqual({
      markdown: '- [x] Call\n  Mum\n- [x] Call\n  Bob\n- [x] Call\n  Ann\n',
      dropped: [],
    });
  });

  it('ticks in the text shown while a read of it with only boxes ticked since waits', async () => {
    const page = '- [ ] Call\n  Mum\n- [ ] Call\n  Bob\n';
    const { box, changes, queue } = await render(page, { allowed: true });
    hold(() => true);
    await act(async () => box('Call Mum').click());
    // Bob's is ticked before Mum's tick is read: it's made in the text with Mum's ticked.
    await act(async () => box('Call Bob').click());
    // Each made in the text shown, as the tree's tasks are where it has them.
    expect(changes.map((change) => change.kind === 'task' && change.madeIn)).toEqual([
      undefined,
      undefined,
    ]);
    expect([box('Call Mum').checked, box('Call Bob').checked]).toEqual([true, true]);
    expect(applyChanges(page, queue)).toEqual({
      markdown: '- [x] Call\n  Mum\n- [x] Call\n  Bob\n',
      dropped: [],
    });
  });

  it('shows a tick at once, and undoes it, while a newer text that moves no task waits to be read', async () => {
    const before = '- [ ] milk\n';
    const added = '- [ ] milk\n\nAnd more.\n';
    const { box, queue, shown } = await render(before, { allowed: true });
    hold((input) => input !== before);
    await shown(added);
    await act(async () => box('milk').click());
    expect(box('milk').checked).toBe(true);
    await act(async () => box('milk').click());
    expect(box('milk').checked).toBe(false);
    expect(applyChanges(added, queue)).toEqual({ markdown: added, dropped: [] });
  });

  it('can’t be ticked while a newer text waits whose body no longer splits as it did', async () => {
    // Without its frontmatter, the old body's first lines would read as frontmatter.
    const before = '---\ntitle: Calls\n---\n---\n- [ ] Call Mum\n---\n# B\n- [ ] Call Bob\n';
    const after = '- [ ] Call Mum\n---\n# B\n- [ ] Call Bob\n';
    const { box, changes, shown } = await render(before, { allowed: true });
    hold((input) => input === splitBody(after));
    await shown(after);
    expect(box('Call Mum').disabled).toBe(true);
    await act(async () => box('Call Mum').click());
    expect(changes).toEqual([]);
  });
});

/** Every read of a body `held` says waits, until the test ends. */
function hold(held: (input: unknown) => boolean) {
  const run = pageReader.run.bind(pageReader);
  vi.spyOn(pageReader, 'run').mockImplementation((job, input, options) =>
    held(input) ? new Promise(() => {}) : run(job, input, options),
  );
}

const splitBody = (markdown: string) => splitFrontmatter(markdown).body;
