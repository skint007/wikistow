import { SECURITY_HEADERS } from '@wikistow/contracts';
import type { MiddlewareHandler } from 'hono';

export function securityHeaders({ https }: { https: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
    if (https) c.res.headers.set('Strict-Transport-Security', 'max-age=31536000');
  };
}
