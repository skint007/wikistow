import { describe, expect, it } from 'vite-plus/test';
import { fillTemplate, formatDate, templateFields } from '../src/index.ts';
import { cpuTime, growth } from './support/timing.ts';

const values = (asked: Record<string, string>) => ({
  title: 'Dal',
  me: 'Asha',
  now: new Date(2026, 9, 25, 14, 5),
  asked,
});

describe('a template variable’s name', () => {
  it('takes combining marks after its first letter or digit, as a reference’s does', () => {
    const text = '{{मूल्य}} {{ราคาที่ดี}} {{café|noir}}';
    expect(templateFields(text).map((field) => field.label)).toEqual(['मूल्य', 'ราคาที่ดี', 'café']);
    expect(fillTemplate(text, values({ मूल्य: '40', ราคาที่ดี: '5' }))).toBe('40 5 noir');
  });

  it('asks once for a name whether its accents are typed apart (NFD) or with the letter (NFC)', () => {
    const text = '{{Café}} and {{café}}';
    const fields = templateFields(text);
    expect(fields).toHaveLength(1);
    expect(fillTemplate(text, values({ [fields[0]?.key ?? '']: 'noir' }))).toBe('noir and noir');
  });

  it('leaves braces whose name starts with a mark as written', () => {
    const text = '{{́e}} {{िकीमत}}';
    expect(templateFields(text)).toEqual([]);
    expect(fillTemplate(text, values({}))).toBe(text);
  });

  it('is read in time linear in a long run of marks', () => {
    expect(cpuTime(() => templateFields(`{{a${'\u0301'.repeat(200_000)}`)).ms).toBeLessThan(500);
    expect(cpuTime(() => templateFields('{{a\u0301 '.repeat(50_000))).ms).toBeLessThan(500);
  });
});

describe('reading a template’s variables', () => {
  // How variables were read before #198, kept as it was: the pattern, and
  // what each match stands for. The new reading must give the same.
  const BEFORE = /\{\{\s*([\p{L}\p{N}][\p{L}\p{M}\p{N} _-]*?)\s*(?:([|:])([^}\n]*))?\}\}/gu;
  type Before =
    | { kind: 'asked'; key: string; label: string; initial: string }
    | { kind: 'date' | 'time'; format: string }
    | { kind: 'title' | 'me' };
  const variableBefore = (name: string, mark: string | undefined, rest = ''): Before | null => {
    const label = name.normalize('NFC').replace(/\s+/g, ' ');
    const key = label.toLowerCase();
    if (key === 'date' || key === 'time') {
      if (mark === '|') return null;
      return { kind: key, format: rest.trim() || (key === 'date' ? 'YYYY-MM-DD' : 'HH:mm') };
    }
    if (key === 'title' || key === 'me') return mark === undefined ? { kind: key } : null;
    if (mark === ':') return null;
    return { kind: 'asked', key, label, initial: rest.trim() };
  };
  // Every asked value names its key, so a variable read with other bounds or another name shows.
  const named = {
    ...values({}),
    asked: new Proxy({}, { get: (_, key) => `«${String(key)}»` }),
  };
  const filledBefore = (text: string) =>
    text.replace(BEFORE, (match, name: string, mark?: string, rest?: string) => {
      const variable = variableBefore(name, mark, rest);
      if (variable === null) return match;
      if (variable.kind === 'date' || variable.kind === 'time')
        return formatDate(named.now, variable.format);
      if (variable.kind === 'asked') return `«${variable.key}»`;
      return variable.kind === 'title' ? named.title : named.me;
    });
  const fieldsBefore = (text: string) => {
    const fields = new Map<string, { key: string; label: string; initial: string }>();
    for (const [, name = '', mark, rest] of text.matchAll(BEFORE)) {
      const variable = variableBefore(name, mark, rest);
      if (variable?.kind === 'asked' && !fields.has(variable.key)) {
        const { key, label, initial } = variable;
        fields.set(key, { key, label, initial });
      }
    }
    return [...fields.values()];
  };

  const cases = [
    '{{name}}',
    '{{ name }}',
    '{{\n name \t}}',
    '{{name|default}}',
    '{{ Cook  time | 40 min }}',
    '{{date}} {{date:dddd D MMMM}} {{time:HH:mm}}',
    '{{title}} by {{me}}',
    '{{date|x}} {{title:x}} {{me|x}} {{name:x}}',
    '{{#each}} {{ }} {{}} {{a b|}}',
    '{{{a}}} {{a}}}',
    '{{a|{{b}}',
    '{{a|{{b\n|x}}',
    '{{a|b}c}} {{a|b\nc}} {{a b\tc}}',
    '{{a  ',
    '{{a|',
    '{{café|noir}} {{a\u0301 }} {{x_y-z 1}}',
  ];

  it('finds the variables it found before', () => {
    for (const text of cases) {
      expect(fillTemplate(text, named), text).toBe(filledBefore(text));
      expect(templateFields(text), text).toEqual(fieldsBefore(text));
    }
    expect(fillTemplate('{{a|{{b}} {{ Cook  time | 40 min }}', values({}))).toBe('{{b 40 min');
  });

  it('finds the variables it found before in random text', () => {
    // A seeded random number generator (mulberry32), so a failure can be run again.
    let seed = 196;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
    const pieces = [
      '{{',
      '}}',
      '{',
      '}',
      '|',
      ':',
      ' ',
      '  ',
      '\n',
      '\t',
      '\u00a0',
      'a',
      'Bé',
      '1',
    ];
    pieces.push('_', '-', '\u0301', '#', 'date', 'title', 'me', 'x y', 'YYYY');
    // Whole openings and closings, so about half the texts hold one, and a fifth several.
    pieces.push('{{a|', '{{b:', '{{date:', '{{ c ', 'x}}', '}}', '|y}}');
    for (let run = 0; run < 20_000; run++) {
      const length = Math.floor(random() * 16);
      const text = Array.from({ length }, () => pieces[Math.floor(random() * pieces.length)]).join(
        '',
      );
      expect(fillTemplate(text, named), JSON.stringify(text)).toBe(filledBefore(text));
      expect(templateFields(text), JSON.stringify(text)).toEqual(fieldsBefore(text));
    }
  });

  // 8 times the text; quadratic would be 64.
  it('takes time linear in a run of spaces after a name', () => {
    const spaces = (n: number) => `{{a${' '.repeat(n)}`;
    expect(cpuTime(() => templateFields(spaces(200_000))).ms).toBeLessThan(500);
    expect(cpuTime(() => fillTemplate(spaces(200_000), named)).ms).toBeLessThan(500);
    expect(growth((text) => templateFields(text), spaces(500_000), spaces(4_000_000))).toBeLessThan(
      24,
    );
  });

  it('takes time linear in a line of defaults that no `}}` closes', () => {
    const openings = (n: number) => '{{a|'.repeat(n);
    expect(cpuTime(() => templateFields(openings(50_000))).ms).toBeLessThan(500);
    expect(cpuTime(() => fillTemplate(openings(50_000), named)).ms).toBeLessThan(500);
    expect(
      growth((text) => templateFields(text), openings(40_000), openings(320_000)),
    ).toBeLessThan(24);
    // Closed, on separate lines, and a format's mark.
    expect(templateFields(`${'{{a:'.repeat(50_000)}}}`)).toEqual([]);
    expect(templateFields(`${'{{a|\n'.repeat(50_000)}{{b}}`).map(({ key }) => key)).toEqual(['b']);
  });
});
