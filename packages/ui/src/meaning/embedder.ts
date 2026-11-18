import { MEANING_CACHE_PREFIX } from './model';

/** A search's words, which take the model's query prefix, or a page's passage. */
export type EmbedKind = 'query' | 'passage';

/** What the page asks the worker (`embed.worker.ts`), and with `id`, how. */
export type EmbedAsk =
  | { op: 'load'; keep: boolean }
  | { op: 'embed'; kind: EmbedKind; texts: string[] }
  | { op: 'count'; words: string[] };
export type EmbedRequest = EmbedAsk & { id: number };

/**
 * Where the model came from: the server, the worker's cache, the app's
 * own files (the desktop app), or the worker's memory, already loaded.
 */
export type Loaded = { from: 'network' | 'cache' | 'files' | 'memory' };

/** Each text's vector, unit length, and how many tokens of it the model read. */
export type Embedded = { vectors: Float32Array[]; tokens: number[] };

/** What the worker answers. */
export type EmbedAnswer =
  | ({ id: number; op: 'load' } & Loaded)
  | ({ id: number; op: 'embed' } & Embedded)
  | { id: number; op: 'count'; counts: number[] }
  | { id: number; op: 'error'; message: string };

/**
 * Nothing asked of the worker is at fault: the model couldn't be loaded,
 * or, as `WorkerStopped`, which request stopped the worker isn't known. The
 * loaded worker failing on what it was given is a plain `Error`.
 */
export class ModelUnavailable extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'The model couldn’t be loaded.', { cause });
    this.name = 'ModelUnavailable';
  }
}

/**
 * The worker stopped with more than one request in it, as when a query
 * comes while a passage is embedded: which stopped it isn't known, so, as
 * for a model that can't load, none of them is held at fault.
 */
export class WorkerStopped extends ModelUnavailable {
  constructor() {
    super(new Error('The embedding worker stopped.'));
    this.name = 'WorkerStopped';
  }
}

/**
 * How long a model that failed to load isn't tried again. The queue waits
 * this long after the worker fails, and a query or search opening waits
 * too, so a worker isn't started, and the model fetched again, at each
 * pause in typing.
 */
export const RETRY_MS = 60_000;

type Waiting = { resolve: (answer: EmbedAnswer) => void; reject: (error: Error) => void };

/** How long the worker stays once nothing is asked of it, holding the model's memory. */
const IDLE_MS = 60_000;

/**
 * The embedding worker (`embed.worker.ts`), started when first asked and
 * stopped once nothing has been asked of it for `idleMs`, which gives its
 * memory back; the next request starts it again (ADR 0016, decision 2).
 * With `keep`, the worker keeps the model's files in its cache; the
 * desktop app, which has them on disk, doesn't.
 */
export class Embedder {
  readonly #keep: boolean;
  readonly #idleMs: number;
  #worker: Worker | null = null;
  #loaded: Promise<Loaded> | null = null;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #next = 0;
  readonly #waiting = new Map<number, Waiting>();
  /** When the model last failed to load, and why, until `RETRY_MS` after. */
  #failed: { at: number; message: string } | null = null;
  /** How many times `stop` was called: a load it ended didn't fail. */
  #stops = 0;

  constructor({ keep, idleMs = IDLE_MS }: { keep: boolean; idleMs?: number }) {
    this.#keep = keep;
    this.#idleMs = idleMs;
  }

  #started() {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('./embed.worker.ts', import.meta.url), {
      type: 'module',
      name: 'wikistow-meaning',
    });
    worker.onmessage = ({ data }: MessageEvent<EmbedAnswer>) => {
      this.#waiting.get(data.id)?.resolve(data);
      this.#waiting.delete(data.id);
      this.#rest();
    };
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.#worker !== worker) return;
      if (this.#waiting.size > 1) this.#fail(() => new WorkerStopped());
      else this.#fail(() => new Error('The embedding worker stopped.'));
    };
    this.#worker = worker;
    return worker;
  }

  #ask(request: EmbedAsk): Promise<EmbedAnswer> {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    const worker = this.#started();
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      worker.postMessage({ ...request, id } satisfies EmbedRequest);
    });
  }

  /** Once nothing waits, stop the worker after `idleMs`. */
  #rest() {
    if (this.#waiting.size > 0 || !this.#worker) return;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.stop(), this.#idleMs);
  }

  /** Stop the worker, failing what waits on it with `error`'s. */
  #fail(error: () => Error) {
    this.#worker?.terminate();
    this.#worker = null;
    this.#loaded = null;
    for (const { reject } of this.#waiting.values()) reject(error());
    this.#waiting.clear();
  }

  /**
   * Load the model, if this worker hasn't yet. Once it fails to load, it
   * isn't tried again for `RETRY_MS`: until then, this fails at once.
   */
  load(): Promise<Loaded> {
    if (this.#loaded) return this.#loaded;
    if (this.#failed) {
      // A clock set back ends the wait, rather than make it longer.
      const since = Date.now() - this.#failed.at;
      if (since >= 0 && since < RETRY_MS) return Promise.reject(new Error(this.#failed.message));
      this.#failed = null;
    }
    const stops = this.#stops;
    const loading = this.#ask({ op: 'load', keep: this.#keep }).then((answer) => {
      // The runtime keeps a failed start for the worker's life, so the next
      // load starts a new one.
      if (answer.op === 'error') {
        this.#fail(() => new Error(answer.message));
        throw new Error(answer.message);
      }
      if (answer.op !== 'load') throw new Error('The embedding worker answered out of turn.');
      return { from: answer.from };
    });
    this.#loaded = loading;
    // A load that fails lets the next try again, in a new worker, once
    // `RETRY_MS` has passed; one ended by `stop` lets it at once.
    loading.catch((error: unknown) => {
      if (this.#loaded === loading) this.#loaded = null;
      if (this.#stops !== stops) return;
      const message = error instanceof Error ? error.message : 'The model couldn’t be loaded.';
      this.#failed = { at: Date.now(), message };
    });
    return loading;
  }

  /** What the loaded worker answers `request`, loading the model first if need be. */
  async #askLoaded(request: EmbedAsk): Promise<EmbedAnswer> {
    const loading = this.load();
    await loading.catch((error: unknown) => {
      throw new ModelUnavailable(error);
    });
    // Stopped between the load and this, which would start a worker with no model.
    if (this.#loaded !== loading) throw new Error('The embedding worker was stopped.');
    const answer = await this.#ask(request);
    if (answer.op === 'error') throw new Error(answer.message);
    if (answer.op !== request.op) throw new Error('The embedding worker answered out of turn.');
    return answer;
  }

  /** Each text's vector, in order, loading the model first if need be. */
  async embed(kind: EmbedKind, texts: string[]): Promise<Embedded> {
    const answer = await this.#askLoaded({ op: 'embed', kind, texts });
    if (answer.op !== 'embed') throw new Error('The embedding worker answered out of turn.');
    return { vectors: answer.vectors, tokens: answer.tokens };
  }

  /**
   * How many tokens the model's tokenizer makes of each word, a run without
   * spaces, its first and last tokens left out: what cutting passages counts
   * (`meaningPassages`), so they hold no more than the model is meant to read.
   */
  async count(words: string[]): Promise<number[]> {
    if (words.length === 0) return [];
    const answer = await this.#askLoaded({ op: 'count', words });
    if (answer.op !== 'count') throw new Error('The embedding worker answered out of turn.');
    return answer.counts;
  }

  /** Stop the worker now, failing anything still waiting on it. */
  stop() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    this.#stops++;
    this.#fail(() => new Error('The embedding worker was stopped.'));
  }
}

/**
 * Delete the worker's cache of the model, every model's, as turning search
 * by meaning off or signing out will (ADR 0016, decision 3).
 */
export async function forgetModel(): Promise<void> {
  if (typeof caches === 'undefined') return;
  for (const name of await caches.keys()) {
    if (name.startsWith(MEANING_CACHE_PREFIX)) await caches.delete(name);
  }
}
