import { describe, expect, it } from 'vite-plus/test';
import { accessChange, type Access } from '../src/sharing/model.ts';

describe('access', () => {
  it('changes keys only as the protocol says', () => {
    const table: [Access, Access, string][] = [
      ['reader', 'reader', 'none'],
      ['reader', 'editor', 'promote'],
      ['reader', 'publisher', 'promote'],
      ['editor', 'publisher', 'publish'],
      ['publisher', 'editor', 'publish'],
      // Losing drafts takes new keys.
      ['editor', 'reader', 'demote'],
      ['publisher', 'reader', 'demote'],
    ];
    for (const [from, to, kind] of table)
      expect(accessChange(from, to).kind, `${from}→${to}`).toBe(kind);
    expect(accessChange('reader', 'publisher')).toEqual({ kind: 'promote', canPublish: true });
  });
});
