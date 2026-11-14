import { CSP } from '@wikistow/contracts';
import type { Page } from '@playwright/test';
import { expect, pick, test } from './fixtures';
import { adminTab, fillSource, memberWithVault, newPage, waitForSave } from './vault';
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

/** About 150 words of a travel diary's day, different each day. */
const diaryDay = (day: number) =>
  `## Day ${day}\n\n` +
  Array.from(
    { length: 10 },
    (_, line) =>
      `On day ${day} we walked ${line + 2} miles along the cliffs, ate fish by the harbour, and watched the tide come in over the rocks at evening.`,
  ).join(' ');

/** Keyboard events from now on that took past a frame to paint, as Event Timing reports them. */
async function watchKeys(page: Page) {
  await page.evaluate(() => {
    const seen: { name: string; duration: number }[] = [];
    (window as unknown as { keysSeen: typeof seen }).keysSeen = seen;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (/^key|input/.test(entry.name))
          seen.push({ name: entry.name, duration: entry.duration });
      }
    }).observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
  });
}
const slowestKey = (page: Page) =>
  page.evaluate(() =>
    Math.max(
      0,
      ...(window as unknown as { keysSeen: { duration: number }[] }).keysSeen.map(
        ({ duration }) => duration,
      ),
    ),
  );

/** The vectors this browser keeps, sealed, beside the search index: their size, or 0. */
const keptVectors = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const opening = indexedDB.open('wikistow-kept');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const db = opening.result;
          const read = db.transaction('meta').objectStore('meta').get('meaning-index');
          read.onsuccess = () => {
            db.close();
            resolve(read.result instanceof Uint8Array ? read.result.length : 0);
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );

/**
 * Search by meaning, turned on in a computer's browser with Every page
 * kept (ADR 0016, step 4), indexes the pages in the background, with the
 * real model in its worker. Typing in a page and searching stay
 * responsive while it does: no keypress takes past 200 ms to paint, the
 * bound of a good Interaction to Next Paint. Once done, the vectors are
 * kept, sealed, and a reload opens them rather than embed anything again.
 */
test('indexes by meaning in the background, typing and searching staying responsive', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(300_000);
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Cornwall diary');
  // About 60 passages: some 20 s for the model.
  await fillSource(page, Array.from({ length: 60 }, (_, day) => diaryDay(day + 1)).join('\n\n'));
  await waitForSave(page);
  await newPage(page, 'Notes');
  await fillSource(page, 'Things to remember.');
  await waitForSave(page);

  const workers: string[] = [];
  let saved = 0;
  page.on('worker', (worker) => workers.push(worker.url()));
  // The setting's state, which its name is described by.
  const row = page.getByRole('heading', { level: 3, name: /^Search by meaning/ });
  await test.step('turned on in Settings, once Every page is kept', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    const toggle = page.getByRole('switch', { name: 'Search by meaning' });
    await expect(row).toHaveAccessibleDescription(/^Needs Keep for offline on Every page/);
    await expect(toggle).toHaveCount(0);
    await pick(page.getByLabel(/^Keep for offline: /), 'Every page');
    await expect(row).toHaveAccessibleDescription(/Downloads 26 MB once/);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(row).toHaveAccessibleDescription(/By meaning: \d of 2 pages so far/, {
      timeout: 30_000,
    });
  });

  await test.step('typing in a page stays responsive while it indexes', async () => {
    // Back to the page Settings was opened from, in the app: nothing reloads.
    await page.goBack();
    await expect(page.locator('#page-title')).toHaveValue('Notes');
    await watchKeys(page);
    const source = page.locator('#page-source');
    await source.click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' Pack a coat for the cliffs, and sun cream.', { delay: 30 });
    await waitForSave(page);
    saved = Date.now();
    const slowest = await slowestKey(page);
    test
      .info()
      .annotations.push({ type: 'timing', description: `slowest keypress typing: ${slowest} ms` });
    expect(slowest).toBeLessThan(200);
  });

  await test.step('searching stays responsive while it indexes', async () => {
    await watchKeys(page);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const search = page.getByRole('dialog', { name: 'Search' });
    const box = search.getByRole('combobox', { name: 'Search pages' });
    await box.pressSequentially('harbour', { delay: 30 });
    await expect(search.getByRole('option').locator('.font-extrabold')).toHaveText([
      'Cornwall diary',
    ]);
    const slowest = await slowestKey(page);
    test.info().annotations.push({
      type: 'timing',
      description: `slowest keypress searching: ${slowest} ms`,
    });
    expect(slowest).toBeLessThan(200);
    await page.keyboard.press('Escape');
  });

  await test.step('it was indexing all the while, and keeps the vectors once done', async () => {
    await page.getByRole('link', { name: 'Settings' }).click();
    // Still going after the typing and the search: they didn't wait on it.
    await expect(row).toHaveAccessibleDescription(/By meaning: \d of 2 pages so far/);
    expect(workers.filter((url) => /\/embed\.worker-[\w-]+\.js$/.test(url))).toHaveLength(1);
    await expect(row).not.toHaveAccessibleDescription(/so far/, { timeout: 120_000 });
    // The note typed in is embedded once its saves have paused for 30 s,
    // and the vectors kept 5 s after: the reload below would embed it
    // otherwise, which it checks doesn't happen.
    await page.waitForTimeout(Math.max(0, saved + 40_000 - Date.now()));
    await expect.poll(() => keptVectors(page), { timeout: 30_000 }).toBeGreaterThan(60 * 400);
  });

  await test.step('a reload opens the kept vectors, embedding nothing again', async () => {
    workers.length = 0;
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Search by meaning' })).toBeChecked();
    await expect(
      page.getByText(/Nothing you search for or write leaves this device/),
    ).toBeVisible();
    // Every page has its vectors as soon as the kept ones open.
    await expect(row).toHaveAccessibleDescription(/^All 2 pages indexed\./, { timeout: 30_000 });
    // And stays so, with nothing for the worker to do.
    await page.waitForTimeout(3_000);
    await expect(row).toHaveAccessibleDescription(/^All 2 pages indexed\./);
    expect(workers.filter((url) => url.includes('embed.worker'))).toEqual([]);
  });

  await test.step('turning it off deletes the vectors and the model’s files', async () => {
    await page.getByRole('switch', { name: 'Search by meaning' }).click();
    await expect.poll(() => keptVectors(page)).toBe(0);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.keys()).filter((name) => name.startsWith('wikistow-meaning-')),
        ),
      )
      .toEqual([]);
  });
});
