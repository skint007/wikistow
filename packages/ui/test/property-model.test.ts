import { readProperties, type Property } from '@wikistow/client';
import { describe, expect, it } from 'vite-plus/test';
import {
  convertValue,
  propertyLabel,
  referable,
  typedItem,
  typedValue,
  typeOfValue,
} from '../src/page/property-model.ts';

function properties(block: string): Property[] {
  const read = readProperties(block);
  if (!read.ok) throw new Error(read.reason);
  return read.properties;
}

describe('property rows', () => {
  it('shows a key in sentence case, the rest as written', () => {
    expect(propertyLabel('cook_time')).toBe('Cook time');
    expect(propertyLabel('cook-time')).toBe('Cook time');
    expect(propertyLabel('Cook Time')).toBe('Cook Time');
    expect(propertyLabel('  ISBN__number ')).toBe('ISBN number');
    expect(propertyLabel('élan')).toBe('Élan');
    expect(propertyLabel('___')).toBe('___');
  });

  it('reads a value as a row shows its type', () => {
    expect(typeOfValue('35')).toBe('text');
    expect(typeOfValue(35)).toBe('number');
    expect(typeOfValue('2026-10-12')).toBe('date');
    expect(typeOfValue('https://example.com')).toBe('url');
    expect(typeOfValue('[[Tomato soup]]')).toBe('wikilink');
    expect(typeOfValue(['a'])).toBe('list');
    expect(typeOfValue(false)).toBe('boolean');
  });

  it('takes what’s typed as the value’s own type, and a value with none yet as it reads', () => {
    expect(typedValue('40', 35)).toBe(40);
    expect(typedValue('about 40', 35)).toBe('about 40');
    expect(typedValue('40', 'thirty')).toBe('40');
    expect(typedValue('true', 'yes')).toBe('true');
    expect(typedValue('40', null)).toBe(40);
    expect(typedValue(' true ', null)).toBe(true);
    expect(typedValue('', 'soup')).toBe(null);
    expect(typedValue('', '')).toBe('');
    expect(typedItem('4', [1, 2])).toBe(4);
    expect(typedItem('4', ['a'])).toBe('4');
    expect(typedItem(' soup ', [])).toBe('soup');
  });

  it('turns a value into another type only where it reads as that type', () => {
    expect(convertValue(35, 'text')).toBe('35');
    expect(convertValue('35', 'number')).toBe(35);
    expect(convertValue('thirty', 'number')).toBe(null);
    expect(convertValue('soup', 'list')).toEqual(['soup']);
    expect(convertValue(null, 'list')).toEqual([]);
    expect(convertValue(['soup', 'bread'], 'text')).toBe('soup, bread');
    expect(convertValue(['35'], 'number')).toBe(35);
    expect(convertValue(['a', 'b'], 'number')).toBe(null);
    expect(convertValue('Tomato soup', 'wikilink')).toBe('[[Tomato soup]]');
    expect(convertValue('a ] b', 'wikilink')).toBe(null);
    expect(convertValue('TRUE', 'boolean')).toBe(true);
    expect(convertValue(null, 'boolean')).toBe(false);
    expect(convertValue('maybe', 'boolean')).toBe(null);
    expect(convertValue(true, 'text')).toBe('true');
    // A date or a web address is one whatever its quoting.
    expect(convertValue('2026-10-12', 'text')).toBe(null);
    expect(convertValue('soup', 'date')).toBe(null);
    expect(convertValue(['2026-10-12'], 'date')).toBe('2026-10-12');
  });

  it('puts in the page only a property a reference finds', () => {
    const read = properties('---\ncook_time: 25\nCook Time: 35\n"a.b": 1\n"pad ": 2\n---\n');
    expect(read.map((property) => referable(property, read))).toEqual([true, false, false, false]);
  });
});
