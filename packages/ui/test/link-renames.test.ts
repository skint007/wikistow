import { describe, expect, it } from 'vite-plus/test';
import { textEdits } from '../src/page/link-renames';

const OLD = 'See [[Plan]] here.\n\nThen [[Pruning#Dates]], and [[Plan|the plan]] [[Plan]].';
const NEXT =
  'See [[Roadmap]] here.\n\nThen [[Winter pruning#Dates]], and [[Plan|the plan]] [[Roadmap]].';

describe('a save that renamed links', () => {
  it('replaces each renamed link and nothing else', () => {
    const edits = textEdits(OLD, NEXT);
    const range = (source: string, from: number) => ({ from, to: from + source.length });
    expect(edits).toEqual([
      { ...range('[[Plan]]', OLD.indexOf('[[Plan]]')), insert: '[[Roadmap]]' },
      {
        ...range('[[Pruning#Dates]]', OLD.indexOf('[[Pruning')),
        insert: '[[Winter pruning#Dates]]',
      },
      { ...range('[[Plan]]', OLD.lastIndexOf('[[Plan]]')), insert: '[[Roadmap]]' },
    ]);
    // Applied in reverse, the edits make the new text.
    const apply = (old: string, next: string) =>
      textEdits(old, next).reduceRight(
        (text, { from, to, insert }) => text.slice(0, from) + insert + text.slice(to),
        old,
      );
    expect(apply(OLD, NEXT)).toBe(NEXT);
    // So do those of the span that differs, where the links don’t line up.
    for (const [old, next] of [
      ['abc [[A]] def', 'abc def'],
      ['[[A]] one', '[[B]] two'],
      ['[[A]]', '[[A]]]'],
      ['[[A\nB]]', '[[C\nB]]'],
    ] as const) {
      expect(apply(old, next), old).toBe(next);
    }
  });
});
