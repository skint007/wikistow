// Real-Postgres helpers with no test-runner dependency, so the browser tests'
// server can use them as well as Vitest's integration setup.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { migrateDatabase } from '../src/db/client.ts';

/** Matches `compose.yaml`. CI sets TEST_DATABASE_URL to its Postgres service. */
const LOCAL_DEFAULT = 'postgres://wikistow:wikistow@127.0.0.1:5433/postgres';

export const uniqueName = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;

/**
 * A run killed before its teardown, as Ctrl+C or a stopped agent does, leaves
 * its databases behind. One older than this is taken to be such a leftover:
 * no test run lasts a day.
 */
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** `<prefix>_<when, in base-36 milliseconds>_<random>`, so a later run can tell its age. */
export const datedName = (prefix: string, at = Date.now()) =>
  uniqueName(`${prefix}_${at.toString(36)}`);

/**
 * Drop the databases an earlier run made with `prefix` and left behind: those
 * older than ABANDONED_AFTER_MS, and the copies named after them. A database
 * something is still connected to stays, as do names without a date.
 */
export async function dropAbandoned(prefix: string): Promise<void> {
  const names = await withAdmin(
    (sql) =>
      sql<{ name: string }[]>`select datname as name from pg_database
        where starts_with(datname, ${`${prefix}_`})`,
  );
  const cutoff = Date.now() - ABANDONED_AFTER_MS;
  for (const { name } of names) {
    const made = /^([0-9a-z]+)_[0-9a-f]{12}(?:_|$)/.exec(name.slice(prefix.length + 1));
    if (!made?.[1] || Number.parseInt(made[1], 36) > cutoff) continue;
    try {
      await withAdmin((sql) => sql.unsafe(`drop database if exists ${name}`));
    } catch (error) {
      // 55006, object_in_use: something still has it open, so it isn't abandoned.
      if ((error as { code?: unknown }).code !== '55006') throw error;
    }
  }
}

const adminUrl = () => process.env['TEST_DATABASE_URL'] ?? LOCAL_DEFAULT;

export function urlFor(database: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

/** Run `fn` with a short-lived connection to the maintenance database. */
export async function withAdmin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Wait for Postgres, since CI services start alongside the step. */
async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await withAdmin((sql) => sql`select 1`);
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          'Postgres is unreachable. Run `docker compose up -d db` or set TEST_DATABASE_URL.',
          { cause: error },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** A new, fully migrated database, and a function that drops it. */
export async function createMigratedDatabase(prefix: string) {
  await waitForPostgres();
  await dropAbandoned(prefix);
  const name = datedName(prefix);
  await withAdmin((sql) => sql.unsafe(`create database ${name}`));
  const url = urlFor(name);
  await migrateDatabase(url);
  return {
    name,
    url,
    drop: () =>
      withAdmin((sql) => sql.unsafe(`drop database if exists ${name} with (force)`)).then(() => {}),
  };
}
