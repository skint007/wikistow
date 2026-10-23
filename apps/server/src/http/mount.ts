import type {
  RouteDef,
  RouteInput,
  RouteOutput,
  StreamBody,
  StreamRouteDef,
} from '@wikistow/contracts';
import { hash, utf8 } from '@wikistow/client';
import { consumeRateLimit, type Actor, type Database, type Once } from '@wikistow/server';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import type { Auth } from '../auth/auth.ts';
import type { Config } from '../config.ts';
import { hasBearer, requireAgent } from './agent-principal.ts';
import { clientAddress, rateLimitKey } from './client-address.ts';
import type { AppEnv } from './env.ts';
import { ApiError } from './errors.ts';
import { isRecentlyAuthenticated, requirePrincipal, type Principal } from './principal.ts';

/** How long a stream route waits on its handler before sending a blank line. */
const STREAM_KEEPALIVE_MS = 15_000;

type Handler<R extends RouteDef, Ctx> = (
  input: RouteInput<R>,
  ctx: Ctx,
) => RouteOutput<R> | Promise<RouteOutput<R>>;
type PublicCtx = { c: Context<AppEnv> };
type AccountCtx = {
  c: Context<AppEnv>;
  principal: Principal;
  /** A lower body limit the route's early check set for this caller. */
  lowerLimit?: number | undefined;
};
/**
 * A content route's caller: a person, or an agent acting for one (protocol
 * section 9.5). `once` is the request's `Idempotency-Key`, on a route that
 * takes one, for the handler to hand to its change (`transactOnce`).
 */
type ContentCtx = { c: Context<AppEnv>; actor: Actor; once?: Once };
/** Who an early check (`beforeBody`) is for: a person, or on a content route, their agent. */
export type EarlyCaller = { accountId: string; agentId?: string | null };
type RateLimit = { windowSeconds: number; max: number };

type Options = {
  /** A fixed limit, or one read for each request (the AI routes', from settings). */
  rateLimit?: RateLimit | (() => Promise<RateLimit | null>);
  /** Require a full sign-in within the last few minutes (account routes). */
  recentAuth?: boolean;
  /**
   * A body limit above the app-wide 1 MiB, in bytes, for a signed-in route,
   * which the app-wide limiter then leaves to it (`hasOwnBodyLimit`). It
   * applies once the session is checked, the body must arrive within
   * `bodyDeadlineMs`, and only so many such bodies are read at once in its
   * `bodyPool`, per account and in all.
   */
  bodyLimit?: number;
  /**
   * The large-body slots it takes: `bulk` (the default), `rotation` or
   * `staging`. Rotations and owner removals have their own, so large shares
   * being made can't hold off removing someone, and so does staging a
   * public copy, which holds its slot while the copy renders.
   */
  bodyPool?: BodyPool;
  /**
   * Checked once the session is, before the body is read: for a route with
   * a large body, that the caller may take the action at all, so nobody
   * else can make the server read and parse one. It may answer a lower body
   * limit for this caller, whose body then takes no large-body slot.
   */
  beforeBody?: (
    params: Record<string, string>,
    caller: EarlyCaller,
  ) => Promise<number | undefined | void>;
  /**
   * A content change that takes an `Idempotency-Key`, which its handler
   * hands to the change as `once`. Every other route refuses the header.
   */
  idempotent?: boolean;
};

/** Large bodies read and handled at once in each pool, by one account and in all. */
const BULK_PER_ACCOUNT = 1;
const BULK_AT_ONCE = 4;

export type BodyPool = 'bulk' | 'rotation' | 'staging';

// A pool's large bodies being read or handled now, in all and by account:
// a slot for `accountId`, or `rate-limited` if none is free.
function bodySlots() {
  let inFlight = 0;
  const byAccount = new Map<string, number>();
  return (accountId: string): (() => void) => {
    const mine = byAccount.get(accountId) ?? 0;
    if (mine >= BULK_PER_ACCOUNT || inFlight >= BULK_AT_ONCE) {
      throw new ApiError('rate-limited', 'Too many large requests at once; try again shortly');
    }
    inFlight++;
    byAccount.set(accountId, mine + 1);
    return () => {
      inFlight--;
      const left = (byAccount.get(accountId) ?? 1) - 1;
      if (left > 0) byAccount.set(accountId, left);
      else byAccount.delete(accountId);
    };
  };
}

/** An `Idempotency-Key`: up to 200 of these characters. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,200}$/;

// A route path, `:name` segments and all, as a pattern for request paths.
const pathPattern = (path: string) =>
  new RegExp(
    `^${path
      .split('/')
      .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}$`,
  );

/**
 * Route registration with access stated at every call site:
 *
 *   routes.public(accountRoutes.createAccount, handler, { rateLimit: { windowSeconds: 60, max: 10 } });
 *   routes.account(accountRoutes.me, (input, { principal }) => ...);
 *   routes.admin(adminRoutes.suspend, (input, { principal }) => ...);
 *
 * Every route validates params, query, and body before its handler runs and
 * parses the response through the contract, so it can't send undeclared
 * fields. State-changing requests from another origin are refused.
 */
export function createRoutes({
  app,
  auth,
  db,
  config,
}: {
  app: Hono<AppEnv>;
  auth: Auth;
  db: Database;
  config: Config;
}) {
  // Routes with their own body limit, which the app-wide limiter skips.
  const ownLimits: { method: string; path: RegExp }[] = [];
  const takeSlot: Record<BodyPool, ReturnType<typeof bodySlots>> = {
    bulk: bodySlots(),
    rotation: bodySlots(),
    staging: bodySlots(),
  };

  // Signed-in routes check the session, and count toward the account's rate
  // limit, before the body is read: nobody without a session can make the
  // server buffer or parse one.
  function register<R extends RouteDef, Ctx>(
    route: R,
    options: Options,
    authorize: (c: Context<AppEnv>) => Promise<Ctx>,
    run: (input: RouteInput<R>, ctx: Ctx) => RouteOutput<R> | Promise<RouteOutput<R>>,
    accountOf: (ctx: Ctx) => string | null,
    /** Who an `Idempotency-Key` is kept for, on routes that take one (`options.idempotent`). */
    idempotentFor?: (ctx: Ctx) => string,
    /** A lower body limit `beforeBody` set for this caller. */
    lowerLimitOf: (ctx: Ctx) => number | undefined = () => undefined,
  ) {
    if (options.idempotent && (!idempotentFor || route.method === 'GET')) {
      throw new Error(`${route.path}: only content changes take an Idempotency-Key`);
    }
    if (options.bodyLimit !== undefined) {
      ownLimits.push({ method: route.method, path: pathPattern(route.path) });
    }
    app.on(route.method, route.path, async (c) => {
      checkOrigin(c, route, config.publicOrigin);
      const ctx = await authorize(c);
      const key = c.req.header('idempotency-key');
      if (key !== undefined && !options.idempotent) refuseKey();
      const account = accountOf(ctx);
      const lower = lowerLimitOf(ctx);
      const release =
        options.bodyLimit === undefined || account === null || lower !== undefined
          ? null
          : takeSlot[options.bodyPool ?? 'bulk'](account);
      try {
        const limit =
          options.bodyLimit === undefined
            ? undefined
            : {
                bytes: Math.min(options.bodyLimit, lower ?? options.bodyLimit),
                deadlineMs: config.bodyDeadlineMs,
              };
        const body = route.body ? await readJson(c, limit) : undefined;
        const input = {
          params: parsePart(route.params, c.req.param(), 'params'),
          query: parsePart(route.query, c.req.query(), 'query'),
          body: parsePart(route.body, body, 'body'),
        };
        const once =
          key === undefined || !options.idempotent || !idempotentFor
            ? undefined
            : onceFor(idempotentFor(ctx), key, `${route.method} ${c.req.path}`, body);
        // Every part was just validated by its schema; this only restates that for
        // the compiler, which can't follow optional schemas through RouteInput.
        const answer = await run(input as RouteInput<R>, once ? { ...ctx, once } : ctx);
        return c.json(route.response.parse(answer), route.status ?? 200);
      } finally {
        release?.();
      }
    });
  }

  // A change sent with an `Idempotency-Key` is handled once: a retry with
  // the same key and the identical request gets the first answer again, and
  // the same key with another request is refused (`transactOnce`).
  function onceFor(callerId: string, key: string, target: string, body: unknown): Once {
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new ApiError(
        'invalid-request',
        'An Idempotency-Key is 1 to 200 letters, digits or _.:-',
      );
    }
    return { callerId, key, requestHash: hash(utf8(`${target}\n${JSON.stringify(body ?? null)}`)) };
  }

  async function enforceRateLimit(
    c: Context<AppEnv>,
    key: string,
    given: NonNullable<Options['rateLimit']>,
  ) {
    const limit = typeof given === 'function' ? await given() : given;
    if (!limit) return;
    const result = await consumeRateLimit(db, key, {
      windowMs: limit.windowSeconds * 1000,
      max: limit.max,
    });
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSeconds));
      throw new ApiError('rate-limited', 'Too many requests; try again shortly');
    }
  }

  function limitAccount(
    c: Context<AppEnv>,
    route: Pick<RouteDef, 'method' | 'path'>,
    principal: Principal,
    options: Options,
  ) {
    if (!options.rateLimit || !config.rateLimit) return;
    const key = `${route.method} ${route.path} account:${principal.accountId}`;
    return enforceRateLimit(c, key, options.rateLimit);
  }

  // A person by their session, or an agent by its bearer token.
  async function requireActor(c: Context<AppEnv>): Promise<Actor> {
    if (hasBearer(c)) {
      const agent = await requireAgent(db, c, config.publicOrigin);
      return { accountId: agent.accountId, agentId: agent.agentId };
    }
    const principal = await requirePrincipal(auth, c);
    return { accountId: principal.accountId, agentId: null };
  }

  function limitActor(
    c: Context<AppEnv>,
    target: string,
    actor: Actor,
    limit: Options['rateLimit'],
  ) {
    if (!limit || !config.rateLimit) return;
    // Each agent counts on its own, so a person with k agents has k + 1
    // allowances (and large-body slots); their storage quota is one.
    const who = actor.agentId === null ? `account:${actor.accountId}` : `agent:${actor.agentId}`;
    return enforceRateLimit(c, `${target} ${who}`, limit);
  }

  return {
    /** Whether a registered route sets its own body limit for this request. */
    hasOwnBodyLimit(method: string, path: string): boolean {
      return ownLimits.some((own) => own.method === method && own.path.test(path));
    },
    public<R extends RouteDef>(route: R, handler: Handler<R, PublicCtx>, options: Options = {}) {
      if (options.bodyLimit !== undefined || options.bodyPool || options.beforeBody) {
        throw new Error(`${route.path}: only signed-in routes take a larger body`);
      }
      register(
        route,
        options,
        async (c): Promise<PublicCtx> => {
          // Public routes count per client.
          if (options.rateLimit && config.rateLimit) {
            const client = rateLimitKey(clientAddress(c, config.trustProxy));
            await enforceRateLimit(c, `${route.method} ${route.path} ${client}`, options.rateLimit);
          }
          return { c };
        },
        handler,
        () => null,
      );
    },
    account<R extends RouteDef>(route: R, handler: Handler<R, AccountCtx>, options: Options = {}) {
      register(
        route,
        options,
        async (c): Promise<AccountCtx> => {
          const principal = await requirePrincipal(auth, c);
          await limitAccount(c, route, principal, options);
          if (options.recentAuth && !isRecentlyAuthenticated(principal.authenticatedAt)) {
            throw new ApiError('reauth-required', 'Sign in again to make this change');
          }
          const lowerLimit = (await options.beforeBody?.(c.req.param(), principal)) ?? undefined;
          return { c, principal, lowerLimit };
        },
        handler,
        ({ principal }) => principal.accountId,
        undefined,
        ({ lowerLimit }) => lowerLimit,
      );
    },
    /**
     * A content route (protocol section 9.5): for a signed-in person, or for
     * one of their agents presenting its bearer token. Its rate limit counts
     * per person or agent, and a change that says so (`idempotent`) takes
     * an `Idempotency-Key`. Everything else stays for people only.
     */
    content<R extends RouteDef>(route: R, handler: Handler<R, ContentCtx>, options: Options = {}) {
      if (options.recentAuth) {
        throw new Error(`${route.path}: content routes take no recent sign-in`);
      }
      register(
        route,
        options,
        async (c): Promise<ContentCtx & { lowerLimit?: number | undefined }> => {
          const actor = await requireActor(c);
          await limitActor(c, `${route.method} ${route.path}`, actor, options.rateLimit);
          const lowerLimit = (await options.beforeBody?.(c.req.param(), actor)) ?? undefined;
          return { c, actor, lowerLimit };
        },
        handler,
        ({ actor }) => actor.agentId ?? actor.accountId,
        ({ actor }) => actor.agentId ?? actor.accountId,
        ({ lowerLimit }) => lowerLimit,
      );
    },
    /**
     * A content route that sends or receives raw bytes (attachment blobs),
     * with the same origin and caller checks as the JSON routes. Its rate
     * limit counts per person or agent.
     */
    binary(
      method: 'GET' | 'PUT',
      path: string,
      handler: (c: Context<AppEnv>, actor: Actor) => Promise<Response>,
      options: Pick<Options, 'rateLimit'> = {},
    ) {
      app.on(method, path, async (c) => {
        checkOrigin(c, { method }, config.publicOrigin);
        const actor = await requireActor(c);
        if (c.req.header('idempotency-key') !== undefined) refuseKey();
        await limitActor(c, `${method} ${path}`, actor, options.rateLimit);
        return handler(c, actor);
      });
    },
    /**
     * A signed-in person's raw upload (their avatar), never an agent's: the
     * same origin, session and rate limit checks as `account`. The body is
     * read whole, in a `bulk` large-body slot, and refused past `maxBytes`,
     * stated or streamed, or once it has taken the large-body deadline to
     * arrive.
     */
    upload(
      path: string,
      maxBytes: number,
      handler: (bytes: Uint8Array, ctx: AccountCtx) => Promise<Response>,
      options: Pick<Options, 'rateLimit'> = {},
    ) {
      const route = { method: 'PUT', path } as const;
      ownLimits.push({ method: route.method, path: pathPattern(path) });
      app.on(route.method, path, async (c) => {
        checkOrigin(c, route, config.publicOrigin);
        const principal = await requirePrincipal(auth, c);
        if (c.req.header('idempotency-key') !== undefined) refuseKey();
        await limitAccount(c, route, principal, options);
        const release = takeSlot.bulk(principal.accountId);
        try {
          const bytes = await readLimited(c.req.raw, {
            bytes: maxBytes,
            deadlineMs: config.bodyDeadlineMs,
          });
          return await handler(bytes, { c, principal });
        } finally {
          release();
        }
      });
    },
    /**
     * Raw bytes for any signed-in person, never an agent (library plugins'
     * files). Its rate limit counts per account.
     */
    file(
      path: string,
      handler: (c: Context<AppEnv>, principal: Principal) => Promise<Response>,
      options: Pick<Options, 'rateLimit'> = {},
    ) {
      app.get(path, async (c) => {
        const principal = await requirePrincipal(auth, c);
        await limitAccount(c, { method: 'GET', path }, principal, options);
        return handler(c, principal);
      });
    },
    /** Raw bytes anyone may fetch, with no session (avatars). Its rate limit counts per client. */
    publicFile(
      path: string,
      handler: (c: Context<AppEnv>) => Promise<Response>,
      options: Pick<Options, 'rateLimit'> = {},
    ) {
      app.get(path, async (c) => {
        if (options.rateLimit && config.rateLimit) {
          const client = rateLimitKey(clientAddress(c, config.trustProxy));
          await enforceRateLimit(c, `GET ${path} ${client}`, options.rateLimit);
        }
        return handler(c);
      });
    },
    /**
     * A signed-in route that answers with a stream of JSON lines, one
     * `route.event` each (the AI proxy, the tree changes). The same origin,
     * session, rate limit and body checks as `account`; the handler writes
     * the stream, and it ends when the handler's events do.
     */
    stream<R extends StreamRouteDef>(
      route: R,
      handler: (
        body: StreamBody<R>,
        ctx: AccountCtx & { signal: AbortSignal },
      ) => AsyncIterable<z.input<R['event']>> | Promise<AsyncIterable<z.input<R['event']>>>,
      options: Pick<Options, 'rateLimit'> = {},
    ) {
      app.on(route.method, route.path, async (c) => {
        checkOrigin(c, route, config.publicOrigin);
        const principal = await requirePrincipal(auth, c);
        if (c.req.header('idempotency-key') !== undefined) refuseKey();
        await limitAccount(c, route, principal, options);
        // Validated by the route's own schema; the compiler can't follow the
        // GET or POST route's body schema through `parsed`.
        const body = (
          route.body ? parsed(route.body, await readJson(c), 'body') : undefined
        ) as StreamBody<R>;
        // Ends when the client leaves or cancels the stream, so the
        // handler can stop its own work (the provider's request) at once.
        const left = new AbortController();
        const signal = AbortSignal.any([c.req.raw.signal, left.signal]);
        const events = await handler(body, { c, principal, signal });
        const iterator = events[Symbol.asyncIterator]();
        const encoder = new TextEncoder();
        // The event being waited for, kept across a keep-alive. Handled here
        // too, as nothing awaits it while the reader takes no more.
        let pending: ReturnType<typeof iterator.next> | null = null;
        // Pulled one event at a time, so a slow reader slows the provider's
        // stream rather than filling memory.
        const lines = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!pending) {
              pending = iterator.next();
              pending.catch(() => {});
            }
            // A reasoning model can think for minutes before its first word.
            // A blank line while it does, which readers skip, keeps the
            // server's idle timeout and any proxy's from closing the stream.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const quiet = new Promise<null>((resolve) => {
              timer = setTimeout(resolve, STREAM_KEEPALIVE_MS, null);
            });
            const next = await Promise.race([pending, quiet]).finally(() => clearTimeout(timer));
            if (next === null) {
              controller.enqueue(encoder.encode('\n'));
              return;
            }
            pending = null;
            if (next.done) controller.close();
            else
              controller.enqueue(
                encoder.encode(`${JSON.stringify(route.event.parse(next.value))}\n`),
              );
          },
          async cancel() {
            left.abort();
            await iterator.return?.();
          },
        });
        // Through Hono, so the session cookie `requirePrincipal` renewed goes too.
        return c.body(lines, 200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-store',
        });
      });
    },
    /** Administrators only. Anything but a GET also needs a recent sign-in. */
    admin<R extends RouteDef>(route: R, handler: Handler<R, AccountCtx>, options: Options = {}) {
      register(
        route,
        options,
        async (c): Promise<AccountCtx> => {
          const principal = await requirePrincipal(auth, c);
          await limitAccount(c, route, principal, options);
          if (principal.role !== 'admin') throw new ApiError('forbidden', 'Administrators only');
          // A recent sign-in with every factor, not merely a recent session.
          if (route.method !== 'GET' && !isRecentlyAuthenticated(principal.authenticatedAt)) {
            throw new ApiError('reauth-required', 'Sign in again to make this change');
          }
          await options.beforeBody?.(c.req.param(), principal);
          return { c, principal };
        },
        handler,
        ({ principal }) => principal.accountId,
      );
    },
  };
}

export type Routes = ReturnType<typeof createRoutes>;

// Browsers always send Origin on cross-site writes. Requests without one (the
// CLI, server-to-server) can't carry a victim's cookies from another site.
function checkOrigin(c: Context<AppEnv>, route: Pick<RouteDef, 'method'>, publicOrigin: string) {
  if (route.method === 'GET') return;
  const origin = c.req.header('origin');
  if (origin !== undefined && origin !== publicOrigin) {
    throw new ApiError('forbidden', 'Cross-origin request refused');
  }
}

// Only the content changes that say so take an `Idempotency-Key`: a key on
// any other request is refused, rather than ignored, so a client relying on
// it learns that it can't.
function refuseKey(): never {
  throw new ApiError('invalid-request', 'This request takes no Idempotency-Key');
}

// A large invalid body has many issues; a few are enough to fix a request.
const MAX_ISSUES = 20;

function parsePart(schema: z.ZodType | undefined, value: unknown, part: string): unknown {
  return schema ? parsed(schema, value, part) : undefined;
}

function parsed<S extends z.ZodType>(schema: S, value: unknown, part: string): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(
    'invalid-request',
    `Invalid request ${part}`,
    result.error.issues.slice(0, MAX_ISSUES).map((issue) => ({
      path: [part, ...issue.path].join('.'),
      message: issue.message,
    })),
  );
}

// Requiring a JSON content type also stops cross-site form posts, which can't set it.
async function readJson(
  c: Context<AppEnv>,
  limit?: { bytes: number; deadlineMs: number },
): Promise<unknown> {
  if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError('invalid-request', 'Expected a JSON body');
  }
  const text =
    limit === undefined
      ? await c.req.text()
      : new TextDecoder().decode(await readLimited(c.req.raw, limit));
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('invalid-request', 'Body is not valid JSON');
  }
}

// The body, refused once it passes `bytes`, stated or streamed, or once it
// has taken `deadlineMs` to arrive, so a slow sender can't hold a large-body
// slot for long.
async function readLimited(
  request: Request,
  { bytes, deadlineMs }: { bytes: number; deadlineMs: number },
): Promise<Uint8Array> {
  const tooLarge = () => new ApiError('payload-too-large', 'Request body is too large');
  if (Number(request.headers.get('content-length')) > bytes) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let late = false;
  const deadline = setTimeout(() => {
    late = true;
    reader.cancel().catch(() => {});
  }, deadlineMs);
  const tooSlow = () => new ApiError('request-timeout', 'Request body took too long to arrive');
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read().catch((error: unknown) => {
        throw late ? tooSlow() : error;
      });
      if (late) throw tooSlow();
      if (done) break;
      size += value.byteLength;
      if (size > bytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(deadline);
  }
}
