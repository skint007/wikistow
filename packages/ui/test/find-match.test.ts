import { describe, expect, it } from 'vite-plus/test';
import {
  folded,
  foundText,
  isFindKey,
  matchesIn,
  matchFrom,
  stepped,
} from '../src/page/find/match.ts';

const anyCase = (text: string) => ({ text, matchCase: false });

describe('Find on page matching', () => {
  it('ignores case unless told to match it', () => {
    expect(matchesIn('Rose, rose and ROSE', anyCase('rose'))).toEqual([
      { from: 0, to: 4 },
      { from: 6, to: 10 },
      { from: 15, to: 19 },
    ]);
    expect(matchesIn('Rose, rose and ROSE', { text: 'Rose', matchCase: true })).toEqual([
      { from: 0, to: 4 },
    ]);
  });

  it('counts each match after the last ends, as a browser’s find does', () => {
    expect(matchesIn('aaaa', anyCase('aa'))).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
  });

  it('finds nothing for nothing typed', () => {
    expect(matchesIn('text', anyCase(''))).toEqual([]);
  });

  it('keeps each character at its offset, and matches a no-break space as a space', () => {
    // `İ` lowers to two units, which would move every match after it.
    expect(folded('İstanbul Ankara', false)).toHaveLength('İstanbul Ankara'.length);
    expect(matchesIn('İstanbul Ankara', anyCase('ankara'))).toEqual([{ from: 9, to: 15 }]);
    expect(matchesIn('10 kg', anyCase('10 kg'))).toEqual([{ from: 0, to: 5 }]);
  });

  it('goes on from a selection to the next match, or the one before, around the end', () => {
    const matches = [
      { from: 2, to: 4 },
      { from: 10, to: 12 },
      { from: 20, to: 22 },
    ];
    // Typed on, a selection on a match stays there.
    expect(matchFrom(matches, { from: 10, to: 12 }, 0)).toBe(1);
    expect(matchFrom(matches, { from: 11, to: 11 }, 0)).toBe(2);
    expect(matchFrom(matches, { from: 10, to: 12 }, 1)).toBe(2);
    expect(matchFrom(matches, { from: 20, to: 22 }, 1)).toBe(0);
    expect(matchFrom(matches, { from: 10, to: 12 }, -1)).toBe(0);
    expect(matchFrom(matches, { from: 2, to: 4 }, -1)).toBe(2);
    expect(matchFrom([], { from: 0, to: 0 }, 1)).toBeNull();
    expect(stepped(3, 2, 1)).toBe(0);
    expect(stepped(3, 0, -1)).toBe(2);
    expect(stepped(3, null, -1)).toBe(2);
    expect(stepped(0, null, 1)).toBeNull();
  });

  it('says where it is among the matches', () => {
    expect(foundText({ count: 0, current: null }, '')).toBe('');
    expect(foundText({ count: 0, current: null }, 'x')).toBe('No matches');
    expect(foundText({ count: 12, current: 2 }, 'x')).toBe('3 of 12');
    expect(foundText({ count: 1, current: null }, 'x')).toBe('1 match');
    expect(foundText({ count: 4, current: null }, 'x')).toBe('4 matches');
  });

  it('opens with Cmd+F on Apple systems and Ctrl+F elsewhere, with no other key held', () => {
    const key = (held: Partial<KeyboardEvent>) => ({
      key: 'f',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...held,
    });
    expect(isFindKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isFindKey(key({ metaKey: true }), true)).toBe(true);
    expect(isFindKey(key({ key: 'F', ctrlKey: true }), false)).toBe(true);
    expect(isFindKey(key({ metaKey: true }), false)).toBe(false);
    expect(isFindKey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isFindKey(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    // Autofill sends keydown events with no key at all.
    expect(isFindKey({ ...key({ ctrlKey: true }), key: undefined }, false)).toBe(false);
  });
});
