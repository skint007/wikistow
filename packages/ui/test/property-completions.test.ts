import { describe, expect, it } from 'vite-plus/test';
import { matchingProperties, TYPING_REFERENCE } from '../src/page/editor/property-completions.ts';

const option = (key: string) => ({
  label: key,
  displayLabel: key,
  detail: null,
  type: 'property' as const,
  text: key,
});
const labels = (keys: string[], typed: string) =>
  matchingProperties(keys.map(option), typed).map((found) => found.label);

describe('the keys a reference being typed offers', () => {
  it('reads a name being typed with combining marks', () => {
    expect(TYPING_REFERENCE.exec('Serves `=मूल्')?.groups?.['name']).toBe('मूल्');
    expect(TYPING_REFERENCE.exec('`=[[दाल]].ราคาที่')?.groups?.['name']).toBe('ราคาที่');
  });

  it('finds a key whether its accents are typed apart (NFD) or with the letter (NFC)', () => {
    const keys = ['café', 'café au lait', 'cake'];
    expect(labels(keys, 'café')).toEqual(['café', 'café au lait']);
    expect(labels(keys, 'café au')).toEqual(['café au lait']);
    // A letter typed before its accent.
    expect(labels(keys, 'cafe')).toEqual(['café', 'café au lait']);
    expect(labels(['मूल्य', 'मात्रा'], 'मूल्')).toEqual(['मूल्य']);
  });
});
