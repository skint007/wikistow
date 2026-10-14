import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import type { AppEnv } from '../src/http/env.ts';
import { onError } from '../src/http/errors.ts';
import { createRoutes } from '../src/http/mount.ts';
import { createTestApp, ORIGIN, type TestApp } from './support/harness.ts';

const echo = {
  method: 'POST',
  path: '/api/things/:id',
  params: z.object({ id: z.uuid() }),
  query: z.object({ limit: z.coerce.number().int().max(10) }),
  body: z.object({ name: z.string().min(1) }),
  response: z.object({ id: z.string(), name: z.string(), limit: z.number() }),
} as const;

let t: TestApp;
let app: Hono<AppEnv>;

beforeAll(async () => {
  t = await createTestApp();
  app = new Hono<AppEnv>();
  const registered = createRoutes({ app, auth: t.auth, db: t.db, config: t.config });
  registered.public(echo, ({ params, query, body }) => ({
    id: params.id,
    name: body.name,
    limit: query.limit,
    // Not in the contract, so it must never reach the client.
    passwordHash: 'SERVER-ONLY',
  }));
  registered.account({ ...echo, path: '/api/private/:id' }, ({ params, query, body }) => ({
    id: params.id,
    name: body.name,
    limit: query.limit,
  }));
  app.onError(onError(() => {}));
});
afterAll(() => t.drop());

const id = '6f1c2a9e-8f7b-4c3d-9a1e-2b3c4d5e6f70';
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('route registration', () => {
  it('passes validated input and strips undeclared response fields', async () => {
    const res = await post(`/api/things/${id}?limit=3`, { name: 'x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, name: 'x', limit: 3 });
  });

  it('rejects an invalid body before the handler runs', async () => {
    const res = await post(`/api/things/${id}?limit=3`, { name: '' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('invalid-request');
    expect(json.error.issues.map((issue: { path: string }) => issue.path)).toContain('body.name');
  });

  it('refuses writes from another origin but allows clients that send none', async () => {
    const foreign = await post(
      `/api/things/${id}?limit=3`,
      { name: 'x' },
      { origin: 'https://evil.example' },
    );
    expect(foreign.status).toBe(403);
    expect(
      (await post(`/api/things/${id}?limit=3`, { name: 'x' }, { origin: ORIGIN })).status,
    ).toBe(200);
  });

  it('requires a signed-in account for account routes', async () => {
    const res = await post(`/api/private/${id}?limit=1`, { name: 'x' });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
  });
});
