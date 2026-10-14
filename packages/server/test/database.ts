// Real-Postgres harness for integration tests. A global setup migrates one
// template database per run; each test file then clones its own copy, so files
// run in parallel without sharing rows, and overlapping runs don't collide.
import { inject } from 'vite-plus/test';
import { connect } from '../src/db/client.ts';
import { createMigratedDatabase, uniqueName, urlFor, withAdmin } from './postgres.ts';

declare module 'vite-plus/test' {
  export interface ProvidedContext {
    testTemplate: string;
  }
}

/** Build this run's template database. Returns its name and a function that drops it. */
export async function prepareTemplate(): Promise<{
  template: string;
  dropTemplate: () => Promise<void>;
}> {
  const { name: template, drop } = await createMigratedDatabase('wikistow_template');
  return {
    template,
    // Every file's database is named after the template, so the run drops
    // them all here, once, rather than each file inside its own time limit:
    // dropping a database waits for a checkpoint, which a busy disk makes slow.
    dropTemplate: async () => {
      const copies = await withAdmin(
        (sql) =>
          sql<{ name: string }[]>`select datname as name from pg_database
            where starts_with(datname, ${`${template}_f`})`,
      );
      for (const { name } of copies) {
        await withAdmin((sql) => sql.unsafe(`drop database if exists ${name} with (force)`));
      }
      await drop();
    },
  };
}

/**
 * A fresh, migrated database for one test file. Call `drop` in `afterAll`;
 * it closes the connections, and the run drops the database at the end.
 *
 *   const testDb = await createTestDatabase();
 *   afterAll(() => testDb.drop());
 */
export async function createTestDatabase() {
  const name = uniqueName(`${inject('testTemplate')}_f`);
  await withAdmin((sql) =>
    sql.unsafe(`create database ${name} template ${inject('testTemplate')}`),
  );
  const url = urlFor(name);
  const { db, close } = connect(url, { max: 4 });
  return {
    url,
    db,
    async drop() {
      await close();
    },
  };
}
