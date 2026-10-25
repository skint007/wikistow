import { RevisionId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { describe, expect, it } from 'vite-plus/test';
import {
  cellKey,
  cellProblem,
  folderColumns,
  NO_CHOICE,
  shownVersion,
  withColumn,
} from '../src/folder/folder-model.ts';

// A folder's table (ADR 0006, decision 8): its columns as kept, the key a
// cell writes, the version it builds on, and what a failed save shows.

const rev = (n: number) => RevisionId.parse(`01J${String(n).padStart(23, '0')}`);

describe('a folder’s columns', () => {
  it('come in the index’s order, each hidden by its folded name', () => {
    let choice = withColumn(NO_CHOICE, 'Cook time', true);
    choice = withColumn(choice, 'tags', true);
    expect(choice.hidden).toEqual(['cook time', 'tags']);
    expect(folderColumns(['servings', 'cook_time', 'tags'], choice.hidden)).toEqual([
      { key: 'servings', label: 'Servings', hidden: false },
      { key: 'cook_time', label: 'Cook time', hidden: true },
      { key: 'tags', label: 'Tags', hidden: true },
    ]);
    // Shown again, once, however it was spelled when hidden.
    expect(withColumn(withColumn(choice, 'cook-time', false), 'Tags', true).hidden).toEqual([
      'tags',
    ]);
  });

  it('write a page’s own spelling of a key, or the column’s where the page has none', () => {
    expect(cellKey([{ key: 'Cook_Time' }], 'cook time')).toBe('Cook_Time');
    expect(cellKey([{ key: 'servings' }], 'cook time')).toBe('cook time');
  });
});

describe('a cell’s edit', () => {
  it('builds on this view’s own write only while the index shows what it was made from', () => {
    const own = { indexed: rev(1), revisionId: rev(2), markdown: 'mine' };
    expect(shownVersion(rev(1), own)).toEqual({ revisionId: rev(2), markdown: 'mine' });
    // The index caught up, or someone else saved: the index's version is read.
    expect(shownVersion(rev(2), own)).toEqual({ revisionId: rev(2), markdown: null });
    expect(shownVersion(rev(3), own)).toEqual({ revisionId: rev(3), markdown: null });
    expect(shownVersion(rev(1), undefined)).toEqual({ revisionId: rev(1), markdown: null });
  });

  it('shows a draft that moved on as a conflict, and any other failure as why', () => {
    expect(cellProblem(new ApiError(409, 'stale-head', 'Someone saved since'))).toEqual({
      kind: 'conflict',
    });
    expect(cellProblem(new Error('The connection dropped'))).toMatchObject({ kind: 'failed' });
  });
});
