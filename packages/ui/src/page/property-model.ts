import {
  findProperty,
  isPropertyName,
  readProperties,
  setProperty,
  type Property,
  type PropertyScalar,
  type PropertyType,
  type PropertyValue,
} from '@wikistow/client';

// Property rows as the reader and the draft view show them (ADR 0006,
// decisions 2 and 3): what a key reads as, what a typed value is, and
// what a row's Type can turn a value into.

/** A key in sentence case, as written otherwise: `cook_time` reads "Cook time". */
export function propertyLabel(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const [first = ''] = words;
  return words === '' ? key : first.toLocaleUpperCase() + words.slice(first.length);
}

/** What each type is called in a row's Type menu, in the order it lists them. */
export const PROPERTY_TYPES: readonly { type: PropertyType; label: string }[] = [
  { type: 'text', label: 'Text' },
  { type: 'list', label: 'List' },
  { type: 'number', label: 'Number' },
  { type: 'boolean', label: 'Checkbox' },
  { type: 'date', label: 'Date' },
  { type: 'url', label: 'Web address' },
  { type: 'wikilink', label: 'Page link' },
];

/** What `value` reads as, written as a property: the type a row shows it as. */
export function typeOfValue(value: PropertyValue): PropertyType | null {
  const edit = setProperty(null, 'value', value);
  const read = edit.ok ? readProperties(edit.frontmatter) : null;
  return read?.ok ? (read.properties[0]?.type ?? null) : null;
}

/** Whether two values are the same, list items included. */
export function sameValue(a: PropertyValue, b: PropertyValue): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  return a.length === b.length && a.every((item, i) => sameValue(item, b[i] as PropertyValue));
}

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;

/**
 * `text` as a number, if it is one written out as a number writes it:
 * not `02134`, a code a number would drop the zero of, nor `1.50`, `1e3`
 * or a whole number past what a number holds exactly, which would be
 * written back otherwise.
 */
function numberIn(text: string): number | null {
  const trimmed = text.trim();
  if (!NUMBER.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) && String(number) === trimmed.replace(/^\+/, '') ? number : null;
}

const scalarText = (value: PropertyScalar) => (value === null ? '' : String(value));

/** A value as its field shows it to be edited: the text it is, nothing for none. */
export const fieldText = (value: PropertyValue) =>
  Array.isArray(value) ? '' : scalarText(value as PropertyScalar);

/**
 * What's typed in a value's field, as the value it is now: a number for a
 * number, else text as typed. A value with nothing in it yet has no type,
 * so a number or `true` typed there is that. An emptied field is an empty
 * value, unless it was empty text (`""`), which stays so.
 */
export function typedValue(text: string, was: PropertyValue): PropertyValue {
  if (text === '') return was === '' ? '' : null;
  if (typeof was === 'number' || was === null) {
    const number = numberIn(text);
    if (number !== null) return number;
  }
  if (was === null && /^(?:true|false)$/.test(text.trim())) return text.trim() === 'true';
  return text;
}

/** A list item as typed: a number in a list of numbers, else its text. */
export function typedItem(text: string, list: readonly unknown[]): PropertyScalar {
  const number = numberIn(text);
  return number !== null && list.length > 0 && list.every((item) => typeof item === 'number')
    ? number
    : text.trim();
}

// `value` written as `to`, or null when it can't be without losing what it
// says. A list of one item converts as that item.
function converted(value: PropertyValue, to: PropertyType): PropertyValue | null {
  if (to === 'list')
    return Array.isArray(value) ? null : value === null ? [] : [value as PropertyScalar];
  if (Array.isArray(value)) {
    if (to === 'text') {
      return value
        .map((item: PropertyValue) =>
          Array.isArray(item)
            ? item.map(scalarText).join(', ')
            : scalarText(item as PropertyScalar),
        )
        .join(', ');
    }
    const [only] = value;
    return value.length === 1 && !Array.isArray(only) ? converted(only ?? null, to) : null;
  }
  const scalar = value as PropertyScalar;
  switch (to) {
    case 'text':
      return scalarText(scalar);
    case 'number':
      return typeof scalar === 'string' ? numberIn(scalar) : null;
    case 'boolean':
      if (scalar === null || scalar === '') return false;
      return typeof scalar === 'string' && /^(?:true|false)$/i.test(scalar.trim())
        ? scalar.trim().toLowerCase() === 'true'
        : null;
    case 'wikilink':
      return typeof scalar === 'string' && scalar.trim() !== '' ? `[[${scalar.trim()}]]` : null;
    case 'date':
    case 'url':
      // A text that is one reads as one already; nothing else turns into one.
      return typeof scalar === 'string' ? scalar.trim() : null;
  }
}

/**
 * `value` written so that it reads as `to`, or null when it can't be: a
 * number `35` as text is `"35"`, text `soup` as a list is `[soup]`, text
 * `Tomato soup` as a page link is `"[[Tomato soup]]"`. Text reads as a date
 * or a web address only if it is one, and a date or a web address stays one
 * written as text.
 */
export function convertValue(value: PropertyValue, to: PropertyType): PropertyValue | null {
  const next = converted(value, to);
  return next !== null && typeOfValue(next) === to ? next : null;
}

/**
 * Whether `property` can go in the page as a reference, `` `=key` ``: its
 * key is a name a reference can hold, and the first key that name finds.
 */
export function referable(property: Property, properties: readonly Property[]): boolean {
  const name = property.key.trim();
  return isPropertyName(name) && findProperty(properties, name) === property;
}
