import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { EmbedAnswer, EmbedRequest } from '../src/meaning/embedder';
import { Embedder, ModelUnavailable, RETRY_MS, WorkerStopped } from '../src/meaning/embedder';

/** A worker that answers as the embedding worker would, with `reply`. */
class FakeWorker {
  static started: FakeWorker[] = [];
  static reply: (request: EmbedRequest) => EmbedAnswer | null = (request) =>
    request.op === 'load'
      ? { id: request.id, op: 'load', from: 'network' }
      : request.op === 'count'
        ? { id: request.id, op: 'count', counts: request.words.map((word) => word.length) }
        : {
            id: request.id,
            op: 'embed',
            vectors: request.texts.map(() => new Float32Array(384)),
            tokens: request.texts.map((text) => text.length),
          };
  onmessage: ((event: { data: EmbedAnswer }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  readonly asked: EmbedRequest[] = [];
  terminated = false;

  readonly url: URL;
  readonly options: WorkerOptions;

  constructor(url: URL, options: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.started.push(this);
  }

  postMessage(request: EmbedRequest) {
    this.asked.push(request);
    const answer = FakeWorker.reply(request);
    if (answer) queueMicrotask(() => this.onmessage?.({ data: answer }));
  }

  terminate() {
    this.terminated = true;
  }

  crash() {
    this.onerror?.({ preventDefault: () => {} });
  }
}

const defaultReply = FakeWorker.reply;

beforeEach(() => {
  FakeWorker.started = [];
  FakeWorker.reply = defaultReply;
  vi.stubGlobal('Worker', FakeWorker);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Embedder', () => {
  it('starts its module worker when first asked, and loads the model once', async () => {
    const embedder = new Embedder({ keep: true });
    expect(FakeWorker.started).toHaveLength(0);
    const { vectors, tokens } = await embedder.embed('query', ['trip to the coast']);
    expect(vectors).toHaveLength(1);
    expect(tokens).toEqual([17]);
    await embedder.embed('passage', ['a', 'bb']);
    const [worker] = FakeWorker.started;
    expect(FakeWorker.started).toHaveLength(1);
    expect(worker?.options).toEqual({ type: 'module', name: 'wikistow-meaning' });
    expect(worker?.url.pathname).toMatch(/\/embed\.worker\.ts$/);
    expect(worker?.asked.map(({ op }) => op)).toEqual(['load', 'embed', 'embed']);
    expect(worker?.asked[0]).toEqual({ id: 0, op: 'load', keep: true });
    expect(worker?.asked[2]).toEqual({ id: 2, op: 'embed', kind: 'passage', texts: ['a', 'bb'] });
  });

  it('counts words’ tokens with the model’s tokenizer, loading it first', async () => {
    const embedder = new Embedder({ keep: true });
    await expect(embedder.count(['soup', 'lasagne'])).resolves.toEqual([4, 7]);
    const [worker] = FakeWorker.started;
    expect(worker?.asked).toEqual([
      { id: 0, op: 'load', keep: true },
      { id: 1, op: 'count', words: ['soup', 'lasagne'] },
    ]);
    await expect(embedder.count([])).resolves.toEqual([]);
    expect(worker?.asked).toHaveLength(2);
  });

  it('stops the worker once idle, and starts and loads it again when next asked', async () => {
    const embedder = new Embedder({ keep: false, idleMs: 1000 });
    await embedder.embed('query', ['soup']);
    const [first] = FakeWorker.started;
    vi.advanceTimersByTime(999);
    expect(first?.terminated).toBe(false);
    // Asking again keeps it.
    await embedder.embed('query', ['bread']);
    vi.advanceTimersByTime(999);
    expect(first?.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(first?.terminated).toBe(true);

    await embedder.embed('query', ['beans']);
    const [, second] = FakeWorker.started;
    expect(second?.asked.map(({ op }) => op)).toEqual(['load', 'embed']);
    expect(second?.asked[0]).toEqual({ id: 3, op: 'load', keep: false });
  });

  it('fails what waits when the worker crashes, and starts afresh after', async () => {
    const embedder = new Embedder({ keep: true });
    await embedder.load();
    FakeWorker.reply = () => null;
    const waiting = embedder.embed('passage', ['soup']);
    await vi.waitFor(() => expect(FakeWorker.started[0]?.asked).toHaveLength(2));
    FakeWorker.started[0]?.crash();
    // Alone in the worker, it is at fault.
    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ModelUnavailable);
    expect((error as Error).message).toBe('The embedding worker stopped.');
    expect(FakeWorker.started[0]?.terminated).toBe(true);

    // A model that loaded is loaded again at once.
    FakeWorker.reply = defaultReply;
    await embedder.embed('query', ['soup']);
    expect(FakeWorker.started).toHaveLength(2);
  });

  it('holds none of the requests in a worker that crashes at fault', async () => {
    const embedder = new Embedder({ keep: true });
    await embedder.load();
    FakeWorker.reply = () => null;
    // A passage the queue embeds, and a query as search's typing pauses.
    const passage = embedder.embed('passage', ['soup']);
    const query = embedder.embed('query', ['bread']);
    await vi.waitFor(() => expect(FakeWorker.started[0]?.asked).toHaveLength(3));
    FakeWorker.started[0]?.crash();
    for (const waiting of [passage, query]) {
      const error = await waiting.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(WorkerStopped);
      expect(error).toBeInstanceOf(ModelUnavailable);
    }
  });

  it('loads again in a new worker once the wait after a failed load has passed', async () => {
    const embedder = new Embedder({ keep: true });
    FakeWorker.reply = (request) => ({ id: request.id, op: 'error', message: 'No model' });
    await expect(embedder.load()).rejects.toThrow('No model');
    expect(FakeWorker.started[0]?.terminated).toBe(true);
    FakeWorker.reply = defaultReply;
    // Until then, a query or search opening fails at once, with no worker started.
    vi.advanceTimersByTime(RETRY_MS - 1);
    await expect(embedder.load()).rejects.toThrow('No model');
    await expect(embedder.embed('query', ['soup'])).rejects.toBeInstanceOf(ModelUnavailable);
    expect(FakeWorker.started).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await expect(embedder.load()).resolves.toEqual({ from: 'network' });
    expect(FakeWorker.started).toHaveLength(2);
    expect(FakeWorker.started[1]?.asked.map(({ op }) => op)).toEqual(['load']);
  });

  it('waits as long after the worker crashes loading the model', async () => {
    const embedder = new Embedder({ keep: true });
    FakeWorker.reply = () => null;
    const loading = embedder.load();
    FakeWorker.started[0]?.crash();
    await expect(loading).rejects.toThrow('The embedding worker stopped.');
    FakeWorker.reply = defaultReply;
    await expect(embedder.embed('query', ['soup'])).rejects.toBeInstanceOf(ModelUnavailable);
    expect(FakeWorker.started).toHaveLength(1);
    vi.advanceTimersByTime(RETRY_MS);
    await embedder.embed('query', ['soup']);
    expect(FakeWorker.started).toHaveLength(2);
  });

  it('fails an embedding stopped just after its load, rather than start an empty worker', async () => {
    const embedder = new Embedder({ keep: true });
    // Stopped as the load lands, before the embedding goes on from it.
    const stopped = embedder.load().then(() => embedder.stop());
    const embedding = embedder.embed('query', ['soup']);
    await stopped;
    await expect(embedding).rejects.toThrow('The embedding worker was stopped.');
    expect(FakeWorker.started).toHaveLength(1);
  });

  it('fails what waits when stopped', async () => {
    const embedder = new Embedder({ keep: true });
    FakeWorker.reply = () => null;
    const waiting = embedder.load();
    embedder.stop();
    await expect(waiting).rejects.toThrow('The embedding worker was stopped.');
    // A load stopped didn't fail: the next starts at once.
    FakeWorker.reply = defaultReply;
    await expect(embedder.load()).resolves.toEqual({ from: 'network' });
    expect(FakeWorker.started).toHaveLength(2);
  });
});
