import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono, MiddlewareHandler } from 'hono';
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { AppEnv } from './env.ts';

const IMMUTABLE = 'public, max-age=31536000, immutable';

// serveStatic builds its own response, so cache headers go on after it returns.
const cacheFor =
  (value: string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set('Cache-Control', value);
  };

/**
 * Serve the built web app. Hashed files under /assets are cached forever;
 * everything else is revalidated. Any other extensionless path outside /api
 * and /assets gets index.html, so client-side routes load directly.
 */
export function serveWebApp(app: Hono<AppEnv>, webDist: string): void {
  const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf8');

  app.use('/assets/*', cacheFor(IMMUTABLE), serveStatic({ root: webDist }));
  app.get('*', cacheFor('no-cache'), serveStatic({ root: webDist }), (c) => {
    const path = c.req.path;
    const reserved = path.startsWith('/api/') || path === '/assets' || path.startsWith('/assets/');
    if (reserved || extname(path) !== '') return c.notFound();
    return c.html(indexHtml);
  });
}
