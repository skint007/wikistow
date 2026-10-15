import type { BlobStore, Database } from '@wikistow/server';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CLIENT_ADDRESS_HEADER,
  createAuth,
  EQUAL_TIME_AUTH_PATHS,
  EQUAL_TIME_FLOOR_MS,
  RECENT_SIGN_IN_AUTH_PATHS,
  SESSION_CODE_PATHS,
} from './auth/auth.ts';
import { createPasswordGuesses } from './auth/password-guesses.ts';
import type { Config } from './config.ts';
import { clientAddress } from './http/client-address.ts';
import type { AppEnv } from './http/env.ts';
import { ApiError, errorResponse, onError } from './http/errors.ts';
import { requestLogger, type Log } from './http/logger.ts';
import { isRecentlyAuthenticated } from './http/principal.ts';
import { createRoutes } from './http/mount.ts';
import { securityHeaders } from './http/security-headers.ts';
import { serveWebApp } from './http/static.ts';
import type { Deliver } from './mail/mailer.ts';
import { mountAccountRoutes } from './routes/accounts.ts';
import { mountAdminRoutes } from './routes/admin.ts';
import { mountAiRoutes } from './routes/ai.ts';
import { mountAgentRoutes } from './routes/agents.ts';
import { mountContentRoutes } from './routes/content.ts';
import { mountDesktopRoutes } from './routes/desktop.ts';
import { mountSystemRoutes } from './routes/system.ts';

/**
 * Run `task` after any earlier task with the same key has finished. In
 * process only: WikiStow runs as a single server.
 */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

export type AppDeps = {
  db: Database;
  config: Config;
  log: Log;
  deliver: Deliver;
  blobs: BlobStore;
};

const BLOB_UPLOAD = /^\/api\/pages\/[^/]+\/blobs$/;

const JSON_BODY_LIMIT = 1024 * 1024;

/** Build the whole HTTP app. Tests call this with their own database, log sink, and mailbox. */
export function createApp({ db, config, log, deliver, blobs }: AppDeps) {
  const app = new Hono<AppEnv>();
  const guesses = createPasswordGuesses({ db, config });
  const auth = createAuth({ db, config, deliver, log, guesses });

  app.use(
    securityHeaders({
      https: config.publicOrigin.startsWith('https:'),
      origin: config.publicOrigin,
    }),
  );
  app.use(requestLogger(log));
  const tooLarge = (c: Context<AppEnv>) =>
    errorResponse(c, new ApiError('payload-too-large', 'Request body is too large'));
  const jsonLimit = bodyLimit({ maxSize: JSON_BODY_LIMIT, onError: tooLarge });
  // Attachment uploads stream to disk, so their limit is checked from the
  // stated length (and again while streaming) rather than by buffering the
  // body, which Hono's limiter does when no length is given. Everything else
  // is small JSON.
  const blobLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
    const length = Number(c.req.header('content-length'));
    if (length > config.limits.uploadBytes) return tooLarge(c);
    await next();
  };
  app.use('/api/*', (c, next) => {
    if (BLOB_UPLOAD.test(c.req.path)) return blobLimit(c, next);
    // Owner actions that carry a wrap or envelope for every record or member
    // set their own, larger limit, which applies once the session is checked.
    return routes.hasOwnBodyLimit(c.req.method, c.req.path) ? next() : jsonLimit(c, next);
  });

  // Answers that would show whether an address has an account take a fixed
  // time. Matched on the raw path, as Better Auth's router matches it.
  app.use('/api/auth/*', async (c, next) => {
    const path = new URL(c.req.url).pathname.slice('/api/auth'.length);
    if (!(EQUAL_TIME_AUTH_PATHS as readonly string[]).includes(path)) return next();
    const started = performance.now();
    await next();
    let remaining: number;
    while ((remaining = EQUAL_TIME_FLOOR_MS - (performance.now() - started)) > 0) {
      await sleep(remaining);
    }
  });
  // Better Auth matches disabled paths literally, so the parameterised OAuth
  // callback is closed here. No social providers are configured anyway.
  app.all('/api/auth/callback/*', (c) => errorResponse(c, new ApiError('not-found', 'Not found')));
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    // Suspension applies to every authenticated request, Better Auth's included.
    // Refresh is left to Better Auth's own handler, which sends the renewed cookie.
    const current = c.req.header('cookie')
      ? await auth.api.getSession({ headers: c.req.raw.headers, query: { disableRefresh: true } })
      : null;
    if (current?.user.suspendedAt)
      throw new ApiError('account-suspended', 'This account is suspended');
    // Code checks made with an existing session (confirming a new
    // authenticator) also need a recent sign-in. Otherwise a stale stolen
    // session could guess codes until one lands and comes out "recent". The
    // sign-in flow itself carries no session, so it is unaffected.
    const gated =
      RECENT_SIGN_IN_AUTH_PATHS.has(c.req.path) ||
      (current !== null && SESSION_CODE_PATHS.has(c.req.path));
    if (gated && !isRecentlyAuthenticated(current?.session.authenticatedAt)) {
      throw new ApiError('reauth-required', 'Sign in again to change two-factor settings');
    }
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_ADDRESS_HEADER);
    const address = clientAddress(c, config.trustProxy);
    if (isIP(address)) headers.set(CLIENT_ADDRESS_HEADER, address);
    const request = new Request(c.req.raw, { headers });
    // Better Auth checks for an authenticator and then adds one, outside any
    // transaction. One setup at a time per account keeps that from racing;
    // the unique index on the account is the backstop.
    const handle =
      c.req.path === '/api/auth/two-factor/enable' && current
        ? () => oneAtATime(`2fa:${current.user.id}`, () => auth.handler(request))
        : () => auth.handler(request);
    // Password checks here spend the signed-in account's allowance, or at
    // sign-in the submitted address's (see the before-hook in auth.ts).
    const { result, setCookies } = await guesses.scope(
      { email: current?.user.email ?? null, cookie: c.req.header('cookie') },
      handle,
    );
    for (const cookie of setCookies) result.headers.append('set-cookie', cookie);
    return result;
  });
  const routes = createRoutes({ app, auth, db, config });
  mountSystemRoutes(routes, { db, publicOrigin: config.publicOrigin });
  mountAccountRoutes(routes, {
    db,
    auth,
    guesses,
    deliver,
    log,
    publicOrigin: config.publicOrigin,
  });
  mountAdminRoutes(routes, { db, auth, config, deliver, log });
  mountContentRoutes(routes, {
    db,
    blobs,
    limits: config.limits,
    contentLimits: config.contentLimits,
    minKdf: config.minKdf,
    log,
  });
  mountAgentRoutes(routes, { db });
  mountDesktopRoutes(routes, { db, auth });
  mountAiRoutes(routes, { ai: config.ai ?? null, log });
  if (config.webDist) serveWebApp(app, config.webDist);

  app.notFound((c) => errorResponse(c, new ApiError('not-found', 'Not found')));
  app.onError(onError(log));
  return { app, auth };
}
