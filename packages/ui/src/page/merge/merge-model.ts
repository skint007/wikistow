// The merge view's words and bookkeeping (ADR 0013, decisions 6 and 7),
// apart from drawing it.
import type { pageMerge } from '@wikistow/client';

type Merge = pageMerge.Merge;
type Overlap = pageMerge.Overlap;
type Offer = pageMerge.Offer;
export type Choice = pageMerge.Choice;
export type Choices = Readonly<Record<string, Choice>>;

/**
 * Whose the other version is: a person by name, the person's own (saved in
 * another tab, on another device, or as a chat edit they approved), this
 * device's other window, or one the app can't tell.
 */
export type Theirs =
  | { kind: 'person'; name: string }
  | { kind: 'self' }
  | { kind: 'window' }
  | { kind: 'unknown' };

/** How the merge view names theirs, in each place it does. */
export function theirsWords(theirs: Theirs) {
  switch (theirs.kind) {
    case 'person': {
      const whose = `${theirs.name}’s`;
      return { with: whose, whose, side: whose, use: `Use ${whose}`, draft: `${whose} draft` };
    }
    case 'self':
      return {
        with: 'your other version',
        whose: 'your other version’s',
        side: 'Other version',
        use: 'Use other version',
        draft: 'your other version',
      };
    case 'window':
      return {
        with: 'your other window',
        whose: 'your other window’s',
        side: 'Other window',
        use: 'Use other window',
        draft: 'your other window’s draft',
      };
    case 'unknown':
      return {
        with: 'the other version',
        whose: 'the other version’s',
        side: 'Other version',
        use: 'Use other version',
        draft: 'the other version',
      };
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "4 of your changes and 3 of Sam’s combined. You both changed 2 places." */
export function summaryOf(merge: Merge, theirs: Theirs): string {
  const { yours, theirs: other } = merge.combined;
  const { whose } = theirsWords(theirs);
  const parts: string[] = [];
  if (yours > 0 && other > 0)
    parts.push(`${yours} of your changes and ${other} of ${whose} combined.`);
  else if (yours > 0) parts.push(`${yours} of your changes combined.`);
  else if (other > 0) parts.push(`${other} of ${whose} changes combined.`);
  const places = merge.overlaps.length;
  if (places > 0) parts.push(`You both changed ${plural(places, 'place', 'places')}.`);
  return parts.join(' ');
}

/** What an overlap is about, for its heading: the heading it sits under, or the field. */
export function overlapPlace(overlap: Overlap): string | null {
  switch (overlap.part) {
    case 'body':
      return overlap.under;
    case 'title':
      return 'Title';
    case 'property':
      return overlap.key;
    case 'frontmatter':
      return 'Properties';
    case 'banner':
      return 'Banner';
    case 'icon':
      return 'Icon';
    case 'data':
      return `Data ${overlap.namespace ?? ''}`.trim();
  }
}

/** Which choice a button makes. */
export const offerOf = (choice: Choice): Offer => (typeof choice === 'object' ? 'edit' : choice);

/** The choices made that the merge still asks for, as `resolve` may replace some overlaps. */
export function keptChoices(merge: Merge, choices: Choices): Record<string, Choice> {
  const kept: Record<string, Choice> = {};
  for (const overlap of merge.overlaps) {
    const choice = choices[overlap.id];
    if (choice !== undefined && overlap.offers.includes(offerOf(choice))) kept[overlap.id] = choice;
  }
  return kept;
}

/** One line under the review for what else the merge changes in theirs. */
export function fieldLine(field: pageMerge.ReviewField): string {
  switch (field.part) {
    case 'title':
      return `Title: ${field.to}`;
    case 'banner':
      return 'Banner: yours';
    case 'icon':
      return 'Icon: yours';
    case 'attachments': {
      const parts = [
        field.added > 0 && `${field.added} added`,
        field.removed > 0 && `${field.removed} taken out`,
      ].filter((part) => typeof part === 'string');
      return `Attachments: ${parts.join(', ')}`;
    }
    case 'data':
      return `Data ${field.namespace}: yours`;
  }
}

/**
 * An unchanged run of the review, folded: the line next to each change
 * stays shown, for context, and the rest is one "⋯ N unchanged lines".
 */
export function foldSame(
  text: string,
  { first, last }: { first: boolean; last: boolean },
): { before: string[]; folded: string[]; after: string[] } {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length <= 3) return { before: lines, folded: [], after: [] };
  const before = first ? [] : lines.slice(0, 1);
  const after = last ? [] : lines.slice(-1);
  return { before, folded: lines.slice(before.length, lines.length - after.length), after };
}
