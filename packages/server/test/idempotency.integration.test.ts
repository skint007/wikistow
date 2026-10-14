// Content changes sent with an Idempotency-Key, handled once inside their
// own transaction (`transactOnce`).
import { count, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { ContentError } from '../src/content/errors.ts';
import type { Database } from '../src/db/client.ts';
import { idempotencyKeys } from '../src/db/schema/index.ts';
import { transactOnce, type Once } from '../src/idempotency.ts';
import { createTestDatabase } from './database.ts';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Database;
beforeAll(async () => {
  testDb = await createTestDatabase();
  db = testDb.db;
  // What each change did, so a test can count how often it ran.
  await db.execute(sql`create table runs (key text not null)`);
});
afterAll(() => testDb.drop());

const once = (key: string, requestHash = 'first request'): Once => ({
  callerId: 'caller',
  key,
  requestHash,
});

// A change that records a run under `key` and answers `answer`.
const change =
  <T>(key: string, answer: T) =>
  async (tx: Database) => {
    await tx.execute(sql`insert into runs (key) values (${key})`);
    return answer;
  };

const runs = async (key: string) =>
  Number(
    [
      ...(await db.execute<{ n: string }>(sql`select count(*) as n from runs where key = ${key}`)),
    ][0]?.n,
  );

const kept = async () => (await db.select({ n: count() }).from(idempotencyKeys))[0]?.n ?? 0;

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no error',
    (error: unknown) => (error instanceof ContentError ? error.code : String(error)),
  );

describe('a change with an Idempotency-Key', () => {
  it('runs once: a retry gets the first answer without running again', async () => {
    expect(await transactOnce(db, once('a'), change('a', { revisionId: 'r1' }))).toEqual({
      revisionId: 'r1',
    });
    expect(await transactOnce(db, once('a'), change('a', { revisionId: 'r2' }))).toEqual({
      revisionId: 'r1',
    });
    expect(await runs('a')).toBe(1);
    // A change that answers nothing is kept too.
    expect(await transactOnce(db, once('nothing'), change('nothing', undefined))).toBeUndefined();
    expect(await transactOnce(db, once('nothing'), change('nothing', undefined))).toBeNull();
    expect(await runs('nothing')).toBe(1);
  });

  it('refuses the key with another request', async () => {
    await transactOnce(db, once('b'), change('b', 1));
    expect(await failure(transactOnce(db, once('b', 'another request'), change('b', 2)))).toBe(
      'duplicate',
    );
    expect(await runs('b')).toBe(1);
  });

  it('keeps nothing when the change fails, so a retry runs it afresh', async () => {
    const before = await kept();
    const failing = transactOnce(db, once('c'), async (tx) => {
      await change('c', 1)(tx);
      throw new ContentError('stale-head');
    });
    expect(await failure(failing)).toBe('stale-head');
    expect(await runs('c')).toBe(0);
    expect(await kept()).toBe(before);
    expect(await transactOnce(db, once('c'), change('c', 'second try'))).toBe('second try');
    expect(await runs('c')).toBe(1);
  });

  it('is busy while the first request with the key is still running', async () => {
    let started!: () => void;
    let finish!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const held = new Promise<void>((resolve) => (finish = resolve));
    const first = transactOnce(db, once('d'), async (tx) => {
      await change('d', 'first')(tx);
      started();
      await held;
      return 'first';
    });
    await running;
    expect(await failure(transactOnce(db, once('d'), change('d', 'second')))).toBe('busy');
    finish();
    expect(await first).toBe('first');
    expect(await transactOnce(db, once('d'), change('d', 'third'))).toBe('first');
    expect(await runs('d')).toBe(1);
  });
});
