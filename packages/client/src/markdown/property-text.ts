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

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * `timeZone`'s offset from UTC at `moment`, in minutes, or null where the
 * runtime doesn't know the zone, or its offset then isn't whole minutes
 * (a zone's local mean time before standard time).
 */
function offsetAt(moment: number, timeZone: string | undefined): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(moment)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (name === 'GMT') return 0;
    const [, sign, hours, minutes] = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? '') ?? [];
    if (sign === undefined) return null;
    return (Number(hours) * 60 + Number(minutes)) * (sign === '-' ? -1 : 1);
  } catch {
    return null;
  }
}

/**
 * A date property's text as a query table's cell shows it, written so that
 * a query reads it back as the same day or moment (#649): copied into
 * `where: due = …`, it matches its row. A day alone, and a time with no
 * zone, which a query reads as UTC, as written (`2026-10-12`,
 * `2026-10-12 18:30`). A time with a zone is that moment in `timeZone`
 * (the runtime's where not given), with the offset that zone has then:
 * `2026-10-13 04:30 +10:00`. Either is to the minute, or the second where
 * written with seconds. Text a query doesn't read as a date, or a moment
 * that can't be shown so, comes back as it is.
 */
export function queryDateText(
  text: string,
  { timeZone }: { timeZone?: string | undefined } = {},
): string {
  const [, year, month, day, hour, minute, second, zone] = DATE.exec(text) ?? [];
  if (year === undefined) return text;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  // A day the calendar hasn't, or a time the clock hasn't, a query reads as text.
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return text;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return text;
  const written = `${year}-${month}-${day}`;
  if (hour === undefined) return written;
  const seconds = (at: number) => (second === undefined ? '' : `:${pad(at)}`);
  if (zone === undefined) return `${written} ${hour}:${minute}${seconds(Number(second))}`;
  date.setUTCHours(Number(hour), Number(minute), Number(second ?? 0));
  if (zone !== 'Z') {
    const [, sign, hours, minutes = '0'] = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone) ?? [];
    const offset = (Number(hours) * 60 + Number(minutes)) * (sign === '-' ? -1 : 1);
    date.setTime(date.getTime() - offset * 60_000);
  }
  const offset = offsetAt(date.getTime(), timeZone);
  if (offset === null) return text;
  const there = new Date(date.getTime() + offset * 60_000);
  const shownYear = there.getUTCFullYear();
  if (shownYear < 0 || shownYear > 9999) return text;
  const away = Math.abs(offset);
  return (
    `${pad(shownYear, 4)}-${pad(there.getUTCMonth() + 1)}-${pad(there.getUTCDate())} ` +
    `${pad(there.getUTCHours())}:${pad(there.getUTCMinutes())}${seconds(there.getUTCSeconds())} ` +
    `${offset < 0 ? '-' : '+'}${pad(Math.floor(away / 60))}:${pad(away % 60)}`
  );
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
