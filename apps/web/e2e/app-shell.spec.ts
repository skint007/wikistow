import { expect, test } from './fixtures';

/**
 * After one visit online, the browser app loads with no connection, from
 * the service worker's copy of this build (ADR 0009, decision 6): its
 * pages, lazy chunks and workers. The worker keeps the build's files and
 * nothing the server answers per person.
 */
// With its administrator made, the server keeps `/sign-in` there.
test('the app loads offline after one online visit', async ({ page, context, admin: _admin }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // The worker takes the page over once it has kept the build.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  // Another app path, and a route whose code loads only when it opens.
  await page.goto('/forgot-password');
  await expect(page.getByRole('button', { name: /reset link/i })).toBeVisible();

  const offline = await page.evaluate(async () => {
    const [name, ...others] = await caches.keys();
    const kept = name ? (await (await caches.open(name)).keys()).map((r) => r.url) : [];
    const loads = await Promise.all(
      kept.map((url) =>
        fetch(url).then(
          (response) => response.ok,
          () => false,
        ),
      ),
    );
    const api = await fetch('/api/me').then(
      () => 'answered',
      () => 'failed',
    );
    return { name, others, kept: kept.map((url) => new URL(url).pathname), loads, api };
  });
  expect(offline.name).toMatch(/^wikistow-app-[0-9a-f]{16}$/);
  expect(offline.others).toEqual([]);
  expect(offline.kept).toEqual(
    expect.arrayContaining([
      '/index.html',
      '/boot.js',
      '/manifest.webmanifest',
      expect.stringMatching(/^\/assets\/vault\.worker-.*\.js$/),
      expect.stringMatching(/^\/assets\/markdown\.worker-.*\.js$/),
    ]),
  );
  // Not the API, source maps, Workshop's esbuild or the frames' own files.
  expect(
    offline.kept.filter((path) => /^\/api\/|\.map$|\.wasm$|^\/(plugin|diagram)-host\./.test(path)),
  ).toEqual([]);
  expect(offline.loads.every(Boolean)).toBe(true);
  expect(offline.api).toBe('failed');
});
