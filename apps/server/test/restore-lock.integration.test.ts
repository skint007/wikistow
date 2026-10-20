// A restore and a server never run on one database at once (docs/operations.md,
// "Restoring"). The server holds an advisory lock shared, on a connection it
// keeps open, and scripts/restore.sh takes it exclusively for the whole
// restore. These start the real server, src/main.ts, in a process of its own.
// The scripts need pg_dump, pg_restore and psql 17 on PATH. Without them this fails.
import {
  connect,
  DATABASE_LOCK_APPLICATION,
  DATABASE_LOCK_KEY,
  DatabaseLockedError,
  migrateDatabase,
  TREE_LISTENER_APPLICATION,
} from '@wikistow/server';
import { createTestDatabase } from '@wikistow/server/testing';
import { withAdmin } from '@wikistow/server/testing/postgres';
import { sql, type SQL } from 'drizzle-orm';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vite-plus/test';
import { testAppOn, type TestApp } from './support/harness.ts';
import { script } from './support/scripts.ts';
import { startServer } from './support/server.ts';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let t: TestApp;
let backups: string;
let backup: string;
const nameOf = (url: string) => new URL(url).pathname.slice(1);
const database = () => nameOf(testDb.url);

/** The client sessions open on the test database, by application name. */
const sessions = () =>
  withAdmin(
    (sql) => sql<{ name: string }[]>`select application_name as name from pg_stat_activity
      where datname = ${database()} and backend_type = 'client backend'`,
  );

/** The sessions holding the database lock, and how. */
const lockHolders = () =>
  withAdmin(
    (sql) => sql<{ pid: number; mode: string; name: string }[]>`
      select l.pid, l.mode, a.application_name as name
      from pg_locks l
        join pg_database d on d.oid = l.database
        join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory' and l.granted and d.datname = ${database()}
        and (l.classid::bigint << 32 | l.objid::bigint) = ${DATABASE_LOCK_KEY}::bigint
        and l.objsubid = 1`,
  );

/**
 * Run `query` on `url`'s database, on a connection closed after, as a restore
 * refuses while one is open.
 */
async function queryOn<T extends Record<string, unknown>>(url: string, query: SQL) {
  const { db, close } = connect(url, { max: 1 });
  try {
    return await db.execute<T>(query);
  } finally {
    await close();
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Poll until `check` holds, for up to 15 seconds. */
async function until(what: string, check: () => Promise<boolean>) {
  for (const deadline = Date.now() + 15_000; !(await check());) {
    if (Date.now() > deadline) throw new Error(`never ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * restore.sh run on `t` with pg_restore held until `go`: a restore under way,
 * with the lock taken. Stopped, with its pause, when the test ends.
 */
async function pausedRestore(env: Record<string, string> = {}) {
  const pause = await mkdtemp(join(tmpdir(), 'wikistow-pause-'));
  await mkdir(join(pause, 'bin'));
  await promisify(execFile)('mkfifo', [join(pause, 'go')]);
  const shim = join(pause, 'bin', 'pg_restore');
  // Records the script's pid, then its own, once it runs.
  await writeFile(
    shim,
    [
      '#!/bin/sh',
      'echo "$PPID $$" > "$PAUSE_DIR/reached.tmp"',
      'mv "$PAUSE_DIR/reached.tmp" "$PAUSE_DIR/reached"',
      'read -r _ < "$PAUSE_DIR/go"',
      'PATH=${PATH#*:} exec pg_restore "$@"',
      '',
    ].join('\n'),
  );
  await chmod(shim, 0o755);
  const abort = new AbortController();
  const restoring = script('restore.sh', t, ['--server-stopped', backup], {
    env: { PATH: `${join(pause, 'bin')}:${process.env.PATH ?? ''}`, PAUSE_DIR: pause, ...env },
    signal: abort.signal,
  });
  restoring.catch(() => {});
  onTestFinished(async () => {
    abort.abort();
    await restoring.catch(() => {});
    await rm(pause, { recursive: true, force: true });
  });
  const reached = join(pause, 'reached');
  await until('reached pg_restore', () => exists(reached));
  const [scriptPid, shimPid] = (await readFile(reached, 'utf8')).trim().split(' ').map(Number);
  return {
    restoring,
    scriptPid: scriptPid!,
    shimPid: shimPid!,
    /** Let pg_restore run. */
    go: () => writeFile(join(pause, 'go'), '\n'),
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  t = testAppOn(testDb, await mkdtemp(join(tmpdir(), 'wikistow-blobs-')));
  backups = await mkdtemp(join(tmpdir(), 'wikistow-backups-'));
  backup = await script('backup.sh', t, [backups]);
  // Stopped, as the servers below are the only ones.
  await testDb.drop();
});
afterAll(async () => {
  await t.drop();
  await rm(backups, { recursive: true, force: true });
});

describe('the restore lock', () => {
  it('a restore refuses while a server runs, though the server has no pooled connection open', async () => {
    const server = await startServer(testDb.url, t.blobDir);
    await server.waitFor('listening', 'blob-sweep', 'draft-sweep', 'password-budget-sweep');
    // As postgres.js leaves an idle server once its pooled connections reach
    // their max_lifetime: only the lock's session and the tree listener's,
    // which never close, are open. Nothing reconnects, as the sweeps run
    // again only in an hour. Without a timeout, pg_terminate_backend only
    // signals each backend, and on a busy runner one can still be listed
    // after, so wait up to 15 seconds for each to exit.
    const kept = [DATABASE_LOCK_APPLICATION, TREE_LISTENER_APPLICATION];
    await withAdmin(
      (sql) => sql`select pg_terminate_backend(pid, 15000) from pg_stat_activity
        where datname = ${database()} and application_name <> all(${kept})`,
    );
    expect((await sessions()).map(({ name }) => name).toSorted()).toEqual(kept.toSorted());

    await expect(script('restore.sh', t, ['--server-stopped', backup])).rejects.toThrow(
      /The WikiStow server, its migrations or another restore is using the database/,
    );
    expect(await server.stop()).toBe(0);
  });

  // Two servers and a restore, one after another, and on a busy runner each
  // can take tens of seconds.
  it(
    'a server started during a restore refuses to start, as migrations do, and starts once it ends',
    { timeout: 120_000 },
    async () => {
      const { restoring, go } = await pausedRestore();

      const early = await startServer(testDb.url, t.blobDir);
      expect(await early.exited).toBe(1);
      expect(early.logs).toEqual([
        expect.objectContaining({ level: 'error', event: 'database-locked' }),
      ]);
      await expect(migrateDatabase(testDb.url)).rejects.toBeInstanceOf(DatabaseLockedError);

      await go();
      expect(await restoring).toBe(`Restored ${backup}`);
      // Started the moment the restore ends, as a restart policy would, after
      // migrations run by hand: the server runs them again, harmlessly.
      await migrateDatabase(testDb.url);
      const server = await startServer(testDb.url, t.blobDir);
      await server.waitFor('migrated', 'listening');
      expect(await server.stop()).toBe(0);
    },
  );

  it('a restore whose pg_restore fails changes nothing', async () => {
    await mkdir(join(t.blobDir, 'objects'), { recursive: true });
    const live = join(t.blobDir, 'objects', 'kept-by-a-failed-restore');
    await writeFile(live, 'kept');
    // A row the backup lacks, and an object it doesn't know of that stops
    // pg_restore dropping a table, after it has dropped others.
    await queryOn(
      testDb.url,
      sql`insert into audit_events (actor_kind, action, target_kind, target_id)
        values ('operator', 'written-after-the-backup', 'test', 'test')`,
    );
    await queryOn(testDb.url, sql`create view blocks_the_restore as select id from users`);
    onTestFinished(async () => {
      await queryOn(testDb.url, sql`drop view if exists blocks_the_restore`);
    });
    // pg_restore drops in reverse order, so before it fails on users it has
    // dropped every constraint and some tables, but not audit_events. Only a
    // rollback brings those back.
    const shape = () =>
      queryOn(
        testDb.url,
        sql`select (select count(*) from pg_tables where schemaname = 'public') as tables,
          (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
            where n.nspname = 'public') as constraints`,
      );
    const before = await shape();

    const failed = script('restore.sh', t, ['--server-stopped', backup]);
    await expect(failed).rejects.toMatchObject({ code: 1 });
    expect(
      await queryOn(
        testDb.url,
        sql`select action from audit_events where action = 'written-after-the-backup'`,
      ),
    ).toHaveLength(1);
    expect(await shape()).toEqual(before);
    expect(await readFile(live, 'utf8')).toBe('kept');
    expect(await exists(join(t.blobDir, 'objects.restoring'))).toBe(false);
    await until('let go of the lock', async () => (await lockHolders()).length === 0);
  });

  it('a restore stopped mid pg_restore stops it, cleans up and lets go of the lock', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'wikistow-restore-tmp-'));
    onTestFinished(() => rm(scratch, { recursive: true, force: true }));
    const { restoring, scriptPid, shimPid } = await pausedRestore({ TMPDIR: scratch });
    expect(await exists(join(t.blobDir, 'objects.restoring'))).toBe(true);

    process.kill(scriptPid, 'SIGTERM');
    await expect(restoring).rejects.toThrow(
      /Stopped during the database restore\. Keep the server stopped and run the restore again\./,
    );
    expect(() => process.kill(shimPid, 0)).toThrow(/ESRCH/);
    expect(await exists(join(t.blobDir, 'objects.restoring'))).toBe(false);
    expect(await readdir(scratch)).toEqual([]);
    await until('let go of the lock', async () => (await lockHolders()).length === 0);
  });
});
