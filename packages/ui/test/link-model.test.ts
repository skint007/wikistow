import type { LinkablePage } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import { titleOptions } from '../src/page/editor/link-model.ts';

describe('the pages offered after [[', () => {
  describe('in a share', () => {
    // The draft is in the share rooted at `Shared`, under `Team`: a link
    // here may name only the pages in it.
    const all: LinkablePage[] = [
      { id: 'self', title: 'Garden', folders: ['Team', 'Shared'] },
      { id: 'private-notes', title: 'Notes', folders: ['Private'] },
      { id: 'shared-notes', title: 'Notes', folders: ['Team', 'Shared'] },
      { id: 'log-a', title: 'Log', folders: ['Team', 'Shared', 'A'] },
      { id: 'log-b', title: 'Log', folders: ['Team', 'Shared', 'B'] },
      { id: 'twin-a', title: 'Twin', folders: ['Team', 'Shared'] },
      { id: 'twin-b', title: 'Twin', folders: ['Team', 'Shared'] },
      { id: 'private-plan', title: 'Plan', folders: ['Private'] },
    ];
    const targets = new Set(['self', 'shared-notes', 'log-a', 'log-b', 'twin-a', 'twin-b']);
    const options = titleOptions({ pages: all, selfId: 'self', targets });
    const option = (id: string) => options.find((o) => o.page.id === id);

    it('offers only the pages a link here may name', () => {
      expect(options.map((o) => o.page.id)).toEqual([
        'shared-notes',
        'log-a',
        'log-b',
        'twin-a',
        'twin-b',
      ]);
    });

    it('writes no folder of a page outside the share, and records the pick it can’t tell', () => {
      expect(option('shared-notes')).toMatchObject({
        text: 'Notes',
        detail: 'Team / Shared',
        pick: true,
      });
    });
  });
});
