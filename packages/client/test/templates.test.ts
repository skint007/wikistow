import { describe, expect, it } from 'vite-plus/test';
import { fillTemplate, templateFields } from '../src/index.ts';
import { cpuTime } from './support/timing.ts';

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
