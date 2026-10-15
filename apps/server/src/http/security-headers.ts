import { securityHeadersFor } from '@wikistow/contracts';
import type { MiddlewareHandler } from 'hono';

/**
 * The app's headers on every response, with the plugin host frame's
 * exceptions (`securityHeadersFor`). A response that sets its own Content
 * Security Policy keeps it: avatars send a stricter one that also
 * sandboxes the image, should someone open it on its own.
 */
export function securityHeaders({
  https,
  origin,
}: {
  https: boolean;
  origin: string;
}): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(securityHeadersFor(c.req.path, origin))) {
      if (name === 'Content-Security-Policy' && c.res.headers.has(name)) continue;
      c.res.headers.set(name, value);
    }
    if (https) c.res.headers.set('Strict-Transport-Security', 'max-age=31536000');
  };
}
