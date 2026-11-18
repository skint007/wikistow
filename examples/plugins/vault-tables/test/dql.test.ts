import type { PageRow } from '@wikistow/plugin-sdk';
import { describe, expect, it } from 'vite-plus/test';
import { cellText } from '../src/cells.ts';
import { readDql } from '../src/dql.ts';

// What the vault-tables example asks host.pages.query for, from a Dataview
// block's text, and what its cells show (#473). The host's reading of the
// query is tested with it (packages/ui/test/page-rows.test.ts).

const read = (source: string) => {
  const dql = readDql(source);
  if (!dql.ok) throw new Error(dql.error);
  return dql;
};

const error = (source: string) => {
  const dql = readDql(source);
  return dql.ok ? null : dql.error;
};

describe('reading a Dataview block', () => {
  it('passes file.mtime in SORT and WHERE through to host.pages.query, which reads it as saved', () => {
    expect(read('TABLE servings\nSORT file.mtime DESC').query).toEqual({
      sort: 'file.mtime desc',
    });
    expect(read('LIST\nWHERE file.mtime > date(2026-11-14)').query).toEqual({
      where: 'file.mtime > 2026-11-14T00:00:00.000Z',
    });
    expect(
      read(
        'TABLE file.mtime AS "Saved"\nFROM "Recipes"\nWHERE file.mtime >= date(2026-01-01) AND tried = true\nSORT File.MTime ascending\nLIMIT 5',
      ).query,
    ).toEqual({
      from: 'Recipes',
      where: 'file.mtime >= 2026-01-01T00:00:00.000Z, tried = true',
      sort: 'file.mtime asc',
      limit: 5,
    });
  });

  it('takes a file.mtime column, whatever its heading', () => {
    expect(read('TABLE servings AS "Serves", file.mtime').columns).toEqual([
      { name: 'servings', heading: 'Serves' },
      { name: 'file.mtime', heading: 'file.mtime' },
    ]);
    expect(read('TABLE FILE.MTIME AS "Saved"').columns).toEqual([
      { name: 'file.mtime', heading: 'Saved' },
    ]);
  });

  it('refuses WHERE or SORT on a property named saved, which the host reads as when a page was saved', () => {
    for (const source of [
      'TABLE servings\nWHERE saved = true',
      'TABLE servings\nWHERE Saved > date(2026-01-01)',
      'LIST\nWHERE tried = true AND saved != false',
      'LIST\nWHERE contains(saved, "x")',
    ]) {
      expect(error(source), source).toMatch(
        /^WHERE takes .*a property named saved can’t be read here/,
      );
    }
    for (const source of ['TABLE servings\nSORT saved DESC', 'LIST\nSORT SAVED']) {
      expect(error(source), source).toMatch(
        /^SORT takes .*a property named saved can’t be sorted by here/,
      );
    }
    // A column of it is the property's, as Dataview's is: shown, never queried.
    expect(read('TABLE saved').columns).toEqual([{ name: 'saved', heading: 'saved' }]);
    // Other names with saved in them are properties like any other.
    expect(read('LIST\nWHERE saved_on > date(2026-01-01)\nSORT last saved').query).toEqual({
      where: 'saved_on > 2026-01-01T00:00:00.000Z',
      sort: 'last saved asc',
    });
  });
});

describe('a cell', () => {
  const row = (updated: string | null | undefined, properties: PageRow['properties'] = {}) =>
    ({
      page: { spaceId: 's', pageId: 'p' },
      title: 'Garlic bread',
      folderId: null,
      path: [],
      tags: [],
      properties,
      revision: 'r',
      draft: false,
      updated,
    }) as PageRow;

  it('shows the row’s updated for file.mtime, in the reader’s time zone, or a dash when not known', () => {
    const at = '2026-11-13T09:30:41.123Z';
    expect(cellText(row(at), 'file.mtime')).toBe(
      new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    );
    // Its time, not a property named saved, updated or file.mtime.
    const named = { saved: 'kept', updated: 'by hand', 'file.mtime': 'written' };
    expect(cellText(row(at, named), 'file.mtime')).toBe(cellText(row(at), 'file.mtime'));
    expect(cellText(row(null, named), 'file.mtime')).toBe('—');
    expect(cellText(row(undefined), 'file.mtime')).toBe('—');
    expect(cellText(row('not a time'), 'file.mtime')).toBe('—');
  });

  it('shows a property by name as =name finds it, a list comma-separated', () => {
    const properties = { Cook_Time: 25, tags: ['bread', 'sides'], saved: 'kept', empty: '' };
    expect(cellText(row(null, properties), 'cook time')).toBe('25');
    expect(cellText(row(null, properties), 'tags')).toBe('bread, sides');
    expect(cellText(row(null, properties), 'saved')).toBe('kept');
    expect(cellText(row(null, properties), 'empty')).toBe('—');
    expect(cellText(row(null, properties), 'missing')).toBe('—');
  });
});
