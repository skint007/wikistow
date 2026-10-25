import { RevisionId } from '@wikistow/client';
import { ApiError } from '@wikistow/client/api';
import { describe, expect, it } from 'vite-plus/test';
import {
  cellKey,
  cellProblem,
  folderColumns,
  nextOwnWrite,
  NO_CHOICE,
  shownVersion,
  withColumn,
} from '../src/folder/folder-model.ts';

// A folder's table (ADR 0006, decision 8): its columns as kept, the key a
// cell writes, the version it builds on, and what a failed save shows.

const rev = (n: number) => RevisionId.parse(`01J${String(n).padStart(23, '0')}`);

describe('a folder’s columns', () => {
  // As the app's tags would, but readable here.
  const tag = (folded: string) => `#${folded}`;

  it('come in the index’s order, each hidden by its folded name’s tag', () => {
    let choice = withColumn(NO_CHOICE, 'Cook time', true, tag);
    choice = withColumn(choice, 'tags', true, tag);
    expect(choice.hidden).toEqual(['#cook time', '#tags']);
    expect(folderColumns(['servings', 'cook_time', 'tags'], choice.hidden, tag)).toEqual([
      { key: 'servings', label: 'Servings', hidden: false },
      { key: 'cook_time', label: 'Cook time', hidden: true },
      { key: 'tags', label: 'Tags', hidden: true },
    ]);
    // Shown again, once, however it was spelled when hidden.
    expect(
      withColumn(withColumn(choice, 'cook-time', false, tag), 'Tags', true, tag).hidden,
    ).toEqual(['#tags']);
  });

  it('write a page’s own spelling of a key, or the column’s where the page has none', () => {
    expect(cellKey([{ key: 'Cook_Time' }], 'cook time')).toBe('Cook_Time');
    expect(cellKey([{ key: 'servings' }], 'cook time')).toBe('cook time');
  });
});

describe('a cell’s edit', () => {
  it('builds on this view’s own writes while the index shows a version they stand in for', () => {
    const first = nextOwnWrite(undefined, rev(1), { revisionId: rev(2), markdown: 'one' });
    expect(shownVersion(rev(1), first)).toEqual({ revisionId: rev(2), markdown: 'one' });
    // A second edit, on the first's version, before the index has it.
    const second = nextOwnWrite(first, rev(1), { revisionId: rev(3), markdown: 'two' });
    expect(second.over).toEqual([rev(1), rev(2)]);
    // An index built between the two shows the first: the second still stands.
    expect(shownVersion(rev(2), second)).toEqual({ revisionId: rev(3), markdown: 'two' });
    // The index caught up, or someone else saved: the index's version is read.
    expect(shownVersion(rev(3), second)).toEqual({ revisionId: rev(3), markdown: null });
    expect(shownVersion(rev(9), second)).toEqual({ revisionId: rev(9), markdown: null });
    // And a write after that starts afresh.
    expect(nextOwnWrite(second, rev(9), { revisionId: rev(10), markdown: '' }).over).toEqual([
      rev(9),
    ]);
  });

  it('shows a draft that moved on as a conflict, and any other failure as why', () => {
    expect(cellProblem(new ApiError(409, 'stale-head', 'Someone saved since'))).toEqual({
      kind: 'conflict',
    });
    expect(cellProblem(new Error('The connection dropped'))).toMatchObject({ kind: 'failed' });
  });
});
