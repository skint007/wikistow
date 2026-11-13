import { CSP } from '@wikistow/contracts';
import { expect, test } from './fixtures';
import { embedIn, embedWorker, PASSAGES, QUERY, type Run } from './meaning';

/** Each run's times, beside the test's result (`--reporter=json`), for ADR 0016's measurements. */
function note(name: string, run: Run) {
  const { from, loadMs, firstMs, queryMs, passageMs, passageTokens } = run;
  test.info().annotations.push({
    type: 'timing',
    description: JSON.stringify({ name, from, loadMs, firstMs, queryMs, passageMs, passageTokens }),
  });
}

function expectMeaning(run: Run) {
  expect(run.query).toHaveLength(384);
  expect(Math.hypot(...run.query)).toBeCloseTo(1, 4);
  // The holiday is closer to "trip to the coast" than the boiler is.
  const [holiday = 0, boiler = 0] = run.scores;
  expect(holiday).toBeGreaterThan(boiler + 0.1);
}

/**
 * The embedding worker runs under the app's own policy, as the server
 * sends it, from the model's files the build carries (ADR 0016, step 2).
 * The server sends the model as its Brotli copy. The worker keeps the
 * files in its own cache, so a second worker reads them from there, and so
 * does one offline, once the service worker has the app.
 */
test('embeds a text under the app’s policy, from its own files, offline too', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const worker = await embedWorker();
  // Any of the app's pages: the first administrator's setup, or signing in.
  await page.goto('/');
  await expect(page.getByRole('heading').first()).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    while (!navigator.serviceWorker.controller) await new Promise((wait) => setTimeout(wait, 50));
  });

  const model: string[] = [];
  const policies: string[] = [];
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/assets/meaning/')) model.push(response.headers()['content-encoding'] ?? '');
    if (url.endsWith(worker)) policies.push(response.headers()['content-security-policy'] ?? '');
  });
  const first = await embedIn(page, worker, { keep: true, query: QUERY, passages: PASSAGES });
  note('chromium, from the server', first);
  expect(first.from).toBe('network');
  expectMeaning(first);
  expect(first.passageTokens).toBeGreaterThan(200);
  expect(first.passageTokens).toBeLessThanOrEqual(256);
  // The model and its tokenizer came as their Brotli copies, and the
  // worker with the app's policy, which it runs under.
  expect(model).toEqual(['br', 'br']);
  expect(policies).toEqual([CSP]);

  const again = await embedIn(page, worker, { keep: true, query: QUERY, passages: PASSAGES });
  note('chromium, from its cache', again);
  expect(again.from).toBe('cache');
  expect(again.query).toEqual(first.query);

  // The service worker keeps none of the model's files, nor any Brotli copy.
  const kept = await page.evaluate(async () => {
    const names = await caches.keys();
    const app = names.find((name) => name.startsWith('wikistow-app-'));
    const files = app ? (await (await caches.open(app)).keys()).map(({ url }) => url) : [];
    return { names, files };
  });
  expect(kept.names.filter((name) => name.startsWith('wikistow-meaning-'))).toEqual([
    expect.stringMatching(/^wikistow-meaning-[0-9a-f]{16}$/),
  ]);
  expect(kept.files.some((url) => url.endsWith(worker))).toBe(true);
  expect(kept.files.filter((url) => /\/assets\/meaning\/|\.wasm$|\.br$/.test(url))).toEqual([]);

  await context.setOffline(true);
  // The app loads from the service worker's copy, whatever it then shows.
  await page.reload();
  await expect(page.locator('#root > *').first()).toBeAttached();
  const offline = await embedIn(page, worker, { keep: true, query: QUERY, passages: PASSAGES });
  expect(offline.from).toBe('cache');
  expect(offline.query).toEqual(first.query);
});
