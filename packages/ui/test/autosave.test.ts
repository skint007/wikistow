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
