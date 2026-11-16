// The Chrome Web Store upload (scripts/chrome-store.ts) against a fake
// store: the token from a signed JWT, the upload, waiting for it, and the
// submission, and the errors that stop it before a submission.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vite-plus/test';
import { assertion, send } from '../scripts/chrome-store.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  client_email: 'uploader@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

/** A store that answers each call in turn, and the calls it got. */
function fakeStore(answers: Record<string, unknown>[]) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const answer = answers.shift() ?? {};
    const status = typeof answer['status'] === 'number' ? answer['status'] : 200;
    return new Response(JSON.stringify(answer), { status });
  }) as typeof globalThis.fetch;
  return {
    calls,
    store: {
      account,
      publisher: 'pub1',
      item: 'abcdefghijklmnopabcdefghijklmnop',
      fetch,
      pause: 1,
    },
  };
}

const ZIP = new Uint8Array([80, 75, 5, 6]);

describe('the Chrome Web Store upload', () => {
  test('signs a JWT the service account’s public key verifies, for the store’s scope', () => {
    const jwt = assertion(account, 1_700_000_000_000);
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_000_600,
    });
    const verify = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    expect(verify.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  test('uploads, waits for the store to read it, and submits it', async () => {
    const { calls, store } = fakeStore([
      { access_token: 'tok' },
      { uploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'SUCCEEDED' },
      { state: 'PENDING_REVIEW' },
    ]);
    expect(await send(store, ZIP, '0.2.0')).toEqual({ state: 'PENDING_REVIEW' });
    const item = 'publishers/pub1/items/abcdefghijklmnopabcdefghijklmnop';
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://oauth2.googleapis.com/token',
      `POST https://chromewebstore.googleapis.com/upload/v2/${item}:upload`,
      `GET https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`,
      `GET https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`,
      `POST https://chromewebstore.googleapis.com/v2/${item}:publish`,
    ]);
    expect(calls[1]?.body).toEqual(ZIP);
    expect(JSON.parse(String(calls[4]?.body))).toEqual({ publishType: 'DEFAULT_PUBLISH' });
  });

  test('never submits an upload that failed, or of another version', async () => {
    const failed = fakeStore([{ access_token: 'tok' }, { uploadState: 'FAILED' }]);
    await expect(send(failed.store, ZIP, '0.2.0')).rejects.toThrow('the store says FAILED');
    const other = fakeStore([
      { access_token: 'tok' },
      { uploadState: 'SUCCEEDED', crxVersion: '0.1.0' },
    ]);
    await expect(send(other.store, ZIP, '0.2.0')).rejects.toThrow('read version 0.1.0, not 0.2.0');
    const refused = fakeStore([{ access_token: 'tok' }, { status: 400, error: 'version' }]);
    await expect(send(refused.store, ZIP, '0.2.0')).rejects.toThrow('Uploading: 400');
    for (const { calls } of [failed, other, refused]) {
      expect(calls.some((call) => call.url.endsWith(':publish'))).toBe(false);
    }
  });

  test('a refused token stops it before the upload', async () => {
    const { calls, store } = fakeStore([{ status: 401, error: 'invalid_grant' }]);
    await expect(send(store, ZIP, '0.2.0')).rejects.toThrow('Getting an access token: 401');
    expect(calls).toHaveLength(1);
  });
});
