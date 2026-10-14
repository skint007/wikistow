import { describe, expect, it } from 'vite-plus/test';
import { forTerminal, toAsciiJson } from '../src/index.ts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CR = String.fromCharCode(0x0d);
const char = (codePoint: number) => String.fromCodePoint(codePoint);
const human = (text: string) => forTerminal(text, { utf8: true });
const ascii = (text: string) => forTerminal(text, { utf8: false });

describe('human output (section 12.3)', () => {
  it('escapes control sequences in a claimer name to the exact expected text', () => {
    const name = `Mallory${ESC}[8m hidden${ESC}[2A${CR}Bob`;
    expect(human(name)).toBe('Mallory\\u{1b}[8m hidden\\u{1b}[2A\\u{d}Bob');
    expect(ascii(name)).toBe(human(name));
  });
});

describe('--json output', () => {
  it('writes no raw control character but the line feeds between members', () => {
    const value = {
      title: `Notes${ESC}]52;c;x${BEL}`,
      lines: ['a\nb', `${char(0x1f372)}"\\`],
      none: null,
      ok: true,
    };
    const out = toAsciiJson(value);
    // Every character is printable ASCII or a structural line feed.
    expect(out.replaceAll('\n', '')).toMatch(/^[\x20-\x7e]*$/);
    expect(out).toContain('"Notes\\u001b]52;c;x\\u0007"');
    expect(out).toContain('"\\ud83c\\udf72\\"\\\\"');
    expect(JSON.parse(out)).toEqual(value);
  });
});
