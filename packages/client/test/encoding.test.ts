import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { parseJson, parseJsonText, PAYLOAD_INTEGERS, utf8 } from '../src/index.ts';

// Built from parts so the source never holds the escape it tests.
const escaped = (hex4: string) => `\\${'u'}${hex4}`;

describe('strict JSON parsing', () => {
  it('agrees with JSON.parse on well-formed input', () => {
    const text = `{"a":[1,-2,0,3.5,1e3,true,false,null],"b":{"c":"x\\n\\"${escaped('00e9')}${escaped('d83d')}${escaped('de00')}"},"":""}`;
    expect(parseJsonText(text)).toEqual({
      value: JSON.parse(text),
      // Fractions parse, but are flagged for fields that must be integers.
      defects: [
        { path: ['a', 3], problem: 'number-token' },
        { path: ['a', 4], problem: 'number-token' },
      ],
    });
    expect(parseJsonText(' \t\n\r[] ').value).toEqual([]);
  });
});

describe('payload decoding', () => {
  const payload = (text: string) =>
    parseJson(z.unknown(), utf8(text), 'Payload', { integers: PAYLOAD_INTEGERS });
  const valid = '{"format":{"major":1,"minor":0},"attachments":[{"size":3}],"extensions":{}}';

  it('accepts a plain payload and keeps fractions outside integer fields', () => {
    expect(payload(valid)).toEqual(JSON.parse(valid));
    expect(payload('{"format":{"major":1,"minor":0},"extensions":{"x":{"ratio":0.5}}}')).toEqual({
      format: { major: 1, minor: 0 },
      extensions: { x: { ratio: 0.5 } },
    });
  });
});
