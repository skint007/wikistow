import type { z } from 'zod';

/** A stored row, named by its table and ID only, never by its content. */
export type StoredRow = { table: string; id: string };

/**
 * Where a listing reports a row it leaves out. Rows written under Milestone
 * 1's looser schemas can fail today's strict ones, and one such row must not
 * fail a whole listing, so it is skipped and reported instead.
 */
export type ReportUnreadable = (row: StoredRow) => void;

/** A stored JSON value read with `schema`, or `undefined` once `row` is reported. */
export function readStored<S extends z.ZodType>(
  schema: S,
  value: unknown,
  row: StoredRow,
  report: ReportUnreadable,
): z.output<S> | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  report(row);
  return undefined;
}
