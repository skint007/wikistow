import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { Journal } from '../src/journal.ts';
import { privateDir } from './support/fake-io.ts';

const AGENT = `agent-${'a'.repeat(42)}A`;
const SERVER = 'https://wiki.example';
const URL_PAGES = `${SERVER}/api/spaces/space-1/pages`;
const STATE_KEY = randomBytes(32);
const code = (expected: string) => expect.objectContaining({ code: expected });

type Seen = { url: string; key: string | null; body: unknown };

/** A server that answers each change with `status`, recording what it got. */
function server(statuses: number[]) {
  const seen: Seen[] = [];
  const send = async (url: string, init: RequestInit) => {
    seen.push({ url, key: new Headers(init.headers).get('idempotency-key'), body: init.body });
    const status = statuses.shift() ?? 200;
    return Response.json(status < 400 ? { pageId: 'page-1', revisionId: 'rev-1' } : { error: {} }, {
      status,
    });
  };
  return { seen, send };
}

/** One run's journal in `dir`, for `key` and a run asked to do `input`. */
const journal = (dir: string, key: string | null, { input = 'same', now = new Date() } = {}) =>
  new Journal({
    dir,
    agentId: AGENT,
    server: SERVER,
    stateKey: STATE_KEY,
    key,
    input,
    now: () => now,
  });

const post = (body: string) => ({ url: URL_PAGES, init: { method: 'POST', body } });

/** Run one change through a fresh journal. */
async function change(
  dir: string,
  key: string | null,
  send: (url: string, init: RequestInit) => Promise<Response>,
  body: string,
  options: Parameters<typeof journal>[2] = {},
) {
  const run = journal(dir, key, options);
  const { url, init } = post(body);
  return { run, res: await run.fetch(send)(url, init) };
}

describe('the journal', () => {
  it('resends the first run’s bytes until an answer comes back, then reports that answer', async () => {
    const { dir } = await privateDir();
    const { seen, send } = server([502, 200]);
    const first = await change(dir, 'k-1', send, '{"sealed":"first"}');
    expect(first.res.status).toBe(502);
    expect(first.run.sent).toBeNull();
    // The next run seals afresh; the journal sends the first bytes instead.
    const second = await change(dir, 'k-1', send, '{"sealed":"second"}');
    expect(second.res.status).toBe(200);
    expect(seen.map((s) => [s.key, s.body])).toEqual([
      ['k-1', '{"sealed":"first"}'],
      ['k-1', '{"sealed":"first"}'],
    ]);
    expect(second.run.sent).toEqual({
      path: '/api/spaces/space-1/pages',
      answer: { pageId: 'page-1', revisionId: 'rev-1' },
    });
    // Once answered, a retry gets that answer and sends nothing.
    const third = await change(dir, 'k-1', send, '{"sealed":"third"}');
    expect(seen).toHaveLength(2);
    expect(third.res.status).toBe(200);
    expect(third.run.sent?.answer).toEqual({ pageId: 'page-1', revisionId: 'rev-1' });
    expect(third.run.attempted).toBe(true);
  });

  it('keeps the bytes when a resend is refused after the server stopped keeping its key', async () => {
    const then = new Date('2026-10-01T00:00:00Z');
    const after = (hours: number) => new Date(then.getTime() + hours * 60 * 60 * 1000);
    const refusal = (status: number, code: string) =>
      Response.json({ error: { code, message: 'No' } }, { status });
    const cases = [
      // Any refusal: the first run's change may be what's in the way.
      { at: after(25), res: refusal(409, 'stale-head'), kept: true },
      // The server still keeps the key, so it would have answered a change it made.
      { at: after(2), res: refusal(409, 'stale-head'), kept: false },
    ];
    for (const { at, res, kept } of cases) {
      const { dir } = await privateDir();
      await change(dir, 'k', server([502]).send, '{"n":1}', { now: then });
      const run = journal(dir, 'k', { now: at });
      const { url, init } = post('{"n":2}');
      expect((await run.fetch(async () => res.clone())(url, init)).status).toBe(res.status);
      expect(run.inconclusive).toBe(kept);
      expect(journal(dir, 'k').replaying).toBe(kept);
    }
  });

  it('keeps the bytes when the outcome is unknown: a server error, a lost connection', async () => {
    const { dir } = await privateDir();
    const { seen, send } = server([500, 200]);
    await change(dir, 'k', send, '{"n":1}');
    await change(dir, 'k', send, '{"n":2}');
    expect(seen.map((s) => s.body)).toEqual(['{"n":1}', '{"n":1}']);
    const lost = await privateDir();
    const failing = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(change(lost.dir, 'k', failing, '{"n":1}')).rejects.toThrow();
    const after = server([200]);
    await change(lost.dir, 'k', after.send, '{"n":2}');
    expect(after.seen.map((s) => s.body)).toEqual(['{"n":1}']);
  });

  it('refuses the key for a change asked with other input', async () => {
    const { dir } = await privateDir();
    const { seen, send } = server([502]);
    await change(dir, 'k-3', send, '{}');
    // Pending: other content under the key would never be sent, so it is refused.
    await expect(change(dir, 'k-3', send, '{}', { input: 'other' })).rejects.toThrow(
      code('journal-mismatch'),
    );
    expect(seen).toHaveLength(1);
  });

  it('keeps a note with the change, for a retry with the same input to report', async () => {
    const { dir } = await privateDir();
    const { send } = server([502, 200]);
    expect(journal(dir, 'k-n').note).toBeNull();
    const first = journal(dir, 'k-n');
    first.setNote('{"id":"first-upload"}');
    const a = post('{}');
    await first.fetch(send)(a.url, a.init);
    expect(journal(dir, 'k-n').note).toBe('{"id":"first-upload"}');
    // A retry's own note doesn't replace the first run's.
    const second = journal(dir, 'k-n');
    second.setNote('{"id":"second-upload"}');
    await second.fetch(send)(a.url, a.init);
    expect(journal(dir, 'k-n').note).toBe('{"id":"first-upload"}');
  });

  it('forgets answers a day old, and keeps changes still waiting for one', async () => {
    const { dir } = await privateDir();
    const { seen, send } = server([200, 502, 200]);
    const then = new Date('2026-10-01T00:00:00Z');
    await change(dir, 'answered', send, '{"n":1}', { now: then });
    await change(dir, 'waiting', send, '{"n":2}', { now: then });
    const later = new Date(then.getTime() + 25 * 60 * 60 * 1000);
    await change(dir, 'new', send, '{"n":3}', { now: later });
    expect(await readdir(join(dir, 'journal'))).toHaveLength(2);
    expect(journal(dir, 'answered').replaying).toBe(false);
    expect(journal(dir, 'waiting').replaying).toBe(true);
    expect(seen).toHaveLength(3);
  });
});
