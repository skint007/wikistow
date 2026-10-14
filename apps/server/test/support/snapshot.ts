// Everything the server keeps or says, for leak tests.
import { toBase64 } from '@wikistow/client';
import { sql } from 'drizzle-orm';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestApp } from './harness.ts';

/** Every table, every blob file, the request log, and every mail sent. */
export async function snapshot(t: TestApp): Promise<string> {
  const tables = await t.db.execute<{ name: string }>(
    sql`select tablename as name from pg_tables where schemaname = 'public'`,
  );
  const rows: Record<string, unknown> = {};
  for (const { name } of tables) {
    const [result] = await t.db.execute<{ rows: unknown }>(
      sql`select coalesce(json_agg(t), '[]'::json) as rows from ${sql.identifier(name)} t`,
    );
    rows[name] = result?.rows;
  }
  const files = await readdir(t.blobDir, { recursive: true, withFileTypes: true });
  const blobs = await Promise.all(
    files
      .filter((f) => f.isFile())
      .map(async (f) => toBase64(new Uint8Array(await readFile(join(f.parentPath, f.name))))),
  );
  return JSON.stringify({ rows, blobs, logs: t.logs, mails: t.mails });
}
