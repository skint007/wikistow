import { sql, type SQL } from 'drizzle-orm';

/**
 * `column` is one of `ids`, bound as one array parameter however many there
 * are, so a large subtree's IDs can't pass Postgres's limit of 65,535
 * parameters a statement, as `inArray` would with one each.
 */
export const anyId = (column: unknown, ids: readonly string[]): SQL =>
  sql`${column} = any(${sql.param([...ids])}::text[])`;
