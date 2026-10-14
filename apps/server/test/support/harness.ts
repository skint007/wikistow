// Builds the real app against a fresh database, with mail and logs captured
// in memory, plus a small cookie-keeping client that behaves like a browser.
import {
  DEFAULT_DRAFT_RETENTION_MS,
  DEFAULT_CONTENT_LIMITS,
  fileBlobStore,
} from '@wikistow/server';
import { afterAll } from 'vite-plus/test';
import { FAST_KDF } from '@wikistow/client/testing';
import { createTestDatabase } from '@wikistow/server/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.ts';
import type { Config } from '../../src/config.ts';
import type { LogEntry } from '../../src/http/logger.ts';
import type { Mail } from '../../src/mail/mailer.ts';

export const ORIGIN = 'http://localhost:3000';

export const testConfig = (databaseUrl: string, overrides: Partial<Config> = {}): Config => ({
  databaseUrl,
  publicOrigin: ORIGIN,
  port: 3000,
  webDist: undefined,
  migrationsDir: undefined,
  authSecret: 'test-secret-that-is-comfortably-longer-than-32-characters',
  smtp: { url: 'smtp://127.0.0.1:1', from: 'WikiStow <wiki@example.test>' },
  trustProxy: false,
  rateLimit: false,
  // Derivation at the real floor takes a while; the floor itself is tested separately.
  minKdf: FAST_KDF,
  blobDir: '/nonexistent',
  limits: { uploadBytes: 25 * 1024 * 1024, storageBytes: 5 * 1024 * 1024 * 1024 },
  draftRetentionMs: DEFAULT_DRAFT_RETENTION_MS,
  contentLimits: DEFAULT_CONTENT_LIMITS,
  bodyDeadlineMs: 60_000,
  ...overrides,
});

export async function createTestApp(overrides: Partial<Config> = {}) {
  return testAppOn(
    await createTestDatabase(),
    await mkdtemp(join(tmpdir(), 'wikistow-blobs-')),
    overrides,
  );
}

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

/**
 * The real app on a database and blob directory the caller made, such as
 * a restored copy. `drop` closes the database and removes `blobDir`.
 */
export function testAppOn(testDb: TestDatabase, blobDir: string, overrides: Partial<Config> = {}) {
  const mails: Mail[] = [];
  const logs: LogEntry[] = [];
  const config = testConfig(testDb.url, { blobDir, ...overrides });
  const { app, auth } = createApp({
    db: testDb.db,
    config,
    log: (entry) => logs.push(entry),
    deliver: async (mail) => {
      mails.push(mail);
    },
    blobs: fileBlobStore(blobDir),
  });
  return {
    app,
    auth,
    db: testDb.db,
    config,
    mails,
    logs,
    blobDir,
    drop: async () => {
      await testDb.drop();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}

export type TestApp = ReturnType<typeof testAppOn>;

/**
 * Extra apps for tests that need a fresh installation or other settings.
 * They are dropped together after the file, so a slow `drop database`
 * never counts against a test's own timeout.
 */
export function scratchApps(): (overrides?: Partial<Config>) => Promise<TestApp> {
  const apps: TestApp[] = [];
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.drop()));
  });
  return async (overrides = {}) => {
    const app = await createTestApp(overrides);
    apps.push(app);
    return app;
  };
}

type RequestOptions = { method?: string; json?: unknown; headers?: Record<string, string> };

/** A cookie jar over `app.request`. Sends Origin on writes, like a browser. */
export class Browser {
  readonly #app: TestApp['app'];
  readonly #cookies = new Map<string, string>();

  constructor(app: TestApp['app']) {
    this.#app = app;
  }

  async request(
    path: string,
    { method = 'GET', json, headers = {} }: RequestOptions = {},
  ): Promise<Response> {
    const all: Record<string, string> = { ...headers };
    if (this.#cookies.size > 0)
      all['cookie'] = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && !('origin' in all)) all['origin'] = ORIGIN;
    if (json !== undefined) all['content-type'] = 'application/json';
    const res = await this.#app.request(path, {
      method,
      headers: all,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    this.#remember(res);
    return res;
  }

  #remember(res: Response): void {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = '', ...attributes] = cookie.split(';');
      const [name = '', value = ''] = pair.split('=');
      const expired = value === '' || attributes.some((a) => /max-age=0\b/i.test(a.trim()));
      if (expired) this.#cookies.delete(name.trim());
      else this.#cookies.set(name.trim(), value);
    }
  }

  /** A `fetch` for the API client that carries this browser's cookies and Origin. */
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    if (this.#cookies.size > 0)
      headers.set('cookie', [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    if (method !== 'GET') headers.set('origin', ORIGIN);
    // Browsers state the length of byte bodies; app.request doesn't.
    if (init.body instanceof Uint8Array)
      headers.set('content-length', String(init.body.byteLength));
    const res = await this.#app.request(url, { ...init, headers });
    this.#remember(res);
    return res;
  };

  /** Drop the cookies whose names start with `prefix`. */
  forget(prefix: string): void {
    for (const name of [...this.#cookies.keys()]) {
      if (name.startsWith(prefix)) this.#cookies.delete(name);
    }
  }

  /** Copy this browser's cookies, e.g. to keep a "stolen" session around after sign-out. */
  clone(): Browser {
    const copy = new Browser(this.#app);
    for (const [k, v] of this.#cookies) copy.#cookies.set(k, v);
    return copy;
  }
}

/** The link in a captured message, as a path the test app can request. */
export function linkIn(mail: Mail | undefined): string {
  const match = mail?.text.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in mail');
  const url = new URL(match[0]);
  return url.pathname + url.search + url.hash;
}

/** The most recent mail sent to `to`. */
export const lastMailTo = (mails: Mail[], to: string) => mails.filter((m) => m.to === to).at(-1);
