import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * How long the server keeps an `Idempotency-Key` with its answer: a retry
 * with the key within this long gets the first answer back; after it, the
 * request is handled afresh, as if it were new.
 */
export const IDEMPOTENCY_KEY_KEPT_MS = 24 * 60 * 60 * 1000;

/**
 * One API route, described once and shared by the server and every client.
 * Paths use Hono syntax (`/api/pages/:pageId`). Each schema validates that part
 * of the request; `response` also strips anything the server didn't mean to send.
 *
 *   export const health = {
 *     method: 'GET',
 *     path: '/api/health',
 *     response: z.object({ status: z.literal('ok') }),
 *   } as const satisfies RouteDef;
 */
export type RouteDef = {
  method: HttpMethod;
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
  /** Success status. Defaults to 200. */
  status?: 200 | 201;
};

type Infer<S> = S extends z.ZodType ? z.output<S> : undefined;

/** The parsed request parts a handler receives for route `R`. */
export type RouteInput<R extends RouteDef> = {
  params: Infer<R['params']>;
  query: Infer<R['query']>;
  body: Infer<R['body']>;
};

export type RouteOutput<R extends RouteDef> = z.input<R['response']>;

/**
 * A route that answers with a stream of JSON lines (`application/x-ndjson`),
 * each one an `event`, instead of one response value: the AI proxy, and
 * the tree changes. Blank lines, sent while the stream is quiet to keep it
 * open, carry nothing. A POST takes a JSON `body`; a GET takes none.
 */
export type StreamRouteDef =
  | { method: 'POST'; path: string; body: z.ZodType; event: z.ZodType }
  | { method: 'GET'; path: string; body?: never; event: z.ZodType };

/** The parsed body a stream route's handler receives: none for a GET. */
export type StreamBody<R extends StreamRouteDef> = Infer<R['body']>;
