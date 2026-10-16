import type { Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { expect, pick, serverSnapshot, test } from './fixtures';
import { adminTab, fillSource, memberWithVault, newPage, waitForSave } from './vault';

const BUILD = fileURLToPath(new URL('../../../packages/plugin-sdk/src/build.ts', import.meta.url));
const PAGE_TOOLS = fileURLToPath(new URL('../../../examples/plugins/page-tools', import.meta.url));

// The sandboxed frame that holds plugin scripts' workers (ADR 0002), driven
// from the app's page as `packages/ui/src/plugins/script-frame.ts` drives
// it: so under the app's own policy and the server's headers for the frame.

/** Add the host frame to `page`, and wait until it says it is ready. */
async function openSandbox(page: Page) {
  return page.evaluateHandle(async () => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.hidden = true;
    iframe.src = '/plugin-host.html';
    const ended: number[] = [];
    const ready = new Promise<void>((resolve) => {
      window.addEventListener('message', (event: MessageEvent<{ type: string; id: number }>) => {
        if (event.source !== iframe.contentWindow) return;
        if (event.data.type === 'ready') resolve();
        if (event.data.type === 'ended') ended.push(event.data.id);
      });
    });
    document.body.append(iframe);
    await ready;
    return {
      iframe,
      ended,
      ports: new Map<number, MessagePort>(),
      received: new Map<number, unknown[]>(),
    };
  });
}
type Sandbox = Awaited<ReturnType<typeof openSandbox>>;

/** Start `source` as script `id` in the frame, its messages kept as they arrive. */
const start = (sandbox: Sandbox, id: number, source: string) =>
  sandbox.evaluate(
    (frame, { id, source }) => {
      const channel = new MessageChannel();
      const received: unknown[] = [];
      frame.ports.set(id, channel.port1);
      frame.received.set(id, received);
      channel.port1.onmessage = (event) => received.push(event.data);
      frame.iframe.contentWindow?.postMessage(
        { type: 'start', id, name: 'sandbox-test', source },
        '*',
        [channel.port2],
      );
    },
    { id, source },
  );

/** Send script `id` a message; its next relayed message, or 'no answer' within `ms`. */
const ask = (sandbox: Sandbox, id: number, message: unknown, ms = 5_000) =>
  sandbox.evaluate(
    async (frame, { id, message, ms }) => {
      const received = frame.received.get(id) ?? [];
      const from = received.length;
      frame.ports.get(id)?.postMessage(message);
      for (const until = Date.now() + ms; Date.now() < until;) {
        if (received.length > from) return received[from];
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return 'no answer';
    },
    { id, message, ms },
  );

/** Ask the frame to end script `id`, and wait until it confirms. */
async function end(sandbox: Sandbox, id: number) {
  await sandbox.evaluate((frame, id) => {
    frame.iframe.contentWindow?.postMessage({ type: 'end', id }, '*');
  }, id);
  await expect.poll(() => sandbox.evaluate((frame, id) => frame.ended.includes(id), id)).toBe(true);
}

// A plugin's script trying everything it mustn't. Each attempt answers
// "allowed: …" or "refused: <error name>".
const PROBE = `
const attempt = async (run) => {
  try {
    return 'allowed: ' + (await run());
  } catch (error) {
    return 'refused: ' + (error && error.name);
  }
};
const nested = (target) =>
  new Promise((resolve, reject) => {
    const code = "try { importScripts('" + target + "'); postMessage('loaded') } catch (e) { postMessage('failed') }";
    const worker = new Worker('data:text/javascript,' + encodeURIComponent(code));
    worker.onmessage = (event) => (event.data === 'loaded' ? resolve('loaded') : reject(new Error()));
    worker.onerror = () => reject(new Error());
  });
const socket = (target) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(target.replace(/^http/, 'ws'));
    ws.onopen = () => resolve('open');
    ws.onerror = () => reject(new Error());
  });
// Every way out, to target, at paths the app itself never asks for.
const requests = async (target) => ({
  fetch: await attempt(async () => (await fetch(target + '/sandbox-probe', { mode: 'no-cors' })).type),
  import: await attempt(() => import(target + '/sandbox-probe.js')),
  importScripts: await attempt(() => nested(target + '/sandbox-probe.js')),
  webSocket: await attempt(() => socket(target + '/sandbox-probe')),
});
addEventListener('message', async ({ data: { app, outside } }) => {
  postMessage({
    origin: self.origin,
    name: self.name,
    indexedDB: await attempt(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('wikistow-vault');
          open.onsuccess = () => resolve([...open.result.objectStoreNames].join());
          open.onerror = () => reject(open.error);
        }),
    ),
    caches: await attempt(async () => (await caches.keys()).join()),
    session: await attempt(async () => (await fetch(app + '/api/auth/get-session', { credentials: 'include', mode: 'no-cors' })).type),
    app: await requests(app),
    outside: await requests(outside),
  });
});
`;

// Messages to the loop: { loop } spins forever, anything else is echoed.
const LOOP = `
addEventListener('message', ({ data }) => {
  if (data.loop) for (;;) {}
  postMessage({ echo: data });
});
`;

const refusedAll = {
  fetch: 'refused: TypeError',
  import: expect.stringMatching(/^refused: /),
  importScripts: expect.stringMatching(/^refused: /),
  webSocket: expect.stringMatching(/^refused: /),
};

test('a script in the sandbox reaches no storage, cookies, page or network', async ({
  page,
  freshPage,
  admin,
  baseURL,
}) => {
  // A server of its own that a script would reach if any request got out.
  const arrived: string[] = [];
  const outside = createServer((request, response) => {
    arrived.push(request.url ?? '');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/javascript');
    response.end('');
  });
  outside.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    arrived.push(request.url ?? '');
    socket.destroy();
  });
  await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
  const address = outside.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const { port } = address;
  try {
    // Signed in and unlocked: a session cookie, and the tab's kept unlock in IndexedDB.
    await memberWithVault(page, await adminTab(freshPage, admin.email));
    await page.evaluate(async () => {
      localStorage.setItem('sandbox-secret', 'local');
      sessionStorage.setItem('sandbox-secret', 'session');
      await caches.open('sandbox-secret');
    });
    expect((await page.context().cookies()).length).toBeGreaterThan(0);
    const shownAt = page.url();
    const sandbox = await openSandbox(page);

    // The frame's own document.
    const frame = page.frames().find((each) => each.url().endsWith('/plugin-host.html'));
    if (!frame) throw new Error('No host frame');
    const fromFrame = await frame.evaluate(() => {
      const attempt = (run: () => unknown) => {
        try {
          return `allowed: ${String(run())}`;
        } catch (error) {
          return `refused: ${error instanceof Error ? error.name : String(error)}`;
        }
      };
      return {
        origin: self.origin,
        localStorage: attempt(() => localStorage.getItem('sandbox-secret')),
        sessionStorage: attempt(() => sessionStorage.getItem('sandbox-secret')),
        cookie: attempt(() => document.cookie),
        indexedDB: attempt(() => indexedDB.open('wikistow-vault')),
        parentDocument: attempt(() => parent.document.title),
        topNavigation: attempt(() => (top ? (top.location.href = '/sign-in') : null)),
      };
    });
    expect(fromFrame).toEqual({
      origin: 'null',
      localStorage: 'refused: SecurityError',
      sessionStorage: 'refused: SecurityError',
      cookie: 'refused: SecurityError',
      indexedDB: 'refused: SecurityError',
      parentDocument: 'refused: SecurityError',
      topNavigation: expect.stringMatching(/^refused: /),
    });

    // Its script's worker. Nothing it tries reaches the app's server or
    // another one. A refusal alone doesn't show that: a response the browser
    // blocks still means the request arrived. So the server's log, which
    // names the route each request matched, gains none at the probes' routes.
    const probed = async () =>
      (await serverSnapshot()).logs.filter(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'route' in entry &&
          (entry.route === '/*' || entry.route === '/api/auth/*'),
      ).length;
    const before = await probed();
    await start(sandbox, 1, PROBE);
    const fromWorker = await ask(sandbox, 1, {
      app: baseURL,
      outside: `http://127.0.0.1:${port}`,
    });
    expect(fromWorker).toEqual({
      message: {
        origin: 'null',
        // What the SDK reads as `host.pluginId`.
        name: 'sandbox-test',
        indexedDB: expect.stringMatching(/^refused: /),
        // WebKit gives it an empty Cache Storage of its own; the others refuse.
        caches: expect.not.stringContaining('sandbox-secret'),
        session: 'refused: TypeError',
        app: refusedAll,
        outside: refusedAll,
      },
    });
    expect(arrived).toEqual([]);
    expect(await probed()).toBe(before);
    expect(page.url()).toBe(shownAt);
  } finally {
    outside.close();
  }
});

test('a script in a loop is stopped while the page keeps answering', async ({ page }) => {
  await page.goto('/sign-in');
  const sandbox = await openSandbox(page);
  await start(sandbox, 1, LOOP);
  expect(await ask(sandbox, 1, 'first')).toEqual({ message: { echo: 'first' } });

  // The longest the page's own 10 ms timer waits while the script spins.
  expect(await ask(sandbox, 1, { loop: true }, 500)).toBe('no answer');
  const longestGap = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = performance.now();
        let longest = 0;
        const timer = setInterval(() => {
          const now = performance.now();
          longest = Math.max(longest, now - last);
          last = now;
        }, 10);
        setTimeout(() => {
          clearInterval(timer);
          resolve(longest);
        }, 2_000);
      }),
  );
  expect(longestGap).toBeLessThan(500);

  // The frame still answers: it ends the looping worker, and runs another.
  const scripts = () => page.workers().filter((worker) => worker.url().startsWith('data:'));
  expect(scripts()).toHaveLength(1);
  await end(sandbox, 1);
  // Chromium takes about two seconds to stop a busy worker.
  await expect.poll(() => scripts().length, { timeout: 10_000 }).toBe(0);
  await start(sandbox, 2, LOOP);
  expect(await ask(sandbox, 2, 'second')).toEqual({ message: { echo: 'second' } });
});

// A library plugin in the browser, from upload to removal (ADR 0002): its
// styles, app code and script all come from the server's library route,
// the script running in a worker in the sandboxed frame, and a version
// removed from the library stops loading.
test('a library plugin runs in the browser until it leaves the library', async ({
  page,
  freshPage,
  admin,
}) => {
  test.setTimeout(180_000);
  execFileSync(process.execPath, [BUILD, 'build', PAGE_TOOLS], { stdio: 'inherit' });
  await memberWithVault(page, await adminTab(freshPage, admin.email));
  await newPage(page, 'Tools');
  await fillSource(page, 'Three short words.');
  await waitForSave(page);
  const shownAt = page.url();

  // Uploaded from its built folder, then approved.
  await page.goto('/settings');
  await page.getByLabel('Plugin folder').setInputFiles(`${PAGE_TOOLS}/dist`);
  await expect(page.getByText('Uploaded Page tools 0.1.0.')).toBeVisible({ timeout: 15_000 });
  const listed = page
    .getByRole('list', { name: 'Plugin library' })
    .getByRole('listitem', { name: 'Page tools' });
  await listed.getByRole('button', { name: 'Install…' }).click();
  const approval = page.getByRole('dialog');
  await expect(approval).toContainText('App');
  await expect(approval).toContainText(/[0-9a-f]{64}/);
  await approval.getByRole('button', { name: 'Install' }).click();
  const installed = page
    .getByRole('list', { name: 'Installed plugins' })
    .getByRole('listitem', { name: 'Page tools' });
  await expect(installed.getByRole('switch', { name: 'Page tools enabled' })).toBeChecked();
  await installed.getByRole('button', { name: /^Where/ }).click();
  await page
    .getByRole('menuitemradio', { name: /whole space/ })
    .first()
    .click();
  await pick(installed.getByRole('button', { name: /^Access/ }), 'Read and write');
  await installed.getByRole('button', { name: 'Add' }).click();
  await expect(installed.getByRole('list', { name: 'Page access' })).toContainText(
    'read and write',
  );

  // On the page, after a reload: its styles, its panel, and its script's
  // command, which writes a page through the access given.
  await page.goto(shownAt);
  const fromLibrary = /^\/plugins\/page-tools\/[0-9a-f]{64}\/page-tools\.css$/;
  await expect(page.locator('link[data-plugin="page-tools"]')).toHaveAttribute('href', fromLibrary);
  await page.getByRole('button', { name: 'Plugins' }).click();
  await page.getByRole('menuitem', { name: 'Page stats' }).click();
  await expect(page.getByTestId('page-tools-words')).toHaveText('3');
  await page.keyboard.press('Escape');
  await expect(page.locator('iframe[src="/plugin-host.html"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Plugins' }).click();
  await page.getByRole('menuitem', { name: 'Write this folder’s index' }).click();
  await expect(page.getByRole('treeitem', { name: /^Index/ })).toBeVisible();

  // Safe mode in this tab: nothing loads until it is turned off.
  await page.goto('/settings?safe-mode');
  const banner = page.locator('[data-region="safe-mode"]');
  await expect(banner).toContainText('plugins are off');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('link[data-plugin]')).toHaveCount(0);
  await banner.getByRole('button', { name: 'Turn plugins back on' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('link[data-plugin="page-tools"]')).toHaveCount(1);

  // Removed from the library: it stops, and Settings says why.
  await listed.getByRole('button', { name: 'Remove from library' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('list', { name: 'Plugin library' })).toHaveCount(0);
  const gone = page
    .getByRole('list', { name: 'Installed plugins' })
    .getByRole('listitem', { name: 'page-tools' });
  await expect(gone).toContainText('no longer in the library');
  await expect(page.locator('link[data-plugin]')).toHaveCount(0);
  await expect(page.locator('iframe[src="/plugin-host.html"]')).toHaveCount(0);
  await gone.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('list', { name: 'Installed plugins' })).toHaveCount(0);
});
