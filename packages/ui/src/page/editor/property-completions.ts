import {
  findProperty,
  foldPropertyName,
  isPropertyName,
  propertyText,
  type PropertyData,
} from '@wikistow/client';
import type { LinkOption } from './link-completions';

// What either editor offers while a reference to one of the page's values
// is typed (`` `= ``): the page's keys a reference can name.

/** `` `= ``, Dataview's `this.` if typed, and the name so far, up to the cursor. */
export const TYPING_REFERENCE = /`=[ \t]*(?:this\.)?([\p{L}\p{N} _-]*)$/u;

const DETAIL = 24;

/**
 * The keys a reference can name (`isPropertyName`, and the first a name
 * finds), each with its value beside it, in the block's order.
 */
export function propertyOptions(properties: readonly PropertyData[] | null): LinkOption[] {
  return (properties ?? []).flatMap((property) => {
    const name = property.key.trim();
    if (!isPropertyName(name) || findProperty(properties ?? [], name) !== property) return [];
    const value = propertyText(property);
    return [
      {
        label: name,
        displayLabel: name,
        detail: value.length > DETAIL ? `${value.slice(0, DETAIL - 1)}…` : value || null,
        type: 'property',
        text: name,
      } satisfies LinkOption,
    ];
  });
}

/**
 * The options whose key `typed` could be the start of, best first, matched
 * as a reference's name matches a key: whatever its case, with `_`, `-`
 * and spaces alike (`cook t` finds `cook_time`). A key starting so comes
 * first, then one with a word starting so, then one holding it, then one
 * holding its letters in order.
 */
export function matchingProperties(options: readonly LinkOption[], typed: string): LinkOption[] {
  const query = foldPropertyName(typed.trim());
  const rank = (option: LinkOption) => {
    const label = foldPropertyName(option.label);
    if (label.startsWith(query)) return 0;
    if (label.split(' ').some((word) => word.startsWith(query))) return 1;
    if (label.includes(query)) return 2;
    let at = 0;
    for (const char of query) {
      at = label.indexOf(char, at) + 1;
      if (at === 0) return null;
    }
    return 3;
  };
  return options
    .map((option, i) => ({ option, i, rank: rank(option) }))
    .filter((ranked) => ranked.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.i - b.i)
    .map(({ option }) => option);
}
