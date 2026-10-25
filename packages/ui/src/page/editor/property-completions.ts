import {
  findProperty,
  foldPropertyName,
  isPropertyName,
  parsePropertyReference,
  propertyText,
  type PropertyData,
} from '@wikistow/client';
import type { LinkOption } from './link-completions';
import type { OtherPages } from '../other-pages';

// What either editor offers while a reference to a value is typed: after
// `` `= ``, the page's keys a reference can name; after `` `=[[ ``, the
// pages a link names, as for a link; after `` `=[[Page]]. ``, that page's
// keys, as the editor's index has them.

/**
 * `` `= ``, Dataview's `this.` or a page's link and a dot if typed, and the
 * name so far, up to the cursor: the link is group `page`, the name `name`.
 */
export const TYPING_REFERENCE =
  /`=[ \t]*(?:this\.|(?<page>\[\[[^[\]\r\n]+\]\])\.)?(?<name>[\p{L}\p{M}\p{N} _-]*)$/u;

/** Text before `[[` that makes the link a reference's page: `` `= ``. */
export const REFERENCE_PAGE = /`=[ \t]*$/;

/**
 * The keys a reference being typed can name, as `TYPING_REFERENCE` matched
 * it: this page's, or those of the page its link names, from `others`. None
 * for a link a reference can't name, or a page not found (yet).
 */
export function referenceOptions(
  typed: RegExpExecArray,
  properties: readonly PropertyData[] | null,
  others: OtherPages | null,
): LinkOption[] {
  const source = typed.groups?.['page'];
  if (source === undefined) return propertyOptions(properties);
  const page = parsePropertyReference(`=${source}.x`)?.page;
  const other = page && others?.(page);
  return other?.kind === 'page' ? propertyOptions(other.properties) : [];
}

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
  // Decomposed, so a letter typed before its accent finds the key with both.
  const fold = (name: string) => foldPropertyName(name).normalize('NFD');
  const query = fold(typed.trim());
  const rank = (option: LinkOption) => {
    const label = fold(option.label);
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
