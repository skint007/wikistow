// The real-Postgres helpers clear away what killed runs left behind.
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vite-plus/test';
import {
  ABANDONED_AFTER_MS,
  createMigratedDatabase,
  datedName,
  uniqueName,
  urlFor,
  withAdmin,
} from './postgres.ts';

// A prefix of its own, so this sweeps nothing a real run made.
const PREFIX = 'wikistow_sweeptest';

const exists = async (name: string) =>
  withAdmin(async (sql) => {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    return rows.length > 0;
  });
const create = (name: string) => withAdmin((sql) => sql.unsafe(`create database ${name}`));

afterAll(async () => {
  await withAdmin(async (sql) => {
    const rows = await sql<{ name: string }[]>`select datname as name from pg_database
      where starts_with(datname, ${`${PREFIX}_`})`;
    for (const { name } of rows) {
      await sql.unsafe(`drop database if exists ${name} with (force)`);
    }
  });
});

describe('createMigratedDatabase', () => {
  it('drops what earlier runs left behind, and only that', async () => {
    const longAgo = Date.now() - ABANDONED_AFTER_MS - 60_000;
    const abandoned = datedName(PREFIX, longAgo);
    const abandonedCopy = uniqueName(`${abandoned}_f`);
    const inUse = datedName(PREFIX, longAgo);
    const recent = datedName(PREFIX);
    const undated = uniqueName(PREFIX);
    for (const name of [abandoned, abandonedCopy, inUse, recent, undated]) await create(name);

    const open = postgres(urlFor(inUse), { max: 1, onnotice: () => {} });
    await open`select 1`;
    try {
      const made = await createMigratedDatabase(PREFIX);
      expect(await exists(made.name)).toBe(true);
      await made.drop();
    } finally {
      await open.end({ timeout: 5 });
    }

    expect(await exists(abandoned)).toBe(false);
    expect(await exists(abandonedCopy)).toBe(false);
    expect(await exists(inUse)).toBe(true);
    expect(await exists(recent)).toBe(true);
    expect(await exists(undated)).toBe(true);
  });
});
