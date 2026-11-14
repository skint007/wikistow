// The smallest change a writer puts into a session's text (protocol section
// 5.10, **The document**): one span, never starting or ending inside a
// surrogate pair, so Yjs never stores a half of one as U+FFFD.
import * as Y from 'yjs';
import { describe, expect, it } from 'vite-plus/test';
import { changeText, textChange, textChanges } from '../src/live/text-change.ts';

describe('textChange', () => {
  it('is the span between the common start and end', () => {
    expect(textChange('Hello world', 'Hello, world')).toEqual({ from: 5, remove: 0, insert: ',' });
    expect(textChange('abc', 'abc')).toBeNull();
    expect(textChange('', 'new')).toEqual({ from: 0, remove: 0, insert: 'new' });
    expect(textChange('gone', '')).toEqual({ from: 0, remove: 4, insert: '' });
  });

  it('widens to whole code points where two emoji share a half', () => {
    // 😀 (D83D DE00) and 😁 (D83D DE01) share their first half.
    const change = textChange('a😀b', 'a😁b');
    expect(change).toEqual({ from: 1, remove: 2, insert: '😁' });
    // and where they share their second half: 😀 and 🙀 (D83D DE40) don't, 𝐀 (D835 DC00) and 🐀 (D83D DC00) do.
    expect(textChange('x𝐀', 'x🐀')).toEqual({ from: 1, remove: 2, insert: '🐀' });
  });

  it('keeps a pair whole when text is typed right before or after it', () => {
    expect(textChange('😀', 'a😀')).toEqual({ from: 0, remove: 0, insert: 'a' });
    expect(textChange('😀', '😀a')).toEqual({ from: 2, remove: 0, insert: 'a' });
  });
});

describe('changeText', () => {
  it('makes the text read as asked, by its smallest change', () => {
    const doc = new Y.Doc();
    const text = doc.getText('body');
    text.insert(0, 'one two');
    const changes: unknown[] = [];
    text.observe((event) => changes.push(event.delta));
    doc.transact(() => changeText(text, 'one and two'));
    expect(text.toJSON()).toBe('one and two');
    expect(changes).toEqual([[{ retain: 4 }, { insert: 'and ' }]]);
  });

  it('inserts only well-formed text', () => {
    const doc = new Y.Doc();
    const text = doc.getText('body');
    doc.transact(() => changeText(text, 'cut \ud83d'));
    expect(text.toJSON()).toBe('cut �');
  });
});

describe('textChanges', () => {
  it('changes each run of lines that differs, leaving the lines between alone', () => {
    const before = 'Intro [[Old]] one.\n\nMiddle.\n\nEnd [[Old]] tail.\n';
    const after = 'Intro [[New]] one.\n\nMiddle.\n\nEnd [[New]] tail.\n';
    const changes = textChanges(before, after);
    expect(changes).toEqual([
      { from: 8, remove: 3, insert: 'New' },
      { from: 35, remove: 3, insert: 'New' },
    ]);
    let text = before;
    for (const change of changes.toReversed()) {
      text = text.slice(0, change.from) + change.insert + text.slice(change.from + change.remove);
    }
    expect(text).toBe(after);
  });
});
