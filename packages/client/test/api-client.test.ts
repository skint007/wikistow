import { z } from 'zod';
import { describe, expect, it } from 'vite-plus/test';
import { ApiError, createApiClient } from '../src/index.ts';

const route = {
  method: 'POST',
  path: '/api/things/:id',
  params: z.object({ id: z.string() }),
  query: z.object({ limit: z.number() }),
  body: z.object({ name: z.string() }),
  response: z.object({ ok: z.literal(true) }),
} as const;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the API client', () => {
  it('sends an Idempotency-Key only on the call given one', async () => {
    const calls: { init: RequestInit }[] = [];
    const api = createApiClient({
      fetch: async (_url, init) => {
        calls.push({ init });
        return json(200, { ok: true });
      },
    });
    const input = { params: { id: 'x' }, query: { limit: 1 }, body: { name: 'x' } };
    await api.call(route, input, { idempotencyKey: 'make-x' });
    await api.call(route, input);
    expect(calls[0]?.init.headers).toEqual({
      'content-type': 'application/json',
      'idempotency-key': 'make-x',
    });
    expect(calls[1]?.init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('keeps the wait a rate limit asks for, from its Retry-After', async () => {
    const limited = (headers: Record<string, string>) =>
      createApiClient({
        fetch: async () =>
          new Response(
            JSON.stringify({ error: { code: 'rate-limited', message: 'Too many requests' } }),
            { status: 429, headers: { 'content-type': 'application/json', ...headers } },
          ),
      });
    const input = { params: { id: 'x' }, query: { limit: 1 }, body: { name: 'x' } };
    const caught = await limited({ 'retry-after': '7' })
      .call(route, input)
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status: 429, code: 'rate-limited', retryAfterSeconds: 7 });
    // None asked, or a date, which the server never sends: no wait is known.
    for (const headers of [{}, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }]) {
      const error = await limited(headers)
        .call(route, input)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'rate-limited', retryAfterSeconds: null });
    }
  });
});
