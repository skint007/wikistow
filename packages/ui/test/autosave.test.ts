import { PageTooLarge } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { Autosave, type SaveStatus } from '../src/page/autosave.ts';

/** An autosave that saves at once, refusing `'long'` as too large once `refuse()` is called. */
function autosave() {
  const tried: string[] = [];
  const statuses: SaveStatus[] = [];
  let refuse = () => {};
  const saving = new Autosave<string>(
    async (text) => {
      tried.push(text);
      if (text !== 'long') return;
      await new Promise<void>((resolve) => (refuse = resolve));
      throw new PageTooLarge('markdown', 2, 1);
    },
    (status) => statuses.push(status),
    { debounceMs: 0, maxWaitMs: 0 },
  );
  return { saving, tried, statuses, refuse: () => refuse() };
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('an edit too large to save', () => {
  it('is kept unsaved, without trying again until the next edit, which saves', async () => {
    const a = autosave();
    a.saving.schedule('long');
    await turn();
    // Typed while it is refused: saved next, as an edit during any save.
    a.saving.schedule('short');
    await turn();
    a.refuse();
    await a.saving.flush();
    expect(a.tried).toEqual(['long', 'short']);
    expect(a.statuses).toContain('too-large');
    expect(a.saving.status).toBe('saved');
    expect(a.saving.unsaved()).toBeNull();
  });
});

describe('a save stopped before it sends', () => {
  it('keeps its edit unsaved and the status the stop set, until resumed', async () => {
    let go = () => {};
    const waiting = new Promise<void>((resolve) => (go = resolve));
    const sent: string[] = [];
    const saving: Autosave<string> = new Autosave<string>(
      async (text) => {
        await waiting;
        if (saving.isStopped()) return false;
        sent.push(text);
      },
      () => {},
      { debounceMs: 0, maxWaitMs: 0 },
    );
    saving.schedule('typed');
    await turn();
    saving.conflict();
    go();
    await saving.flush();
    expect(sent).toEqual([]);
    expect(saving.status).toBe('conflict');
    expect(saving.unsaved()).toBe('typed');
    saving.resume();
    await saving.flush();
    expect(sent).toEqual(['typed']);
    expect(saving.status).toBe('saved');
  });
});

describe('a save that reads its edit as it sends', () => {
  it('takes the edits made while it waited, so none is saved again after it', async () => {
    let go = () => {};
    const waiting = new Promise<void>((resolve) => (go = resolve));
    let latest = 'one';
    const sent: string[] = [];
    const saving: Autosave<() => string> = new Autosave<() => string>(
      async (read) => {
        await waiting;
        saving.takeWaiting();
        sent.push(read());
      },
      () => {},
      { debounceMs: 0, maxWaitMs: 0 },
    );
    saving.schedule(() => latest);
    await turn();
    latest = 'one two';
    saving.schedule(() => latest);
    expect(saving.status).toBe('pending');
    go();
    await saving.flush();
    expect(sent).toEqual(['one two']);
    expect(saving.status).toBe('saved');
  });

  it('shows as saving when resumed while it runs with nothing else waiting', async () => {
    let go = () => {};
    const waiting = new Promise<void>((resolve) => (go = resolve));
    const saving = new Autosave<string>(
      async () => {
        await waiting;
      },
      () => {},
      { debounceMs: 0, maxWaitMs: 0 },
    );
    saving.schedule('typed');
    await turn();
    saving.conflict();
    saving.resume();
    expect(saving.status).toBe('saving');
    go();
    await saving.flush();
    expect(saving.status).toBe('saved');
  });
});
