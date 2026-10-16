import { describe, expect, it } from 'vite-plus/test';
import { contextMenu, type ClickedAt } from '../src/context-menu.ts';

const CAN_ALL = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: true,
};

const at = (overrides: Partial<ClickedAt>): ClickedAt => ({
  misspelledWord: '',
  dictionarySuggestions: [],
  isEditable: false,
  selectionText: '',
  editFlags: CAN_ALL,
  ...overrides,
});

describe('contextMenu', () => {
  it('offers suggestions that replace the word, and adds it to the dictionary', () => {
    const replaced: string[] = [];
    const learnt: string[] = [];
    const items = contextMenu(
      at({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], isEditable: true }),
      { replace: (word) => replaced.push(word), learn: (word) => learnt.push(word) },
    );
    expect(items.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      'the',
      'ten',
      'separator',
      'Add to dictionary',
      'separator',
      'cut',
      'copy',
      'paste',
      'separator',
      'selectAll',
    ]);
    // Electron passes the item, window and event, which these clicks don't read.
    const click = (label: string) => {
      const item = items.find((candidate) => candidate.label === label);
      if (item?.click) Reflect.apply(item.click, undefined, []);
    };
    click('ten');
    click('Add to dictionary');
    expect(replaced).toEqual(['ten']);
    expect(learnt).toEqual(['teh']);
  });

  it('says when there are no suggestions', () => {
    const [first] = contextMenu(at({ misspelledWord: 'qzxv', isEditable: true }), {
      replace: () => {},
      learn: () => {},
    });
    expect(first).toEqual({ label: 'No suggestions', enabled: false });
  });

  it('follows the edit flags, offers Copy for a selection, and nothing elsewhere', () => {
    const spelling = { replace: () => {}, learn: () => {} };
    const field = contextMenu(
      at({ isEditable: true, editFlags: { ...CAN_ALL, canCut: false, canCopy: false } }),
      spelling,
    );
    expect(field.filter((item) => item.role).map(({ role, enabled }) => [role, enabled])).toEqual([
      ['cut', false],
      ['copy', false],
      ['paste', true],
      ['selectAll', true],
    ]);
    expect(contextMenu(at({ selectionText: 'words' }), spelling)).toEqual([
      { role: 'copy', enabled: true },
    ]);
    expect(contextMenu(at({}), spelling)).toEqual([]);
  });
});
