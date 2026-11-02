// Waiting out the server's rate limits, for work of many requests in a
// row: a copy of many pages, or an import of many notes.
import { ApiError, type ApiClient } from '../api/client.ts';
import type { ClientContext } from './session.ts';

/** How long one request waits out the server's rate limits, in all, before giving up. */
const PATIENCE_MS = 2 * 60 * 1000;

/** Wait `ms`, or throw `stopped()` as soon as `signal` aborts. */
export const pause = (ms: number, stopped: () => Error, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(stopped());
    const stop = () => {
      clearTimeout(timer);
      reject(stopped());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * `ctx` with an API that waits out `rate-limited` and tries again, as long
 * as the server's `Retry-After` says (a second if it doesn't), for up to
 * `PATIENCE_MS` a request. A wait ends early when `signal` aborts, throwing
 * `stopped()`.
 */
export function patient(
  ctx: ClientContext,
  stopped: () => Error,
  signal?: AbortSignal,
): ClientContext {
  const waiting = async <T>(send: () => Promise<T>): Promise<T> => {
    const until = Date.now() + PATIENCE_MS;
    for (;;) {
      try {
        return await send();
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'rate-limited') throw error;
        const ms = (error.retryAfterSeconds ?? 1) * 1000;
        if (Date.now() + ms > until) throw error;
        await pause(ms, stopped, signal);
      }
    }
  };
  const { api } = ctx;
  const patientApi: ApiClient = {
    call: ((...args: Parameters<ApiClient['call']>) =>
      waiting(() => api.call(...args))) as ApiClient['call'],
    upload: (...args) => waiting(() => api.upload(...args)),
    download: (...args) => waiting(() => api.download(...args)),
  };
  return { ...ctx, api: patientApi };
}
