import { fileBlobStore } from '@wikistow/server';
import { createTestDatabase } from '@wikistow/server/testing';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { CSP } from '@wikistow/contracts';
import { testConfig } from './support/harness.ts';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let root: string;
let webDist: string;

const newApp = (overrides: Partial<Config> = {}) =>
  createApp({
    db: testDb.db,
    config: testConfig(testDb.url, { webDist, ...overrides }),
    log: () => {},
    deliver: async () => {},
    blobs: fileBlobStore(root),
  }).app;

beforeAll(async () => {
  testDb = await createTestDatabase();
  // The build sits next to a sentinel file that must never be reachable.
  root = await mkdtemp(join(tmpdir(), 'wikistow-web-'));
  webDist = join(root, 'web');
  await writeFile(join(root, 'secret.txt'), 'SENTINEL-OUTSIDE-WEB-DIST');
  await mkdir(join(webDist, 'assets'), { recursive: true });
  await writeFile(join(webDist, 'index.html'), '<!doctype html><title>WikiStow</title>');
  await writeFile(join(webDist, 'assets', 'app-3f9a.js'), 'export {}');
});

afterAll(async () => {
  await testDb.drop();
  await rm(root, { recursive: true, force: true });
});

describe('every response', () => {
  const paths = ['/', '/assets/app-3f9a.js', '/api/health'];

  it.each(paths)('%s carries the full security headers', async (path) => {
    const res = await newApp().request(path);
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('keeps the policy strict', () => {
    expect(CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(CSP).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*|data:|https?:/);
    expect(CSP).toContain("connect-src 'self'");
    expect(CSP).toContain("frame-ancestors 'none'");
  });
});

describe('the web app', () => {
  it('serves index.html for client routes and revalidates it', async () => {
    for (const path of ['/', '/s/space-id/p/page-id']) {
      const res = await newApp().request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>WikiStow</title>');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('never serves the app shell or long-lived caching for unknown asset paths', async () => {
    for (const path of ['/assets', '/assets/', '/assets/chunk']) {
      const res = await newApp().request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('cache-control'), path).toBeNull();
    }
    expect((await newApp().request('/missing.js')).status).toBe(404);
  });

  it.each(['/..%2fsecret.txt', '/assets/%2e%2e/%2e%2e/secret.txt'])(
    'never serves files outside the build folder (%s)',
    async (path) => {
      const res = await newApp().request(path);
      expect(await res.text()).not.toContain('SENTINEL-OUTSIDE-WEB-DIST');
    },
  );
});

describe('the API', () => {
  it('reports an installation ID that never changes', async () => {
    const first = await (await newApp().request('/api/installation')).json();
    const second = await (await newApp().request('/api/installation')).json();
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toEqual(first);
  });

  it('hides unexpected errors', async () => {
    // Without the web build, so no catch-all route is registered ahead of this one.
    const app = newApp({ webDist: undefined });
    app.get('/api/boom', () => {
      throw new TypeError('SECRET-ERROR-DETAIL');
    });
    const res = await app.request('/api/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'Something went wrong' },
    });
  });
});
