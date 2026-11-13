import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono, MiddlewareHandler } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
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
 * Serve the built web app. Hashed files under /assets are cached forever,
 * and sent as their Brotli copy beside them (`.br`), where the build wrote
 * one and the browser accepts it: the search model and the runtime's
 * WebAssembly (ADR 0016, decision 3). Everything else is revalidated. Any
 * other extensionless path outside /api and /assets gets index.html, so
 * client-side routes load directly.
 */
export function serveWebApp(app: Hono<AppEnv>, webDist: string): void {
  const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf8');

  // A file with a Brotli copy says it varies, whichever it is sent as, so
  // a shared cache never keeps one encoding for every browser.
  const compressed = (path: string) => existsSync(join(webDist, `${path}.br`));
  const varies: MiddlewareHandler<AppEnv> = async (c, next) => {
    await next();
    if (c.res.ok && !c.res.headers.has('Vary') && compressed(c.req.path)) {
      c.res.headers.set('Vary', 'Accept-Encoding');
    }
  };
  app.use(
    '/assets/*',
    cacheFor(IMMUTABLE),
    varies,
    serveStatic({ root: webDist, precompressed: true }),
  );
  app.get('*', cacheFor('no-cache'), serveStatic({ root: webDist }), (c) => {
    const path = c.req.path;
    const reserved = path.startsWith('/api/') || path === '/assets' || path.startsWith('/assets/');
    if (reserved || extname(path) !== '') return c.notFound();
    return c.html(indexHtml);
  });
}
