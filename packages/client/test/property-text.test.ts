import { describe, expect, it } from 'vite-plus/test';
import { formatPropertyDate, propertyText, wikilinkText } from '../src/index.ts';

const US = { locale: 'en-US', timeZone: 'America/New_York' };

describe('a property value as text', () => {
  it('writes a day in the locale, the day as written wherever the reader is', () => {
    expect(formatPropertyDate('2026-10-12', US)).toBe('Oct 12, 2026');
    expect(
      formatPropertyDate('2026-10-12', { locale: 'de-DE', timeZone: 'Pacific/Kiritimati' }),
    ).toBe('12.10.2026');
    // Years before 100 aren't taken for the 1900s.
    expect(formatPropertyDate('0042-01-02', US)).toBe('Jan 2, 42');
  });

  it('writes a time with no zone as written, and one with a zone where the reader is', () => {
    expect(formatPropertyDate('2026-10-12T18:30', US)).toBe('Oct 12, 2026, 6:30 PM');
    expect(formatPropertyDate('2026-10-12 18:30:15', US)).toBe('Oct 12, 2026, 6:30:15 PM');
    expect(formatPropertyDate('2026-10-12T18:30Z', US)).toBe('Oct 12, 2026, 2:30 PM');
    expect(formatPropertyDate('2026-10-12T18:30+02:00', US)).toBe('Oct 12, 2026, 12:30 PM');
    expect(formatPropertyDate('2026-10-12T18:30 -0130', US)).toBe('Oct 12, 2026, 4:00 PM');
  });

  it('gives back text that isn’t a date, or that the runtime can’t write in that locale', () => {
    expect(formatPropertyDate('soon', US)).toBe('soon');
    expect(formatPropertyDate('2026-10-12', { locale: 'en-US', timeZone: 'Nowhere/Else' })).toBe(
      'Oct 12, 2026',
    );
    expect(formatPropertyDate('2026-10-12T01:00Z', { timeZone: 'Nowhere/Else' })).toBe(
      '2026-10-12T01:00Z',
    );
  });

  it('writes a list comma-separated, a list in it too, and an empty value as nothing', () => {
    expect(propertyText({ type: 'list', value: ['soup', 4, true, null, ['a', 'b']] })).toBe(
      'soup, 4, true, , a, b',
    );
    expect(propertyText({ type: 'list', value: [] })).toBe('');
    expect(propertyText({ type: 'text', value: null })).toBe('');
    expect(propertyText({ type: 'number', value: 4.5 })).toBe('4.5');
    expect(propertyText({ type: 'boolean', value: false })).toBe('false');
  });

  it('writes a date as written when asked, and a wikilink as the text it shows', () => {
    expect(propertyText({ type: 'date', value: '2026-10-12' }, { dates: 'as-written' })).toBe(
      '2026-10-12',
    );
    expect(propertyText({ type: 'date', value: '2026-10-12' }, { dates: US })).toBe('Oct 12, 2026');
    expect(propertyText({ type: 'wikilink', value: '[[Tomato soup]]' })).toBe('Tomato soup');
    expect(propertyText({ type: 'wikilink', value: '[[Tomato soup#Serving|the soup]]' })).toBe(
      'the soup',
    );
    expect(wikilinkText('[[Tomato soup#Serving]]')).toBe('Tomato soup › Serving');
    expect(wikilinkText('not a link')).toBe('not a link');
  });
});
