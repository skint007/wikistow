import { ApiError } from '@wikistow/client/api';
import { describe, expect, it } from 'vite-plus/test';
import { copyMessage, namedPages, PagesRefused } from '../src/page/messages.ts';
import { copyDestinations, copySpaces, type MoveTree } from '../src/page/move-model.ts';

// Where a copy, or a move into another space, can go (ADR 0007): the
// spaces the dialog offers, and where in each the person can make pages;
// and what it says when one is refused.

describe('where a copy goes in a space', () => {
  // Family: Garden › Beans, and Kitchen, shared with this person as a reader.
  const tree = (role: 'reader' | 'editor' | 'owner'): MoveTree => ({
    space: { role, opened: true },
    shares: [{ shareId: 'kitchen-share', rootId: 'kitchen', role: 'reader' }],
    folders: [
      { id: 'garden', parentId: null, name: 'Garden' },
      { id: 'beans', parentId: 'garden', name: 'Beans' },
      { id: 'kitchen', parentId: null, name: 'Kitchen' },
      { id: 'unread', parentId: null, name: null },
    ],
  });

  it('is anywhere the person can make pages, in path order', () => {
    expect(copyDestinations(tree('editor'))).toEqual([
      { parentId: null, path: [] },
      { parentId: 'garden', path: ['Garden'] },
      { parentId: 'beans', path: ['Garden', 'Beans'] },
    ]);
  });

  it('leaves out what is copied, but not where it is', () => {
    expect(copyDestinations(tree('owner'), new Set(['beans'])).map((d) => d.parentId)).toEqual([
      null,
      'garden',
    ]);
  });

  it('is only the shared folders a reader of the space edits', () => {
    const shared: MoveTree = {
      space: null,
      shares: [{ shareId: 'garden-share', rootId: 'garden', role: 'editor' }],
      folders: [
        { id: 'garden', parentId: null, name: 'Garden' },
        { id: 'beans', parentId: 'garden', name: 'Beans' },
      ],
    };
    expect(copyDestinations(shared).map((d) => d.parentId)).toEqual(['garden', 'beans']);
    expect(copyDestinations(tree('reader'))).toEqual([]);
  });

  it('isn’t the top of a space whose name failed its checks', () => {
    const unopened = { ...tree('owner'), space: { role: 'owner' as const, opened: false } };
    expect(copyDestinations(unopened).map((d) => d.parentId)).toEqual(['garden', 'beans']);
  });
});

describe('the spaces a copy can go to', () => {
  const lists = {
    spaces: [
      { id: 'work', name: 'Work', role: 'editor' as const },
      { id: 'family', name: 'Family', role: 'owner' as const },
      { id: 'club', name: 'Club', role: 'reader' as const },
      { id: 'broken', name: null, role: 'owner' as const },
    ],
    shared: [
      { spaceId: 'club', rootName: 'Minutes', role: 'editor' as const },
      { spaceId: 'aunt', rootName: 'Recipes', role: 'reader' as const },
      { spaceId: 'work', rootName: 'Projects', role: 'editor' as const },
    ],
  };

  it('start with the source’s own, then those the person makes pages in, by name', () => {
    expect(copySpaces(lists, 'work')).toEqual([
      { spaceId: 'work', name: 'Work', folderOnly: false },
      { spaceId: 'family', name: 'Family', folderOnly: false },
      { spaceId: 'club', name: 'Minutes', folderOnly: true },
    ]);
  });

  it('keep the source’s own for a reader of it, who edits a folder there', () => {
    expect(copySpaces(lists, 'club')[0]).toEqual({
      spaceId: 'club',
      name: 'Club',
      folderOnly: false,
    });
    expect(copySpaces(lists, 'aunt')[0]).toEqual({
      spaceId: 'aunt',
      name: 'Recipes',
      folderOnly: true,
    });
  });

  it('name the source’s own plainly when its name can’t be read', () => {
    expect(copySpaces(lists, 'broken')[0]).toEqual({
      spaceId: 'broken',
      name: 'This space',
      folderOnly: false,
    });
  });
});

describe('a copy refused for the pages it names', () => {
  const forbidden = (nodeIds?: string[]) =>
    new ApiError(403, 'forbidden', 'Refused', nodeIds ? { nodeIds } : {});

  it('names them only for a forbidden refusal that lists some', () => {
    expect(namedPages(forbidden(['plan']))).toEqual(['plan']);
    expect(namedPages(forbidden([]))).toBeNull();
    expect(namedPages(forbidden())).toBeNull();
    expect(namedPages(new ApiError(409, 'stale-head', 'Stale', { nodeIds: ['plan'] }))).toBeNull();
  });

  it('says what to do for each reason, a copy’s or a move’s', () => {
    expect(copyMessage(new PagesRefused('published-elsewhere', ['plan']), true)).toMatch(
      /published here from other pages, so nothing was copied.*Detach to edit/,
    );
    expect(copyMessage(new PagesRefused('nothing-to-copy', ['plan']), false)).toMatch(
      /neither a draft nor a published version, so nothing moved.*publishes or restores/,
    );
  });

  it('says access changed when records are refused for it, which ended the copy', () => {
    expect(copyMessage(new ApiError(409, 'permission-version', 'Changed'), true)).toBe(
      'Who has access changed while you were looking, so nothing was copied. Look at it again.',
    );
  });
});
