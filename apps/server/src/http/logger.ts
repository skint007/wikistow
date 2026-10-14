import type { MiddlewareHandler } from 'hono';

type LogValue = string | number | boolean | undefined;

/**
 * A structured log line. Only IDs, route patterns, codes, and timings belong
 * here: never request bodies, query strings, or anything a user typed.
 */
export type LogEntry = { level: 'info' | 'warn' | 'error'; event: string } & Record<
  string,
  LogValue
>;

export type Log = (entry: LogEntry) => void;

export const stdoutLog: Log = (entry) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
};

/** One line per request. Logs the matched route pattern, so IDs and queries never appear. */
export function requestLogger(log: Log): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    log({
      level: c.res.status >= 500 ? 'error' : 'info',
      event: 'request',
      method: c.req.method,
      route: c.req.routePath,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}
