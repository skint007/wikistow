import type { MarkdownJob, MarkdownJobs, MarkdownRequest, MarkdownResponse } from './markdown-jobs';

/**
 * How long reading one page's Markdown may take, in the reader, export,
 * the publish preview or saving, before the page is taken as written. A long,
 * ordinary page within the size limit takes about a second on a laptop;
 * some text takes the parser far longer than its size suggests (#47).
 */
export const READ_BUDGET_MS = 10_000;

/** A Markdown job ran past its time; its worker was ended. */
export class MarkdownTimeout extends Error {
  constructor() {
    super('Reading the Markdown took too long');
    this.name = 'MarkdownTimeout';
  }
}

/** A Markdown job failed in the worker, or the worker itself did. */
class MarkdownFailed extends Error {
  constructor() {
    super('The Markdown couldn’t be read');
    this.name = 'MarkdownFailed';
  }
}

type Started = { worker: Worker; ready: Promise<void> };

function start(): Started {
  const worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
  const ready = new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve();
    worker.onerror = () => reject(new MarkdownFailed());
  });
  // A worker that fails to start is the job's failure, not an unhandled one.
  ready.catch(() => {});
  return { worker, ready };
}

/**
 * Markdown read in a module worker, off the page's thread, one job at a
 * time, in order. A job gets `budgetMs` from when it starts, a new worker's
 * loading included. Past that, or once `signal` aborts, its worker is
 * ended, since nothing else stops a parse, and the job fails
 * (`MarkdownTimeout`, or the signal's reason); the next job starts a worker
 * afresh. Otherwise the worker stays for the next job.
 */
export class MarkdownWorker {
  #started: Started | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  /** Fails the job running now, and ends its worker. */
  #ending: ((error: unknown) => void) | null = null;

  run<J extends MarkdownJob>(
    job: J,
    input: Parameters<MarkdownJobs[J]>[0],
    options: { budgetMs: number; signal?: AbortSignal },
  ): Promise<ReturnType<MarkdownJobs[J]>> {
    const result = this.#queue.then(() => this.#run(job, input, options));
    // Without its output, which may be a page's text, kept past its job.
    const done = () => {};
    this.#queue = result.then(done, done);
    return result;
  }

  /** End the worker now, failing a job it is running; the next job starts another. */
  close() {
    if (this.#ending) return this.#ending(new MarkdownFailed());
    this.#started?.worker.terminate();
    this.#started = null;
  }

  #run<J extends MarkdownJob>(
    job: J,
    input: Parameters<MarkdownJobs[J]>[0],
    { budgetMs, signal }: { budgetMs: number; signal?: AbortSignal },
  ): Promise<ReturnType<MarkdownJobs[J]>> {
    signal?.throwIfAborted();
    const started = (this.#started ??= start());
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (this.#ending === end) this.#ending = null;
        // A worker kept for the next job keeps nothing of this one's.
        started.worker.onmessage = null;
        started.worker.onmessageerror = null;
        started.worker.onerror = null;
      };
      const end = (error: unknown) => {
        settle();
        started.worker.terminate();
        if (this.#started === started) this.#started = null;
        reject(error);
      };
      this.#ending = end;
      const timer = setTimeout(() => end(new MarkdownTimeout()), budgetMs);
      const abort = () => end(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      started.ready.then(() => {
        started.worker.onmessage = ({ data }: MessageEvent<MarkdownResponse>) => {
          if ('ready' in data) return;
          settle();
          // The worker answers each job with that job's output; the
          // message channel itself carries no types.
          if (data.ok) resolve(data.output as ReturnType<MarkdownJobs[J]>);
          else reject(new MarkdownFailed());
        };
        // Its answer too deep for this side to copy, or the worker failing.
        started.worker.onmessageerror = () => end(new MarkdownFailed());
        started.worker.onerror = () => end(new MarkdownFailed());
        started.worker.postMessage({ job, input } as MarkdownRequest);
      }, end);
    });
  }
}
