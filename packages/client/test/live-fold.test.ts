// Folding a draft from outside a live session, and Review of what
// overlapped (ADR 0015 decision 8; protocol section 5.5, `wikistow.overlaps`).
import { describe, expect, it } from 'vite-plus/test';
import {
  carryChoices,
  foldPayloads,
  namespacesOf,
  reviewMerge,
  reviewTarget,
} from '../src/live/fold.ts';
import { PAYLOAD_FORMAT, type PagePayload } from '../src/payload.ts';

const page = (markdown: string, more: Partial<PagePayload> = {}): PagePayload => ({
  format: PAYLOAD_FORMAT,
  title: 'Soup',
  markdown,
  attachments: [],
  extensions: {},
  ...more,
});

describe('folding a draft from outside', () => {
  it('takes theirs where only they changed, and notes nothing', () => {
    const base = page('One.\n\nTwo.\n');
    const ours = page('One, ours.\n\nTwo.\n');
    const theirs = page('One.\n\nTwo, theirs.\n');
    const folded = foldPayloads(base, ours, theirs);
    expect(folded.target.body).toBe('One, ours.\n\nTwo, theirs.\n');
    expect(folded.parts).toEqual([]);
  });

  it('keeps ours where both changed a block, naming its place in theirs', () => {
    const base = page('One.\n\nTwo.\n');
    const ours = page('One.\n\nTwo, ours.\n');
    const theirs = page('Zero.\n\nOne.\n\nTwo, theirs.\n');
    const folded = foldPayloads(base, ours, theirs);
    expect(folded.target.body).toBe('Zero.\n\nOne.\n\nTwo, ours.\n');
    // Theirs' blocks: "Zero.", blank, "One.", blank, "Two, theirs." — the fifth.
    expect(folded.parts).toEqual(['body:4-5']);
  });

  it('names a deletion by the place theirs deleted at', () => {
    const base = page('One.\n\nTwo.\n\nThree.\n');
    const ours = page('One.\n\nTwo, ours.\n\nThree.\n');
    const theirs = page('One.\n\nThree.\n');
    const folded = foldPayloads(base, ours, theirs);
    expect(folded.target.body).toContain('Two, ours.');
    const [part] = folded.parts;
    expect(part).toMatch(/^body:(\d+)-\1$/);
  });

  it('names the title, a property by its place in theirs, and a namespace in code point order', () => {
    const base = page('---\na: 1\nb: 1\n---\nText.\n', {
      extensions: { 'x.\u{1F600}': 1, 'x.￿': 1 },
    });
    const ours = page('---\na: 1\nb: 2\n---\nText.\n', {
      title: 'Ours',
      extensions: { 'x.\u{1F600}': 2, 'x.￿': 1 },
    });
    const theirs = page('---\nb: 3\na: 1\n---\nText.\n', {
      title: 'Theirs',
      extensions: { 'x.\u{1F600}': 3, 'x.￿': 1 },
    });
    // By code point U+FFFF comes before U+1F600, which code units would put first.
    expect(namespacesOf(theirs)).toEqual(['x.￿', 'x.\u{1F600}']);
    const folded = foldPayloads(base, ours, theirs);
    expect(folded.parts).toEqual(['data:1', 'property:0', 'title']);
    expect(folded.target.title).toBe('Ours');
    expect(folded.target.extensions).toEqual({ 'x.\u{1F600}': 2, 'x.￿': 1 });
  });

  it('numbers a namespace over every one theirs has, those the document never holds too', () => {
    const links = { 'wikistow.links': { format: 1, links: [] } };
    const folded = foldPayloads(
      page('Text.\n', { extensions: { 'x.data': 1 } }),
      page('Text.\n', { extensions: { 'x.data': 2 } }),
      page('Text.\n', { extensions: { ...links, 'x.data': 3 } }),
    );
    // `wikistow.links` is theirs' first namespace, `x.data` its second.
    expect(folded.parts).toEqual(['data:1']);
  });

  it('leaves out what the document never holds, on every side', () => {
    const base = page('Text.\n');
    const ours = page('Text.\n');
    const theirs = page('Text.\n', {
      extensions: {
        'wikistow.links': { format: 1, links: [] },
        'wikistow.overlaps': { format: 1, revisions: [] },
        'wikistow.live': { format: 1 },
        'wikistow.change': { format: 1 },
      },
    });
    const folded = foldPayloads(base, ours, theirs);
    expect(folded.target.extensions).toEqual({});
    expect(folded.parts).toEqual([]);
  });
});

describe('Review', () => {
  const base = page('One.\n\nTwo.\n\nThree.\n');
  const theirs = page('One, theirs.\n\nTwo.\n\nThree, theirs.\n');

  it('offers only the parts its note names, and changes only those chosen', () => {
    const ours = page('One, ours.\n\nTwo.\n\nThree, ours.\n');
    const folded = foldPayloads(base, ours, theirs);
    expect(folded.parts).toEqual(['body:0-1', 'body:4-5']);
    // A note narrowed to the first part.
    const merge = reviewMerge(base, ours, theirs, ['body:0-1']);
    expect(merge.overlaps).toHaveLength(1);
    const [overlap] = merge.overlaps;
    if (!overlap) throw new Error('no overlap');
    const target = reviewTarget(merge, { [overlap.id]: 'theirs' });
    expect(target).toEqual({ body: 'One, theirs.\n\nTwo.\n\nThree, ours.\n' });
  });

  it('carries a choice to the page as it is now, by what it was about', () => {
    const ours = page('One, ours.\n\nTwo.\n\nThree, ours.\n');
    const chosen = reviewMerge(base, ours, theirs, ['body:0-1', 'body:4-5']);
    const [first, second] = chosen.overlaps;
    if (!first || !second) throw new Error('two overlaps');
    // Meanwhile someone changed the paragraph between them.
    const now = reviewMerge(base, page('One, ours.\n\nTwo, again.\n\nThree, ours.\n'), theirs, [
      'body:0-1',
      'body:4-5',
    ]);
    const choices = { [first.id]: 'theirs' as const, [second.id]: 'theirs' as const };
    expect(reviewTarget(now, carryChoices(chosen, choices, now))?.body).toBe(
      'One, theirs.\n\nTwo, again.\n\nThree, theirs.\n',
    );
    // Someone changed the third itself: the choice made before that doesn't replace it.
    const later = reviewMerge(base, page('One, ours.\n\nTwo.\n\nThree, ours again.\n'), theirs, [
      'body:0-1',
      'body:4-5',
    ]);
    expect(reviewTarget(later, carryChoices(chosen, choices, later))?.body).toBe(
      'One, theirs.\n\nTwo.\n\nThree, ours again.\n',
    );
  });

  it('offers nothing where the page now has theirs', () => {
    const merge = reviewMerge(base, theirs, theirs, ['body:0-1']);
    expect(merge.overlaps).toEqual([]);
  });

  it('keeps the page’s own ending, with no line break after its last block', () => {
    const merge = reviewMerge(
      page('One.\n\nTwo.'),
      page('One, ours.\n\nTwo.'),
      page('One, theirs.\n\nTwo.'),
      ['body:0-1'],
    );
    const [overlap] = merge.overlaps;
    if (!overlap) throw new Error('no overlap');
    expect(reviewTarget(merge, { [overlap.id]: 'theirs' })?.body).toBe('One, theirs.\n\nTwo.');
  });
});
