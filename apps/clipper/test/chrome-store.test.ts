// The Chrome Web Store upload (scripts/chrome-store.ts) against a fake
// store: the upload with the job's token, waiting for it, and the
// submission, and the errors that stop it before a submission.
import { describe, expect, test } from 'vite-plus/test';
import { send } from '../scripts/chrome-store.ts';

/** A store that answers each call in turn, and the calls it got. */
function fakeStore(answers: Record<string, unknown>[]) {
  const calls: { url: string; method: string; body: unknown; auth: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body, auth });
    const answer = answers.shift() ?? {};
    const status = typeof answer['status'] === 'number' ? answer['status'] : 200;
    return new Response(JSON.stringify(answer), { status });
  }) as typeof globalThis.fetch;
  return {
    calls,
    store: {
      token: 'tok',
      publisher: 'pub1',
      item: 'abcdefghijklmnopabcdefghijklmnop',
      fetch,
      pause: 1,
    },
  };
}

const ZIP = new Uint8Array([80, 75, 5, 6]);

describe('the Chrome Web Store upload', () => {
  test('uploads, waits for the store to read it, and submits it', async () => {
    const { calls, store } = fakeStore([
      { uploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'SUCCEEDED' },
      { state: 'PENDING_REVIEW' },
    ]);
    expect(await send(store, ZIP, '0.2.0')).toEqual({ state: 'PENDING_REVIEW' });
    const item = 'publishers/pub1/items/abcdefghijklmnopabcdefghijklmnop';
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST https://chromewebstore.googleapis.com/upload/v2/${item}:upload`,
      `GET https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`,
      `GET https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`,
      `POST https://chromewebstore.googleapis.com/v2/${item}:publish`,
    ]);
    expect(calls.every((call) => call.auth === 'Bearer tok')).toBe(true);
    expect(calls[0]?.body).toEqual(ZIP);
    expect(JSON.parse(String(calls[3]?.body))).toEqual({ publishType: 'DEFAULT_PUBLISH' });
  });

  test('never submits an upload that failed, or of another version', async () => {
    const failed = fakeStore([{ uploadState: 'FAILED' }]);
    await expect(send(failed.store, ZIP, '0.2.0')).rejects.toThrow('the store says FAILED');
    const other = fakeStore([{ uploadState: 'SUCCEEDED', crxVersion: '0.1.0' }]);
    await expect(send(other.store, ZIP, '0.2.0')).rejects.toThrow('read version 0.1.0, not 0.2.0');
    const refused = fakeStore([{ status: 400, error: 'version' }]);
    await expect(send(refused.store, ZIP, '0.2.0')).rejects.toThrow('Uploading: 400');
    for (const { calls } of [failed, other, refused]) {
      expect(calls.some((call) => call.url.endsWith(':publish'))).toBe(false);
    }
  });

  test('a refused token stops it before the submission', async () => {
    const { calls, store } = fakeStore([{ status: 401, error: 'UNAUTHENTICATED' }]);
    await expect(send(store, ZIP, '0.2.0')).rejects.toThrow('Uploading: 401');
    expect(calls).toHaveLength(1);
  });
});
