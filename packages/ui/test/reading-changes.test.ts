import { taskItems } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  applyChanges,
  flushChanges,
  flushesUnderway,
  holding,
  inTurn,
  leftOutcome,
  notePublished,
  originOf,
  pageFlushing,
  PUBLIC_LINK_HINT,
  readingNotices,
  ReadingQueue,
  readingRights,
  showing,
  type FlushOperations,
  type Flushed,
  type ReadingChange,
} from '../src/page/reading-changes-model.ts';

const LIST = '---\nservings: 4\n---\n- [ ] milk\n- [ ] bread\n- [x] eggs\n';

/** The change ticking (or not) the task `line` where it is in `markdown`. */
function task(markdown: string, line: string, checked: boolean): ReadingChange {
  const item = taskItems(markdown).find((found) => found.line === line);
  if (!item) throw new Error(`No task “${line}”`);
  return { kind: 'task', offset: item.offset, line, checked };
}

const stale = () => new ApiError(409, 'stale-head', 'Someone saved since you loaded the page');

/**
 * A page's draft and publication in memory: each save or publish a new
 * revision, refused as `stale-head` when its base isn't the head, as the
 * server refuses it. `before` runs ahead of each save, as someone else
 * saving or publishing meanwhile.
 */
function server(markdown: string, { draftChanges = false } = {}) {
  let next = 1;
  const revisions = new Map<string, string>([['d0', markdown]]);
  const state = {
    draftHead: 'd0' as string | null,
    publishedHead: 'p0' as string | null,
    draftChanges,
    published: [] as string[],
    saves: 0,
    publicLink: false,
  };
  let before: (() => void) | null = null;
  const operations: FlushOperations = {
    heads: async () => ({ ...state }),
    openDraft: async (id) => revisions.get(id) ?? '',
    saveDraft: async (basedOn, text) => {
      before?.();
      if (basedOn !== state.draftHead) throw stale();
      state.saves++;
      const id = `d${next++}`;
      revisions.set(id, text);
      state.draftHead = id;
      return id;
    },
    publish: async ({ draftHead, publishedHead }) => {
      if (draftHead !== state.draftHead || publishedHead !== state.publishedHead) throw stale();
      state.publishedHead = `p${next++}`;
      state.published.push(revisions.get(draftHead) ?? '');
      state.draftChanges = false;
      return state.publishedHead;
    },
    publicLink: async () => state.publicLink,
  };
  return {
    state,
    operations,
    draft: () => revisions.get(state.draftHead ?? '') ?? '',
    /** Someone else saves `text` as the draft, before the next save here. */
    savesFirst(text: (draft: string) => string, { publishes = false, times = 1 } = {}) {
      let left = times;
      before = () => {
        if (left-- <= 0) return;
        const id = `d${next++}`;
        revisions.set(id, text(revisions.get(state.draftHead ?? '') ?? ''));
        state.draftHead = id;
        if (publishes) state.publishedHead = `p${next++}`;
        else state.draftChanges = true;
      };
    },
  };
}

describe('who may change a page while reading it', () => {
  const heads = { draftHead: 'd1', publishedHead: 'p1', publishedCount: 1, draftChanges: false };
  const editor = { role: 'editor', canPublish: true } as const;
  const rights = (over: Partial<Parameters<typeof readingRights>[0]>) =>
    readingRights({
      viewer: editor,
      heads,
      view: 'published',
      revision: 'p1',
      publicLink: false,
      ...over,
    });

  it('is an editor who can publish, on the latest publication, its draft without changes', () => {
    expect(rights({})).toEqual({ allowed: true });
    expect(rights({ viewer: { role: 'owner', canPublish: true } })).toEqual({ allowed: true });
  });

  it('is nobody else, with a hint saying why where there is one to give', () => {
    expect(rights({ viewer: { role: 'reader', canPublish: false } })).toEqual({
      allowed: false,
      hint: null,
    });
    expect(rights({ view: 'draft', revision: 'd1' })).toEqual({ allowed: false, hint: null });
    expect(rights({ viewer: { role: 'editor', canPublish: false } })).toEqual({
      allowed: false,
      hint: 'Open the draft to tick this: you can’t publish this page',
    });
    expect(rights({ heads: { ...heads, draftChanges: true } })).toEqual({
      allowed: false,
      hint: 'Open the draft to tick this: it has unpublished changes',
    });
    expect(rights({ revision: 'p0' })).toMatchObject({ allowed: false, hint: /older version/ });
    // Named by the address, it stays that version once a tick publishes.
    expect(rights({ pinned: true })).toEqual({
      allowed: false,
      hint: 'Open the latest version to tick this',
    });
    // A public link a publish would end without asking, or links not yet known.
    expect(rights({ publicLink: true })).toEqual({ allowed: false, hint: PUBLIC_LINK_HINT });
    expect(rights({ publicLink: null })).toEqual({ allowed: false, hint: null });
    expect(rights({ publicLink: true, viewer: { role: 'reader', canPublish: false } })).toEqual({
      allowed: false,
      hint: null,
    });
    expect(rights({ heads: { ...heads, draftHead: null } })).toMatchObject({
      allowed: false,
      hint: /copy of another page/,
    });
  });
});

describe('changes made in a page’s Markdown', () => {
  it('are made in order, each once however often it is asked', () => {
    const changes = [
      task(LIST, 'milk', true),
      task(LIST, 'eggs', false),
      task(LIST, 'milk', true),
      { kind: 'property', key: 'servings', value: 6 } as const,
    ];
    expect(applyChanges(LIST, changes)).toEqual({
      markdown: '---\nservings: 6\n---\n- [x] milk\n- [ ] bread\n- [ ] eggs\n',
      dropped: [],
    });
  });

  it('find a property by its name as a reference does, or add it', () => {
    const page = '---\nCook Time: 20\n---\nBody\n';
    expect(
      applyChanges(page, [
        { kind: 'property', key: 'cook_time', value: 25 },
        { kind: 'property', key: 'servings', value: 2 },
      ]).markdown,
    ).toBe('---\nCook Time: 25\nservings: 2\n---\nBody\n');
  });

  it('leave out what no longer applies, saying why', () => {
    const changes = [
      task(LIST, 'bread', true),
      { kind: 'property', key: 'notes', value: 'x' } as const,
    ];
    const { markdown, dropped } = applyChanges('---\nnotes: |\n  a\n---\n- [ ] milk\n', changes);
    expect(markdown).toBe('---\nnotes: |\n  a\n---\n- [ ] milk\n');
    expect(dropped.map(({ reason }) => reason)).toEqual([
      'The task “bread” isn’t on the page any more.',
      expect.stringMatching(/^notes couldn’t be changed: /),
    ]);
  });
});

describe('a flush', () => {
  it('saves every change as one draft and publishes it as one version', async () => {
    const page = server(LIST);
    const flushed = await flushChanges(page.operations, [
      task(LIST, 'milk', true),
      task(LIST, 'bread', true),
    ]);
    expect(flushed).toEqual({ outcome: 'published', dropped: [] });
    expect(page.state.saves).toBe(1);
    expect(page.state.published).toEqual([
      '---\nservings: 4\n---\n- [x] milk\n- [x] bread\n- [x] eggs\n',
    ]);
  });

  it('saves and publishes nothing when the page is already as asked', async () => {
    const page = server(LIST);
    const flushed = await flushChanges(page.operations, [
      task(LIST, 'eggs', true),
      task(LIST, 'milk', true),
      task(LIST, 'milk', false),
    ]);
    expect(flushed).toEqual({ outcome: 'unchanged', dropped: [] });
    expect(page.state.saves).toBe(0);
  });

  it('only saves to the draft, never publishing it, when the draft has changes of its own', async () => {
    const draft = `${LIST}\nMy own edit.\n`;
    const page = server(draft, { draftChanges: true });
    expect(await flushChanges(page.operations, [task(LIST, 'milk', true)])).toEqual({
      outcome: 'in-draft',
      dropped: [],
    });
    expect(page.draft()).toBe(`${LIST.replace('[ ] milk', '[x] milk')}\nMy own edit.\n`);
    expect(page.state.published).toEqual([]);
  });

  it('starts again on the newer draft when someone saved meanwhile, then leaves it in the draft', async () => {
    const page = server(LIST);
    page.savesFirst((text) => `- [ ] butter\n${text.replace('---\nservings: 4\n---\n', '')}`);
    expect(await flushChanges(page.operations, [task(LIST, 'bread', true)])).toEqual({
      outcome: 'in-draft',
      dropped: [],
    });
    // Their line kept, and the tick made on the task by its text.
    expect(page.draft()).toBe('- [ ] butter\n- [ ] milk\n- [x] bread\n- [x] eggs\n');
    expect(page.state.published).toEqual([]);
  });

  it('publishes on the newer publication when someone published meanwhile', async () => {
    const page = server(LIST);
    page.savesFirst((text) => text.replace('- [x] eggs', '- [x] eggs\n- [ ] jam'), {
      publishes: true,
    });
    expect((await flushChanges(page.operations, [task(LIST, 'milk', true)])).outcome).toBe(
      'published',
    );
    expect(page.state.published).toEqual([
      '---\nservings: 4\n---\n- [x] milk\n- [ ] bread\n- [x] eggs\n- [ ] jam\n',
    ]);
  });

  it('gives up after a few tries when someone keeps saving first', async () => {
    const page = server(LIST);
    page.savesFirst((text) => text, { publishes: true, times: 10 });
    await expect(flushChanges(page.operations, [task(LIST, 'milk', true)])).rejects.toMatchObject({
      code: 'stale-head',
    });
  });

  it('keeps the changes in the draft when the publication moved after the save', async () => {
    const page = server(LIST);
    const publish = page.operations.publish;
    page.operations.publish = async () => {
      page.state.publishedHead = 'p-other';
      return publish({ draftHead: page.state.draftHead ?? '', publishedHead: 'p0' });
    };
    expect((await flushChanges(page.operations, [task(LIST, 'milk', true)])).outcome).toBe(
      'in-draft',
    );
    expect(page.draft()).toContain('- [x] milk');
  });

  it('says a change is in the draft when a publish failed after its save, and the draft has it', async () => {
    const page = server(LIST);
    const publish = page.operations.publish;
    page.operations.publish = async () => {
      throw new Error('offline');
    };
    await expect(flushChanges(page.operations, [task(LIST, 'milk', true)])).rejects.toThrow(
      'offline',
    );
    // The save stood: the draft now has the tick, and changes of its own.
    page.state.draftChanges = true;
    page.operations.publish = publish;
    expect(await flushChanges(page.operations, [task(LIST, 'milk', true)])).toEqual({
      outcome: 'in-draft',
      dropped: [],
    });
    expect(page.state.published).toEqual([]);
    // Left out altogether, it is unchanged.
    expect(
      (
        await flushChanges(page.operations, [
          { kind: 'task', offset: 0, line: 'jam', checked: true },
        ])
      ).outcome,
    ).toBe('unchanged');
  });

  it('leaves the changes in the draft, unpublished, when the page has a public link by then', async () => {
    const page = server(LIST);
    page.state.publicLink = true;
    const flushed = await flushChanges(page.operations, [task(LIST, 'milk', true)]);
    expect(flushed).toEqual({ outcome: 'in-draft', dropped: [], publicLink: true });
    expect(page.draft()).toContain('- [x] milk');
    expect(page.state.published).toEqual([]);
    expect(
      readingNotices({ changes: [], saving: false, error: null, last: flushed, before: null }),
    ).toEqual([
      'This page has a public link, so your change went into the draft: publish it from there.',
    ]);
  });

  it('reports what it left out', async () => {
    const page = server(LIST);
    const flushed = await flushChanges(page.operations, [
      { kind: 'task', offset: 0, line: 'jam', checked: true },
      task(LIST, 'milk', true),
    ]);
    expect(flushed.outcome).toBe('published');
    expect(flushed.dropped).toEqual([
      {
        change: { kind: 'task', offset: 0, line: 'jam', checked: true },
        reason: 'The task “jam” isn’t on the page any more.',
      },
    ]);
  });
});

// Each runs on fake timers, the queue at its own pace: three seconds after
// the last change, fifteen at most after the first.
beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** Let `ms` pass, running the timers and promises due meanwhile. */
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** A queue whose flush records what it gets, and finishes once `finish()` is called. */
function queue() {
  const flushes: ReadingChange[][] = [];
  let finish: (result?: Error | Flushed) => void = () => {};
  const reading = new ReadingQueue(async (changes) => {
    flushes.push([...changes]);
    const result = await new Promise<Error | Flushed | undefined>((resolve) => (finish = resolve));
    if (result instanceof Error) throw result;
    return result ?? ({ outcome: 'published', dropped: [] } satisfies Flushed);
  });
  return { reading, flushes, finish: (result?: Error | Flushed) => finish(result) };
}

const tick = (line: string): ReadingChange => ({ kind: 'task', offset: 0, line, checked: true });

describe('a page’s queue', () => {
  it('flushes once changes pause, all of them together, keeping them shown until it is done', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    await pass(2000);
    q.reading.add(tick('b'));
    await pass(2999);
    expect(q.flushes).toEqual([]);
    expect(q.reading.busy()).toBe(true);
    expect(readingNotices(q.reading.get())).toEqual(['Publishing your changes…']);
    await pass(1);
    expect(q.flushes).toEqual([[tick('a'), tick('b')]]);
    expect(q.reading.get()).toMatchObject({ saving: true, changes: [{}, {}] });
    q.finish();
    await pass(0);
    expect(q.reading.get()).toMatchObject({ saving: false, changes: [] });
    expect(q.reading.busy()).toBe(false);
    expect(readingNotices(q.reading.get())).toEqual(['Your changes are published.']);
  });

  it('flushes at most fifteen seconds after the first change, however often they come', async () => {
    const q = queue();
    for (let i = 0; i < 7; i++) {
      q.reading.add(tick(String(i)));
      await pass(2000);
    }
    expect(q.flushes).toEqual([]);
    q.reading.add(tick('7'));
    await pass(1000);
    expect(q.flushes).toHaveLength(1);
    expect(q.flushes[0]).toHaveLength(8);
  });

  it('keeps changes made during a flush for the next, on their own timer', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    await pass(3000);
    q.reading.add(tick('b'));
    // Its timer runs out while the first flush is still running: it waits.
    await pass(5000);
    expect(q.flushes).toEqual([[tick('a')]]);
    q.finish();
    await pass(0);
    expect(q.flushes).toEqual([[tick('a')]]);
    expect(readingNotices(q.reading.get())).toEqual(['Publishing your changes…']);
    await pass(3000);
    expect(q.flushes).toEqual([[tick('a')], [tick('b')]]);
    q.finish();
    await pass(0);
    expect(q.reading.get().changes).toEqual([]);
  });

  it('flushes at once as the person leaves, then what came meanwhile', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    const leaving = q.reading.flush();
    await pass(0);
    q.reading.add(tick('b'));
    q.finish();
    await pass(0);
    expect(q.flushes).toEqual([[tick('a')], [tick('b')]]);
    q.finish();
    await leaving;
    expect(q.reading.get().changes).toEqual([]);
  });

  it('keeps the changes when a flush fails, saying why, and tries them again with the next', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    const flushing = q.reading.flush();
    await pass(0);
    q.finish(new Error('offline'));
    await flushing;
    expect(q.reading.get()).toMatchObject({ saving: false, changes: [{ change: tick('a') }] });
    expect(q.reading.busy()).toBe(true);
    expect(readingNotices(q.reading.get())).toEqual(['Couldn’t save your change: offline']);
    q.reading.add(tick('b'));
    await pass(3000);
    expect(q.flushes.at(-1)).toEqual([tick('a'), tick('b')]);
  });

  it('drops what failed as the person turns to the draft, and forgets how the last flush went', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    const flushing = q.reading.flush();
    await pass(0);
    q.finish(new Error('offline'));
    await flushing;
    q.reading.discard();
    expect(q.reading.get().changes).toEqual([]);
    await pass(10_000);
    expect(q.flushes).toHaveLength(1);
    expect(readingNotices(q.reading.get())).toEqual(['Couldn’t save your change: offline']);
    q.reading.forget();
    expect(readingNotices(q.reading.get())).toEqual([]);
  });

  it('knows the publication each flush of a page replaced, back to the one first read', () => {
    // One by the queue left behind, one by the queue the person came back to.
    notePublished('page-o', 'p2', 'p1');
    notePublished('page-o', 'p3', 'p2');
    notePublished('page-o', 'p9', null);
    expect(['p3', 'p2', 'p1', 'p4', 'p9'].map((r) => originOf('page-o', r))).toEqual([
      'p1',
      'p1',
      'p1',
      'p4',
      'p9',
    ]);
    // Another page's publications are its own.
    expect(originOf('page-other', 'p3')).toBe('p3');
  });
});

describe('a page’s flushes', () => {
  it('run one after another, even from two queues, while other pages’ don’t wait', async () => {
    const order: string[] = [];
    let first: () => void = () => {};
    const a1 = inTurn('page-a', async () => {
      order.push('a1 starts');
      await new Promise<void>((resolve) => (first = resolve));
      order.push('a1 ends');
    });
    const a2 = inTurn('page-a', async () => void order.push('a2 starts'));
    const b = inTurn('page-b', async () => void order.push('b starts'));
    const running = pageFlushing('page-a');
    expect(running).toBeDefined();
    await pass(0);
    expect(order).toEqual(['a1 starts', 'b starts']);
    first();
    await Promise.all([a1, a2, b]);
    expect(order).toEqual(['a1 starts', 'b starts', 'a1 ends', 'a2 starts']);
    // Settled once every flush of the page has, and then none runs.
    await running;
    await pass(0);
    expect(pageFlushing('page-a')).toBeUndefined();
    // One that failed holds up nothing after it.
    await expect(
      inTurn('page-a', async () => Promise.reject(new Error('offline'))),
    ).rejects.toThrow();
    expect(await inTurn('page-a', async () => 'next')).toBe('next');
  });
});

describe('flushes of pages the person left', () => {
  it('are waited for, every page’s, until none runs', async () => {
    expect(flushesUnderway()).toBeNull();
    let done: () => void = () => {};
    const left = inTurn('page-left', () => new Promise<void>((resolve) => (done = resolve)));
    const other = inTurn('page-other', async () => {});
    const underway = flushesUnderway();
    expect(underway).not.toBeNull();
    let settled = false;
    void underway?.then(() => (settled = true));
    await pass(0);
    expect(settled).toBe(false);
    done();
    await Promise.all([left, other, underway]);
    await pass(0);
    expect(settled).toBe(true);
    expect(flushesUnderway()).toBeNull();
  });

  it('are still told after the person turns straight to the draft, until a flush of this visit', async () => {
    leftOutcome('page-z', {
      last: { outcome: 'in-draft', dropped: [] },
      error: null,
    });
    const back = queue();
    const end = showing('page-z', back.reading);
    // As the draft opens: what this visit said goes, what was told before stays.
    back.reading.forget();
    expect(readingNotices(back.reading.get())).toEqual([
      'Your change went into the draft: publish it to show it.',
    ]);
    back.reading.add(tick('a'));
    const flushing = back.reading.flush();
    await pass(0);
    back.finish();
    await flushing;
    back.reading.forget();
    expect(readingNotices(back.reading.get())).toEqual([]);
    end();
  });

  it('wait for a batch a flush chains behind itself, which starts only once that one settles', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    await pass(3000);
    q.reading.add(tick('b'));
    // Leaving while the first runs: the second waits for it, then runs.
    const left = holding(q.reading.flush());
    const underway = flushesUnderway();
    let settled = false;
    void underway?.then(() => (settled = true));
    q.finish();
    await pass(0);
    expect(q.flushes).toEqual([[tick('a')], [tick('b')]]);
    expect(settled).toBe(false);
    q.finish();
    await left;
    await pass(0);
    expect(settled).toBe(true);
    expect(flushesUnderway()).toBeNull();
  });

  it('are told while the queue showing the page saves, and still once its flush is done', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    const flushing = q.reading.flush();
    await pass(0);
    q.reading.told({ last: null, error: new Error('offline') });
    expect(readingNotices(q.reading.get())).toEqual([
      'Publishing your changes…',
      'Couldn’t save your change: offline',
    ]);
    q.finish();
    await flushing;
    expect(readingNotices(q.reading.get())).toEqual([
      'Your changes are published.',
      'Couldn’t save your change: offline',
    ]);
    // Until a flush of this visit starts after it.
    q.reading.add(tick('b'));
    const next = q.reading.flush();
    await pass(0);
    q.finish();
    await next;
    expect(readingNotices(q.reading.get())).toEqual(['Your changes are published.']);
  });

  it('tell how they went to the page as it shows again, or at once if it shows now', () => {
    const failed = { last: null, error: new Error('offline') };
    leftOutcome('page-x', failed);
    const back = queue();
    const ended = showing('page-x', back.reading);
    expect(readingNotices(back.reading.get())).toEqual(['Couldn’t save your change: offline']);
    // Told once: showing the page again later says nothing of it.
    ended();
    const later = queue();
    showing('page-x', later.reading)();
    expect(readingNotices(later.reading.get())).toEqual([]);

    const shown = queue();
    const end = showing('page-y', shown.reading);
    leftOutcome('page-y', {
      last: { outcome: 'in-draft', dropped: [], publicLink: true },
      error: null,
    });
    expect(readingNotices(shown.reading.get())).toEqual([
      'This page has a public link, so your change went into the draft: publish it from there.',
    ]);
    end();
  });
});

describe('what the queue says', () => {
  const state = { changes: [], saving: false, error: null, before: null };
  it('tells of changes that went into the draft, and of those left out', () => {
    expect(
      readingNotices({
        ...state,
        last: {
          outcome: 'in-draft',
          dropped: [{ change: tick('a'), reason: 'The task “a” isn’t on the page any more.' }],
        },
      }),
    ).toEqual([
      'Your change went into the draft: publish it to show it.',
      'A change was left out. The task “a” isn’t on the page any more.',
    ]);
    expect(readingNotices({ ...state, last: null })).toEqual([]);
  });
});
