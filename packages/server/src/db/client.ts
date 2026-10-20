import type { PgDatabase } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import * as schema from './schema/index.ts';

/**
 * A connection pool or an open transaction. Query functions take this, so the
 * same code runs standalone or inside a caller's transaction.
 */
export type Database = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

/** The SQL migrations shipped with this package. The image copies this folder. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Open a pool. Call `close` on shutdown so in-flight queries finish. */
export function connect(url: string, { max = 10 }: { max?: number } = {}) {
  const sql = postgres(url, { max, onnotice: () => {} });
  const db: Database = drizzle({ client: sql, schema, casing: 'snake_case' });
  return { db, close: () => sql.end({ timeout: 5 }) };
}

/** The tree listener's session, as `pg_stat_activity` names it. */
export const TREE_LISTENER_APPLICATION = 'wikistow-tree-changes';

/**
 * Call `onChange` with a space's ID after each committed change to its tree,
 * once per space and transaction, until `close`. The `wikistow_tree_changed`
 * trigger names it (migration 0034); nothing says what changed. postgres.js
 * listens on a connection of its own, which stays open, and listens again if
 * that one drops. Changes made while it is down are missed.
 */
export async function listenForTreeChanges(url: string, onChange: (spaceId: string) => void) {
  const sql = postgres(url, {
    max: 1,
    connection: { application_name: TREE_LISTENER_APPLICATION },
    onnotice: () => {},
  });
  await sql.listen('wikistow_tree', onChange);
  return { close: () => sql.end({ timeout: 5 }) };
}

/**
 * The advisory lock that marks the database as in use by WikiStow: "wikistow"
 * in ASCII, read as a 64-bit integer. The server, migrations and the admin
 * CLI hold it shared, so they run side by side. `scripts/restore.sh` takes it
 * exclusively, so it refuses while any of them runs, and they refuse to start
 * while it does. The script has its own copy of the key; keep them the same.
 */
export const DATABASE_LOCK_KEY = '8604526663720791927';

/**
 * The advisory lock migrations take, on top of the database lock, while they
 * apply: "wikimigr" in ASCII. Drizzle reads which migrations were applied
 * before its transaction, so two runs at once, such as `migrate.mjs` and a
 * server starting, would both apply the pending ones. This makes the second
 * wait for the first, then find nothing to do. A restore never takes it.
 */
const MIGRATION_LOCK_KEY = '8604526663619405682';

/** The lock's session, as `pg_stat_activity` names it. */
export const DATABASE_LOCK_APPLICATION = 'wikistow-lock';

/** A restore holds the database lock, so nothing else may use the database yet. */
export class DatabaseLockedError extends Error {
  constructor() {
    super('A restore is using the database. Start WikiStow again once it finishes.');
    this.name = 'DatabaseLockedError';
  }
}

/**
 * Take the database lock shared, on a connection of its own, and hold it until
 * `release`. Throws DatabaseLockedError if a restore holds it. Postgres drops
 * the lock with the session, so nothing in the environment or `url` may make
 * this connection close for being idle or old, as pooled ones may: postgres.js
 * reads PGIDLE_TIMEOUT and `?idle_timeout=` unless told, and a URL parameter
 * such as `?idle_session_timeout=` reaches Postgres itself. If it drops anyway,
 * `onLost` runs: the lock is gone, and a restore may already have taken it.
 * `migrate` applies pending migrations in the lock's own session, so a restore
 * can't come between them and whatever runs next under the lock, holding
 * MIGRATION_LOCK_KEY meanwhile.
 */
export async function lockDatabase(url: string, { onLost }: { onLost?: () => void } = {}) {
  let held = false;
  const sql = postgres(url, {
    max: 1,
    // Never, as with null below; its type only allows a number.
    idle_timeout: 0,
    max_lifetime: null,
    connection: { application_name: DATABASE_LOCK_APPLICATION },
    onnotice: () => {},
    onclose: () => {
      if (!held) return;
      held = false;
      onLost?.();
    },
  });
  const release = async () => {
    held = false;
    await sql.end({ timeout: 5 });
  };
  try {
    // Set here too, as parameters in `url` override the connection's own.
    const [row] = await sql<{ locked: boolean }[]>`
      select set_config('application_name', ${DATABASE_LOCK_APPLICATION}, false),
        set_config('idle_session_timeout', '0', false),
        pg_try_advisory_lock_shared(${DATABASE_LOCK_KEY}::bigint) as locked`;
    held = row?.locked === true;
  } catch (error) {
    await release();
    throw error;
  }
  if (!held) {
    await release();
    throw new DatabaseLockedError();
  }
  return {
    release,
    migrate: async (migrationsFolder = MIGRATIONS_DIR) => {
      // Waits, unlike the database lock: the other run finishes soon.
      await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
      try {
        await migrate(drizzle({ client: sql }), { migrationsFolder });
      } finally {
        await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
      }
    },
  };
}

/**
 * Apply pending migrations, holding the database lock, so they never run
 * under a restore. Applied ones are skipped, and runs at once take turns, so
 * running it again, or beside a starting server, is harmless.
 */
export async function migrateDatabase(
  url: string,
  migrationsFolder = MIGRATIONS_DIR,
): Promise<void> {
  const lock = await lockDatabase(url);
  try {
    await lock.migrate(migrationsFolder);
  } finally {
    await lock.release();
  }
}
