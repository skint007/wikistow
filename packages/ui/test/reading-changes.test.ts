import { taskItems } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyChanges,
  flushChanges,
  readingNotices,
  ReadingQueue,
  readingRights,
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
    readingRights({ viewer: editor, heads, view: 'published', revision: 'p1', ...over });

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

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A queue whose flush records what it gets, and finishes once `finish()` is called. */
function queue(timing = { debounceMs: 30, maxWaitMs: 80 }) {
  const flushes: ReadingChange[][] = [];
  let finish: (result?: Error) => void = () => {};
  const reading = new ReadingQueue(async (changes) => {
    flushes.push([...changes]);
    const result = await new Promise<Error | undefined>((resolve) => (finish = resolve));
    if (result) throw result;
    return { outcome: 'published', dropped: [] } satisfies Flushed;
  }, timing);
  return { reading, flushes, finish: (result?: Error) => finish(result) };
}

const tick = (line: string): ReadingChange => ({ kind: 'task', offset: 0, line, checked: true });

describe('a page’s queue', () => {
  it('flushes once changes pause, all of them together, keeping them shown until it is done', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    await wait(10);
    q.reading.add(tick('b'));
    await wait(10);
    expect(q.flushes).toEqual([]);
    expect(readingNotices(q.reading.get())).toEqual(['Publishing your changes…']);
    await wait(40);
    expect(q.flushes).toEqual([[tick('a'), tick('b')]]);
    expect(q.reading.get()).toMatchObject({ saving: true, changes: [{}, {}] });
    q.finish();
    await turn();
    expect(q.reading.get()).toMatchObject({ saving: false, changes: [] });
    expect(readingNotices(q.reading.get())).toEqual(['Your changes are published.']);
  });

  it('flushes at most a while after the first change, however often they come', async () => {
    const q = queue();
    for (let i = 0; i < 6; i++) {
      q.reading.add(tick(String(i)));
      await wait(20);
    }
    expect(q.flushes.length).toBe(1);
    expect(q.flushes[0]?.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps changes made during a flush for the next, on their own timer', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    await wait(40);
    q.reading.add(tick('b'));
    // Its timer runs out while the first flush is still running: it waits.
    await wait(50);
    expect(q.flushes).toEqual([[tick('a')]]);
    q.finish();
    await wait(50);
    expect(q.flushes).toEqual([[tick('a')], [tick('b')]]);
    q.finish();
    await turn();
    expect(q.reading.get().changes).toEqual([]);
  });

  it('flushes at once as the person leaves, then what came meanwhile', async () => {
    const q = queue({ debounceMs: 10_000, maxWaitMs: 10_000 });
    q.reading.add(tick('a'));
    const leaving = q.reading.flush();
    await turn();
    q.reading.add(tick('b'));
    q.finish();
    await wait(0);
    q.finish();
    await leaving;
    expect(q.flushes).toEqual([[tick('a')], [tick('b')]]);
    expect(q.reading.get().changes).toEqual([]);
  });

  it('keeps the changes when a flush fails, saying why, and tries them again with the next', async () => {
    const q = queue();
    q.reading.add(tick('a'));
    const flushing = q.reading.flush();
    await turn();
    q.finish(new Error('offline'));
    await flushing;
    expect(q.reading.get()).toMatchObject({ saving: false, changes: [{ change: tick('a') }] });
    expect(readingNotices(q.reading.get())).toEqual(['Couldn’t save your change: offline']);
    q.reading.add(tick('b'));
    await wait(40);
    expect(q.flushes.at(-1)).toEqual([tick('a'), tick('b')]);
  });
});

describe('what the queue says', () => {
  const state = { changes: [], saving: false, error: null };
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
