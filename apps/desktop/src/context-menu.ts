// The app window's right-click menu: spelling suggestions for a misspelt
// word, and the usual edit items. Electron shows none of its own.
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';

/** What a right-click knows: the word under it, and what the field allows. */
export type ClickedAt = Pick<
  ContextMenuParams,
  'misspelledWord' | 'dictionarySuggestions' | 'isEditable' | 'selectionText' | 'editFlags'
>;

/** What the spelling items do, given by main. */
export type Spelling = {
  /** Replace the misspelt word with `word` (`webContents.replaceMisspelling`). */
  replace: (word: string) => void;
  /** Stop marking `word` (`session.addWordToSpellCheckerDictionary`). */
  learn: (word: string) => void;
};

/**
 * The menu for a right-click, empty where there is nothing to offer. A
 * misspelt word gets its suggestions and "Add to dictionary"; a field gets
 * Cut, Copy, Paste and Select All; a selection elsewhere gets Copy.
 */
export function contextMenu(at: ClickedAt, spelling: Spelling): MenuItemConstructorOptions[] {
  const { misspelledWord: word, editFlags: can } = at;
  const items: MenuItemConstructorOptions[] = [];
  if (word) {
    const suggestions = at.dictionarySuggestions.map((suggestion): MenuItemConstructorOptions => ({
      label: suggestion,
      click: () => spelling.replace(suggestion),
    }));
    items.push(
      ...(suggestions.length > 0 ? suggestions : [{ label: 'No suggestions', enabled: false }]),
      { type: 'separator' },
      { label: 'Add to dictionary', click: () => spelling.learn(word) },
      { type: 'separator' },
    );
  }
  if (at.isEditable) {
    items.push(
      { role: 'cut', enabled: can.canCut },
      { role: 'copy', enabled: can.canCopy },
      { role: 'paste', enabled: can.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: can.canSelectAll },
    );
  } else if (at.selectionText) {
    items.push({ role: 'copy', enabled: can.canCopy });
  }
  return items.at(-1)?.type === 'separator' ? items.slice(0, -1) : items;
}
