import { findProperty, isPropertyName, propertyText, type PropertyData } from '@wikistow/client';
import type { LinkOption } from './link-completions';

// What either editor offers while a reference to one of the page's values
// is typed (`` `= ``): the page's keys a reference can name.

/** `` `= ``, Dataview's `this.` if typed, and the name so far, up to the cursor. */
export const TYPING_REFERENCE = /`=[ \t]*(?:this\.)?([\p{L}\p{N} _-]*)$/u;
/** What may follow the start of a name while it's still the one being typed. */
export const TYPING_NAME = /^[\p{L}\p{N} _-]*$/u;

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
