import { ApiErrorBody, type ErrorCode, type ErrorDetail, type RouteDef } from '@wikistow/contracts';
import type { z } from 'zod';
import { parseJsonText } from '../json.ts';

/**
 * A failed API call, carrying the server's error code. Two codes are this
 * client's own: `unreadable-response` for an answer it can't read, and
 * `network` (status 0) for a request that got no answer at all.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | 'unreadable-response' | 'network';
  /** What the refusal names besides its code, such as the share's current key version. */
  readonly detail: ErrorDetail;

  constructor(
    status: number,
    code: ErrorCode | 'unreadable-response' | 'network',
    message: string,
    detail: ErrorDetail = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Whether a call that failed with `error` may still have made its change: no
 * answer came back, the server failed, or its answer to a success couldn't be
 * read. Any other failure is a refusal, or came before anything was sent.
 */
export const outcomeUnknown = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.code === 'network' || error.code === 'unreadable-response' || error.status >= 500);

type Part<S, K extends string> = S extends z.ZodType
  ? { [P in K]: z.input<S> }
  : { [P in K]?: never };

/** What a caller supplies for route `R`: exactly the parts its contract declares. */
export type CallInput<R extends RouteDef> = Part<R['params'], 'params'> &
  Part<R['query'], 'query'> &
  Part<R['body'], 'body'>;

/**
 * How to send one call. `idempotencyKey` goes out as `Idempotency-Key`, which
 * only the content changes that take one accept (creating a folder or page,
 * saving a draft, publishing): a retry with the same key and the identical
 * body gets the first answer instead of acting twice. Sealing the change
 * again makes another body, which the key refuses as `duplicate`, so a retry
 * must resend the bytes it sent first.
 */
export type CallOptions = { idempotencyKey?: string };

type CallArgs<R extends RouteDef> =
  object extends CallInput<R>
    ? [input?: CallInput<R>, options?: CallOptions]
    : [input: CallInput<R>, options?: CallOptions];

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A typed client for the contracts in `@wikistow/contracts`. Browsers send
 * the session cookie (same origin); other clients pass their own `fetch`.
 * An agent passes its bearer `token`, and sends no cookie (section 9.6).
 * Every response is parsed through its contract, so a malformed answer from
 * the server fails here instead of flowing into the app. That includes
 * defects `JSON.parse` hides (see `readJson`).
 *
 *   const api = createApiClient();
 *   const { account } = await api.call(accountRoutes.me);
 */
export function createApiClient({
  baseUrl = '',
  fetch: send = (url, init) => globalThis.fetch(url, init),
  token,
}: { baseUrl?: string; fetch?: Fetch; token?: string } = {}) {
  // fetch rejects only when no answer came back (no connection, a dropped
  // one, CORS); every answer, even an error, resolves.
  async function fetch(path: string, init: RequestInit): Promise<Response> {
    const request =
      token === undefined
        ? init
        : {
            ...init,
            credentials: 'omit' as const,
            headers: {
              ...(init.headers as Record<string, string>),
              authorization: `Bearer ${token}`,
            },
          };
    try {
      return await send(baseUrl + path, request);
    } catch (cause) {
      throw new ApiError(0, 'network', `No answer from ${path}`, {}, { cause });
    }
  }

  async function call<R extends RouteDef>(
    route: R,
    ...args: CallArgs<R>
  ): Promise<z.output<R['response']>> {
    const input: { params?: unknown; query?: unknown; body?: unknown } = args[0] ?? {};
    const { idempotencyKey } = args[1] ?? {};
    const hasBody = 'body' in input && input.body !== undefined;
    const res = await fetch(url(route, input), {
      method: route.method,
      credentials: 'same-origin',
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    });
    const { json, defective } = await readJson(res);
    if (!res.ok) throw toError(res.status, json);
    const parsed = route.response.safeParse(json);
    if (defective || !parsed.success)
      throw new ApiError(
        res.status,
        'unreadable-response',
        `Unexpected response from ${route.path}`,
      );
    // Validated by the route's own schema just above; the compiler can't follow
    // a generic route's schema type through safeParse.
    return parsed.data as z.output<R['response']>;
  }

  /** Send raw bytes (an encrypted blob) and parse the JSON answer with `response`. */
  async function upload<S extends z.ZodType>(
    path: string,
    bytes: Uint8Array,
    response: S,
  ): Promise<z.output<S>> {
    const res = await fetch(path, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    const { json, defective } = await readJson(res);
    if (!res.ok) throw toError(res.status, json);
    const parsed = response.safeParse(json);
    if (defective || !parsed.success)
      throw new ApiError(res.status, 'unreadable-response', `Unexpected response from ${path}`);
    return parsed.data;
  }

  /** Fetch raw bytes (an encrypted blob). */
  async function download(path: string): Promise<Uint8Array> {
    const res = await fetch(path, { method: 'GET', credentials: 'same-origin' });
    if (!res.ok) throw toError(res.status, await res.json().catch(() => undefined));
    return new Uint8Array(await res.arrayBuffer());
  }

  return { call, upload, download };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function url(route: RouteDef, input: { params?: unknown; query?: unknown }): string {
  const params = isRecord(input.params) ? input.params : {};
  const path = route.path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path parameter ${name} for ${route.path}`);
    return encodeURIComponent(scalar(value, name));
  });
  if (!isRecord(input.query)) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query)) {
    if (value !== undefined) query.set(key, scalar(value, key));
  }
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/**
 * A response body as JSON (`undefined` if it isn't any), and whether it has a
 * defect `JSON.parse` would hide: a duplicate member name, an ill-formed
 * string, or a number not written as a plain safe integer. Answers carry
 * signed records, envelopes, key wraps and owner statements, which section
 * 3.3 (rules 6 and 7) requires to be read from the raw text, since
 * `JSON.parse` reads `1.0` as `1` and keeps the last of two members. Every
 * number in every contract is an integer, and the server writes with
 * `JSON.stringify`, so an honest answer never has one. Error bodies only name
 * a code, so callers read them whatever their defects.
 */
async function readJson(res: Response): Promise<{ json: unknown; defective: boolean }> {
  try {
    const { value, defects } = parseJsonText(await res.text());
    return { json: value, defective: defects.length > 0 };
  } catch {
    return { json: undefined, defective: false };
  }
}

function toError(status: number, json: unknown): ApiError {
  const body = ApiErrorBody.safeParse(json);
  return body.success
    ? new ApiError(status, body.data.error.code, body.data.error.message, body.data.error.detail)
    : new ApiError(status, 'unreadable-response', `Request failed with status ${status}`);
}

/** Path and query values must be plain scalars; anything else is a caller bug. */
function scalar(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`${name} must be a string, number, or boolean`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
