import {
  propertyWikilink,
  type PropertyData,
  type PropertyScalar,
  type PropertyValue,
} from './properties.ts';
import { withHeading } from './wikilink.ts';

// A property's value as one line of text (ADR 0006, decision 4): a list
// comma-separated, a date in a locale, a wikilink as the text it shows.
// Never HTML: what comes out is text for whoever shows it to escape.

/** How dates are written: in a locale and time zone (the runtime's where not given), or as written. */
export type PropertyTextOptions = {
  dates?: 'as-written' | { locale?: string | undefined; timeZone?: string | undefined };
};

const DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?: ?(Z|[+-]\d{2}(?::?\d{2})?))?)?$/;

/**
 * A date property's text (`2026-10-12`, or with a time) in `locale`. A day
 * alone, or a time with no zone, is the day and time as written, wherever
 * the reader is; a time with a zone (`Z`, `+02:00`) is that moment in
 * `timeZone`. Text that isn't such a date comes back as it is.
 */
export function formatPropertyDate(
  text: string,
  { locale, timeZone }: { locale?: string | undefined; timeZone?: string | undefined } = {},
): string {
  const [, year, month, day, hour, minute, second, zone] = DATE.exec(text) ?? [];
  if (year === undefined) return text;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (hour !== undefined) date.setUTCHours(Number(hour), Number(minute), Number(second ?? 0));
  if (zone !== undefined && zone !== 'Z') {
    const [, sign, hours, minutes = '0'] = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone) ?? [];
    const offset = (Number(hours) * 60 + Number(minutes)) * (sign === '-' ? -1 : 1);
    date.setTime(date.getTime() - offset * 60_000);
  }
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      ...(hour === undefined ? {} : { timeStyle: second === undefined ? 'short' : 'medium' }),
      // Only a moment in a zone is shown where the reader is.
      ...(zone === undefined ? { timeZone: 'UTC' } : timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    // A locale or time zone the runtime doesn't know.
    return text;
  }
}

/** A key in sentence case, as written otherwise: `cook_time` reads "Cook time". */
export function propertyLabel(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const [first = ''] = words;
  return words === '' ? key : first.toLocaleUpperCase() + words.slice(first.length);
}

const scalarText = (value: PropertyScalar) => (value === null ? '' : String(value));

/** The text a wikilink value shows: its own text, else its page and heading. */
export function wikilinkText(value: string): string {
  const link = propertyWikilink(value);
  return link ? (link.shown ?? withHeading(link.target, link.heading)) : value;
}

/**
 * A property's value as text: a list comma-separated (a list in it too),
 * a date as `formatPropertyDate` writes it unless `dates` is `as-written`,
 * a wikilink as the text it shows, an empty value as nothing.
 */
export function propertyText(
  { type, value }: Pick<PropertyData, 'type' | 'value'>,
  { dates = {} }: PropertyTextOptions = {},
): string {
  if (Array.isArray(value)) {
    return value
      .map((item: PropertyValue) =>
        Array.isArray(item) ? item.map(scalarText).join(', ') : scalarText(item as PropertyScalar),
      )
      .join(', ');
  }
  const scalar = value as PropertyScalar;
  if (type === 'date' && typeof scalar === 'string' && dates !== 'as-written') {
    return formatPropertyDate(scalar, dates);
  }
  if (type === 'wikilink' && typeof scalar === 'string') return wikilinkText(scalar);
  return scalarText(scalar);
}
