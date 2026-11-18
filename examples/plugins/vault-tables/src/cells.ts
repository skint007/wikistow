// What each cell of a table drawn from host.pages.query shows: a property's
// value by name, or for Dataview's file.mtime when the row's version was
// saved. Pure, so the example's tests read it without drawing the table.

import type { PageRow, PropertyValue } from '@wikistow/plugin-sdk';
import { MTIME } from './dql';

/** A property's value by name, as `=name` finds it: whatever its case, with `_`, `-` and spaces alike. */
function valueOf(row: PageRow, name: string): PropertyValue | undefined {
  if (Object.hasOwn(row.properties, name)) return row.properties[name];
  const fold = (key: string) => key.toLowerCase().replace(/[_\s-]+/g, ' ');
  const key = Object.keys(row.properties).find((other) => fold(other) === fold(name));
  return key === undefined ? undefined : row.properties[key];
}

/** When the row's version was saved, in the reader's time zone, or a dash when not known. */
function saved(row: PageRow): string {
  const at = row.updated ? new Date(row.updated) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';
}

const shown = (value: PropertyValue | undefined): string =>
  value === undefined || value === null || value === ''
    ? '—'
    : Array.isArray(value)
      ? value.map((item) => (Array.isArray(item) ? item.join(', ') : String(item))).join(', ')
      : String(value);

/** The text of `row`'s cell in the column showing `name`: `file.mtime` its saved time, else the property. */
export const cellText = (row: PageRow, name: string): string =>
  name === MTIME ? saved(row) : shown(valueOf(row, name));
