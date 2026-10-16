import type { Page } from '@playwright/test';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { expect, serverSnapshot } from './fixtures';

// The sandboxed frame that holds plugin scripts' workers (ADR 0002), driven
// from the app's page as `packages/ui/src/plugins/script-frame.ts` drives
// it: so under the app's own policy and the headers the server, or the
// desktop app's main, sends for the frame.

/** Add the host frame to `page`, and wait until it says it is ready. */
export async function openSandbox(page: Page) {
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
export const start = (sandbox: Sandbox, id: number, source: string) =>
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
export const ask = (sandbox: Sandbox, id: number, message: unknown, ms = 5_000) =>
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
export const PROBE = `
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

export const refusedAll = {
  fetch: 'refused: TypeError',
  import: expect.stringMatching(/^refused: /),
  importScripts: expect.stringMatching(/^refused: /),
  webSocket: expect.stringMatching(/^refused: /),
};

/** A server of its own, which a script would reach if any request got out; `arrived` lists what did. */
export async function outsideServer() {
  const arrived: string[] = [];
  const server = createServer((request, response) => {
    arrived.push(request.url ?? '');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Content-Type', 'text/javascript');
    response.end('');
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    arrived.push(request.url ?? '');
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  return { url: `http://127.0.0.1:${address.port}`, arrived, close: () => server.close() };
}

/** The host frame's own document in `page`, trying the app's storage, cookies, document and tab. */
export async function fromFrame(page: Page) {
  const frame = page.frames().find((each) => each.url().endsWith('/plugin-host.html'));
  if (!frame) throw new Error('No host frame');
  return frame.evaluate(() => {
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
}

export const frameRefusedAll = {
  origin: 'null',
  localStorage: 'refused: SecurityError',
  sessionStorage: 'refused: SecurityError',
  cookie: 'refused: SecurityError',
  indexedDB: 'refused: SecurityError',
  parentDocument: 'refused: SecurityError',
  topNavigation: expect.stringMatching(/^refused: /),
};

/**
 * Requests the server logged at the routes the probe's paths match. A
 * refusal alone doesn't show a request never got out: a response the
 * browser blocks still means the request arrived. So this mustn't grow.
 */
export const probedRequests = async () =>
  (await serverSnapshot()).logs.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'route' in entry &&
      (entry.route === '/*' || entry.route === '/api/auth/*'),
  ).length;

/**
 * A script in a loop in `page`'s host frame: the page keeps answering, the
 * frame ends the looping worker when asked, and runs another.
 */
export async function expectLoopStopped(page: Page) {
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

  const scripts = () => page.workers().filter((worker) => worker.url().startsWith('data:'));
  expect(scripts()).toHaveLength(1);
  await end(sandbox, 1);
  // Chromium takes about two seconds to stop a busy worker.
  await expect.poll(() => scripts().length, { timeout: 10_000 }).toBe(0);
  await start(sandbox, 2, LOOP);
  expect(await ask(sandbox, 2, 'second')).toEqual({ message: { echo: 'second' } });
}
