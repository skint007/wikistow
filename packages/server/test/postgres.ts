// Real-Postgres helpers with no test-runner dependency, so the browser tests'
// server can use them as well as Vitest's integration setup.
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { migrateDatabase } from '../src/db/client.ts';

/** Matches `compose.yaml`. CI sets TEST_DATABASE_URL to its Postgres service. */
const LOCAL_DEFAULT = 'postgres://wikistow:wikistow@127.0.0.1:5433/postgres';

export const uniqueName = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`;

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
  const name = uniqueName(prefix);
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
