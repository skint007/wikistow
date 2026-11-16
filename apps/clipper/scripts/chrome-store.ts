// Sends a new version of the extension to the Chrome Web Store, through
// its API v2, as a service account: it uploads the zip to the item, waits
// for the store to take it, and submits it for review, to be published
// once approved (docs/releasing.md#the-browser-extension). The release's
// `chrome-web-store` job runs it:
//
//   node scripts/chrome-store.ts <zip> <version>
//
// with CHROME_SERVICE_ACCOUNT_KEY, the service account's JSON key, and
// CHROME_PUBLISHER_ID and CHROME_ITEM_ID, from the dashboard. The first
// version is uploaded by hand: the API only updates an item that exists.
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://chromewebstore.googleapis.com';

type ServiceAccount = { client_email: string; private_key: string };
type Fetch = typeof fetch;

const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** The signed JWT a service account trades for an access token (Google's OAuth 2.0 for service accounts). */
export function assertion(account: ServiceAccount, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat,
      exp: iat + 600,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(account.private_key);
  return `${header}.${claims}.${base64url(signature)}`;
}

/** The response's JSON, or an error naming the step and what the server said. */
/** The fields this reads from the store's and Google's answers. */
type Answer = {
  access_token?: string;
  uploadState?: string;
  lastAsyncUploadState?: string;
  crxVersion?: string;
  state?: string;
  warningInfo?: unknown;
};

async function json(response: Response, step: string): Promise<Answer> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${step}: ${response.status} ${text}`);
  return JSON.parse(text) as Answer;
}

export type Store = {
  account: ServiceAccount;
  publisher: string;
  item: string;
  fetch?: Fetch;
  /** How long to wait between asking whether an upload is done. */
  pause?: number;
};

/** Uploads `zip`, checks the store read `version` from it, and submits it for review. */
export async function send(store: Store, zip: Uint8Array, version: string) {
  // Each call within two minutes, so a stalled one can't hold the release.
  const call: Fetch = (url, init) =>
    (store.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(120_000) });
  const pause = store.pause ?? 5000;
  const token = await json(
    await call(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: assertion(store.account),
      }),
    }),
    'Getting an access token',
  );
  const auth = { authorization: `Bearer ${token.access_token ?? ''}` };
  const name = `publishers/${encodeURIComponent(store.publisher)}/items/${encodeURIComponent(store.item)}`;

  const uploaded = await json(
    await call(`${API}/upload/v2/${name}:upload`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/zip' },
      body: new Uint8Array(zip),
    }),
    'Uploading',
  );
  let state = uploaded.uploadState;
  let last = uploaded;
  // Set only when the upload answered with it done; a slower one is
  // checked by the review, which shows the version.
  const crxVersion = uploaded.crxVersion;
  // A large package is read after the upload answers: ask until it's done,
  // for at most five minutes.
  for (let tries = 0; state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS'; tries++) {
    if (tries === 60) throw new Error('Uploading: the store was still reading it after 5 minutes');
    await new Promise((resolve) => setTimeout(resolve, pause));
    const status = await json(
      await call(`${API}/v2/${name}:fetchStatus`, { headers: auth }),
      'Asking how the upload went',
    );
    state = status.lastAsyncUploadState;
    last = status;
  }
  if (state !== 'SUCCEEDED') {
    throw new Error(`Uploading: the store says ${state ?? 'nothing'}: ${JSON.stringify(last)}`);
  }
  if (crxVersion !== undefined && crxVersion !== version) {
    throw new Error(`Uploading: the store read version ${crxVersion}, not ${version}`);
  }

  const published = await json(
    await call(`${API}/v2/${name}:publish`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
    }),
    'Submitting it for review',
  );
  return published;
}

if (import.meta.main) {
  const [zipPath, version] = process.argv.slice(2);
  if (!zipPath || !version) throw new Error('Usage: node scripts/chrome-store.ts <zip> <version>');
  const account = JSON.parse(process.env['CHROME_SERVICE_ACCOUNT_KEY'] ?? '') as ServiceAccount;
  const published = await send(
    {
      account,
      publisher: process.env['CHROME_PUBLISHER_ID'] ?? '',
      item: process.env['CHROME_ITEM_ID'] ?? '',
    },
    await readFile(zipPath),
    version,
  );
  process.stdout.write(
    `Submitted ${version} to the Chrome Web Store: ${published.state ?? 'submitted'}\n`,
  );
  for (const warning of [published.warningInfo].filter(Boolean)) {
    process.stdout.write(`::warning::The Chrome Web Store warns: ${JSON.stringify(warning)}\n`);
  }
}
