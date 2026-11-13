import { MEANING_CACHE_PREFIX } from './model';

/** A search's words, which take the model's query prefix, or a page's passage. */
export type EmbedKind = 'query' | 'passage';

/** What the page asks the worker (`embed.worker.ts`), and with `id`, how. */
export type EmbedAsk =
  | { op: 'load'; keep: boolean }
  | { op: 'embed'; kind: EmbedKind; texts: string[] };
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
  | { id: number; op: 'error'; message: string };

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
      if (this.#worker === worker) this.#fail('The embedding worker stopped.');
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

  #fail(message: string) {
    this.#worker?.terminate();
    this.#worker = null;
    this.#loaded = null;
    for (const { reject } of this.#waiting.values()) reject(new Error(message));
    this.#waiting.clear();
  }

  /** Load the model, if this worker hasn't yet. */
  load(): Promise<Loaded> {
    this.#loaded ??= this.#ask({ op: 'load', keep: this.#keep }).then((answer) => {
      // The runtime keeps a failed start for the worker's life, so the next
      // load starts a new one.
      if (answer.op === 'error') {
        this.#fail(answer.message);
        throw new Error(answer.message);
      }
      if (answer.op !== 'load') throw new Error('The embedding worker answered out of turn.');
      return { from: answer.from };
    });
    // A load that fails lets the next try again, in a new worker.
    const loading = this.#loaded;
    loading.catch(() => {
      if (this.#loaded === loading) this.#loaded = null;
    });
    return loading;
  }

  /** Each text's vector, in order, loading the model first if need be. */
  async embed(kind: EmbedKind, texts: string[]): Promise<Embedded> {
    await this.load();
    const answer = await this.#ask({ op: 'embed', kind, texts });
    if (answer.op === 'error') throw new Error(answer.message);
    if (answer.op !== 'embed') throw new Error('The embedding worker answered out of turn.');
    return { vectors: answer.vectors, tokens: answer.tokens };
  }

  /** Stop the worker now, failing anything still waiting on it. */
  stop() {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    this.#fail('The embedding worker was stopped.');
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
