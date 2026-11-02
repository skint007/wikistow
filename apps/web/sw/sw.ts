// The browser app's service worker (ADR 0009, decision 6). It serves the
// app's own files when the server can't, so the app loads offline. It never
// stores anything else: no API answer, no public page, nothing per account.
// The build writes it to `/sw.js` (`appShell` in vite.config.ts), with
// `SHELL` naming this build's cache and the files it keeps.

// A module to the type checker, so `self` can be the worker's scope. The
// type-only export leaves nothing in the built script.
export type {};
declare const self: ServiceWorkerGlobalScope;
declare const SHELL: { readonly cache: string; readonly files: readonly string[] };

/** Every build's cache is named this, then a hash of the build's files. */
const PREFIX = 'wikistow-app-';
/** How long an app page or a file at the top of the site waits for the server. */
const WAIT_MS = 3000;
/** The files at the top of the site this build keeps, whose names carry no hash. */
const TOP = new Set(SHELL.files.filter((file) => !file.startsWith('/assets/')));

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL.cache);
      // The unhashed files past the HTTP cache, so they are this build's. A
      // hashed one never changes, so the copy the page or the last build
      // loaded serves, and a deploy downloads only what changed.
      await cache.addAll(
        SHELL.files.map((file) => new Request(file, TOP.has(file) ? { cache: 'no-cache' } : {})),
      );
      // A new build takes over at once, so online the app loads as it would without a worker.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(PREFIX) && name !== SHELL.cache) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/assets/')) {
    event.respondWith(cachedFirst(request));
  } else if (request.mode === 'navigate' && appPath(path)) {
    event.respondWith(serverFirst(request, '/index.html'));
  } else if (TOP.has(path)) {
    event.respondWith(serverFirst(request, path));
  }
  // Anything else goes to the server as if there were no worker: the API,
  // public pages, the plugin and diagram frames, and files not kept here.
});

/**
 * A path the server answers with the app's `index.html`, as
 * `serveWebApp` decides: no extension, and not the API or a public page.
 */
function appPath(path: string) {
  if (path.startsWith('/api/') || path === '/p' || path.startsWith('/p/')) return false;
  if (path === '/assets' || path.startsWith('/assets/')) return false;
  return !/\.[^/]*$/.test(path);
}

/** A hashed file: this build's copy, else the server's (a source map, or Workshop's esbuild). */
async function cachedFirst(request: Request) {
  return (await caches.match(request, { cacheName: SHELL.cache })) ?? fetch(request);
}

/**
 * The server's answer, unless it gives none within `WAIT_MS`, fails, or is
 * a 5xx that isn't the server's own JSON error (a proxy's, with the server
 * behind it down). Then this build's copy of `key`, which keeps the
 * server's headers. Without a copy, whatever the server gives.
 */
async function serverFirst(request: Request, key: string) {
  const answer = fetch(request).then((response) =>
    response.status >= 500 && !ownError(response) ? Promise.reject(response) : response,
  );
  // A late failure, once the copy is served, is no one's to handle.
  answer.catch(() => undefined);
  const kept = caches.match(key, { cacheName: SHELL.cache });
  const late = new Promise<'late'>((resolve) => setTimeout(() => resolve('late'), WAIT_MS));
  const first = await Promise.race([answer, late]).catch(() => 'failed' as const);
  if (first instanceof Response) return first;
  const copy = await kept;
  if (copy) return copy;
  // Nothing kept: the server's answer after all, or its 5xx, or the failure.
  return answer.catch((reason: unknown) => {
    if (reason instanceof Response) return reason;
    throw reason;
  });
}

/** The WikiStow server's own errors are JSON (`errorResponse`); a proxy's aren't. */
function ownError(response: Response) {
  return response.headers.get('Content-Type')?.startsWith('application/json') === true;
}
