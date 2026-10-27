// Rendering public copies (ADR 0005, decision 6) in one worker thread for
// the whole server, one page at a time, so a slow page can't stall it.
import { Worker } from 'node:worker_threads';
import { ContentError } from '../content/errors.ts';
import { writtenHtml } from './page.ts';
import type { RenderInput, Rendered } from './render.ts';
import type { RenderRequest, RenderResponse } from './render-worker.ts';

const UNREADABLE = "This page couldn't be shown formatted, so here it is as written.";
const TOO_SLOW = 'This page took too long to format, so here it is as written.';
const TOO_LARGE = 'This page came out too large to show formatted, so here it is as written.';

/** As the app gives up on a body, a render takes at most this. */
const RENDER_LIMIT_MS = 10_000;
/** Renders waiting at once, past which staging is refused as rate limited. */
const MAX_WAITING = 8;
/**
 * The worker's heap. A page of a few hundred KiB renders in far less, and a
 * body made to blow up (a wide table, filled out on every row) ends the
 * worker instead of the server.
 */
const WORKER_HEAP_MB = 512;

// The worker, beside this file: its source in development and tests, which
// Node runs as it is, and its bundle beside the server's in a build.
const WORKER_URL = new URL(
  import.meta.url.endsWith('.ts') ? './render-worker.ts' : './render-worker.mjs',
  import.meta.url,
);

type Job = {
  who: string;
  input: RenderInput;
  done: (rendered: Rendered) => void;
};

/**
 * Renders bodies in the worker. Each person has one render at a time, and
 * at most `maxWaiting` wait in all; past either, `render` is refused as
 * `busy`. A render that takes over `limitMs` ends the worker, which starts
 * again for the next, and like one that fails it gives the body as written,
 * with a note, and no files.
 */
export function createRenderer({ limitMs = RENDER_LIMIT_MS, maxWaiting = MAX_WAITING } = {}) {
  const waiting: Job[] = [];
  const busy = new Set<string>();
  let worker: Worker | null = null;
  let running = false;
  let nextId = 0;

  const written = (input: RenderInput, note: string): Rendered => ({
    segments: [writtenHtml(input.markdown, note)],
    files: [],
    outline: { headings: [], words: input.markdown.split(/\s+/).filter(Boolean).length },
  });

  function start(): Worker {
    const started = new Worker(WORKER_URL, {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    // Waiting for a render never keeps the process alive on its own.
    started.unref();
    // One that dies, as it does when it runs out of memory, is started
    // again for the next render. Its exit follows its error.
    started.on('error', () => {});
    started.once('exit', () => {
      if (worker === started) worker = null;
    });
    return started;
  }

  function next() {
    if (running) return;
    const job = waiting.shift();
    if (!job) return;
    running = true;
    const id = nextId++;
    const current = (worker ??= start());
    const finish = (rendered: Rendered) => {
      clearTimeout(timer);
      current.off('message', onMessage);
      current.off('exit', onExit);
      busy.delete(job.who);
      running = false;
      job.done(rendered);
      next();
    };
    const onMessage = (answer: RenderResponse) => {
      if (answer.id !== id) return;
      if (answer.ok) finish(answer.rendered);
      else finish(written(job.input, answer.tooLarge ? TOO_LARGE : UNREADABLE));
    };
    const onExit = () => finish(written(job.input, UNREADABLE));
    const timer = setTimeout(() => {
      current.off('exit', onExit);
      if (worker === current) worker = null;
      void current.terminate();
      finish(written(job.input, TOO_SLOW));
    }, limitMs);
    current.on('message', onMessage);
    current.once('exit', onExit);
    const request: RenderRequest = { id, input: job.input };
    current.postMessage(request);
  }

  return {
    /** Render `input` for `who`, a person or the server's own name for its work. */
    render(who: string, input: RenderInput): Promise<Rendered> {
      if (busy.has(who) || waiting.length >= maxWaiting) {
        throw new ContentError('busy', 'Too many pages are being prepared. Try again shortly.');
      }
      busy.add(who);
      return new Promise((done) => {
        waiting.push({ who, input, done });
        next();
      });
    },
    /** End the worker, for shutdown. */
    async close() {
      const current = worker;
      worker = null;
      await current?.terminate();
    },
  };
}

export type Renderer = ReturnType<typeof createRenderer>;
