// The embedding worker (ADR 0016, decision 2): ONNX Runtime Web's
// WebAssembly build on one thread, with Hugging Face's tokenizer, in a
// module worker of the app's own. It takes texts and gives back vectors,
// and keeps none. Everything it loads is the app's own: the runtime's
// JavaScript is in this script, and the model, its tokenizer and the
// runtime's WebAssembly are files of the build, which it fetches from the
// app's origin and, in a browser, keeps in a cache of its own
// (`MEANING_CACHE`), so it runs offline as online. The runtime gets its
// WebAssembly as bytes and so fetches nothing itself.
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/wasm';
import wasmURL from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { files, tokenizerConfig } from 'virtual:meaning-model';
import type { EmbedAnswer, EmbedRequest, Loaded } from './embedder';
import { MEANING_CACHE, MEANING_CACHE_PREFIX, MEANING_MODEL } from './model';

type Model = { session: ort.InferenceSession; tokenizer: Tokenizer };

let model: Promise<Model> | null = null;

/** One of the three files, and how to tell its bytes are the ones this build means. */
type File = { url: string; check: (bytes: ArrayBuffer) => Promise<boolean> };

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
const hashed =
  (sha256: string) =>
  async (bytes: ArrayBuffer): Promise<boolean> =>
    hex(await crypto.subtle.digest('SHA-256', bytes)) === sha256;
/** WebAssembly's magic number, `\0asm`; the build names the runtime's by a hash of its own. */
const webAssembly = async (bytes: ArrayBuffer) =>
  bytes.byteLength > 4 && new Uint32Array(bytes, 0, 1)[0] === 0x6d736100;

const FILES: readonly File[] = [
  { url: files.model, check: hashed(MEANING_MODEL.files.model.sha256) },
  { url: files.tokenizer, check: hashed(MEANING_MODEL.files.tokenizer.sha256) },
  { url: wasmURL, check: webAssembly },
];

/**
 * The bytes at `url`, or an error naming it. The browser's HTTP cache may
 * answer, as for any of the app's files, so a worker that can't keep them
 * itself doesn't ask the server each time it starts, which would tell it
 * how often someone searches (ADR 0016, decision 7).
 */
async function fetched(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.arrayBuffer();
}

/**
 * The worker's cache, with other models' caches, and files of its own that
 * this build doesn't name (an older runtime's, say), deleted. Null where
 * there is no Cache Storage (a page not served over HTTPS) or it refuses
 * (site data blocked, say).
 */
async function opened(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith(MEANING_CACHE_PREFIX) && name !== MEANING_CACHE) {
        await caches.delete(name);
      }
    }
    const cache = await caches.open(MEANING_CACHE);
    const wanted = new Set(FILES.map(({ url }) => new URL(url, self.location.href).href));
    for (const request of await cache.keys()) {
      if (!wanted.has(request.url)) await cache.delete(request);
    }
    return cache;
  } catch {
    return null;
  }
}

/**
 * The three files, from the worker's cache when `keep`, which a file
 * missing from it is fetched into, once its bytes check out, so a wrong
 * answer (a proxy's page, say) is never kept. Without `keep` (the desktop
 * app, whose files are on its disk already) every file is fetched, and so
 * is any the cache can't give or take, as without Cache Storage or with
 * no room left.
 */
async function read(keep: boolean) {
  const cache = keep ? await opened() : null;
  if (!cache) {
    const bytes = await Promise.all(FILES.map(({ url }) => fetched(url)));
    return { bytes, from: keep ? ('network' as const) : ('files' as const) };
  }
  let fetchedAny = false;
  const bytes = await Promise.all(
    FILES.map(async ({ url, check }) => {
      const kept = await cache.match(url).catch(() => undefined);
      if (kept) return kept.arrayBuffer();
      fetchedAny = true;
      const bytes = await fetched(url);
      if (!(await check(bytes))) throw new Error(`${url} isn’t the file this build names`);
      // A response copies the bytes it is given. One the cache can't take
      // is fetched again next time.
      await cache.put(url, new Response(bytes)).catch(() => undefined);
      return bytes;
    }),
  );
  return { bytes, from: fetchedAny ? ('network' as const) : ('cache' as const) };
}

async function loaded(keep: boolean): Promise<{ model: Model; from: Loaded['from'] }> {
  const { bytes, from } = await read(keep);
  const [modelBytes, tokenizerBytes, wasm] = bytes as [ArrayBuffer, ArrayBuffer, ArrayBuffer];
  // Threads need cross-origin isolation, which the app hasn't (decision 2).
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmBinary = wasm;
  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const tokenizer = new Tokenizer(
    JSON.parse(new TextDecoder().decode(tokenizerBytes)) as object,
    tokenizerConfig,
  );
  return { model: { session, tokenizer }, from };
}

/**
 * One text's vector, unit length, from its first token (the model's CLS),
 * and how many tokens it read. A text past `maxTokens` is cut, keeping
 * the closing token.
 */
async function embedOne({ session, tokenizer }: Model, text: string) {
  let ids = tokenizer.encode(text).ids;
  const max = MEANING_MODEL.maxTokens;
  if (ids.length > max) ids = [...ids.slice(0, max - 1), ids[ids.length - 1] ?? 0];
  const shape = [1, ids.length];
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), shape),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), shape),
  };
  if (session.inputNames.includes('token_type_ids')) {
    feeds['token_type_ids'] = new ort.Tensor('int64', new BigInt64Array(ids.length), shape);
  }
  const output = await session.run(feeds);
  const name = session.outputNames.includes('last_hidden_state')
    ? 'last_hidden_state'
    : session.outputNames[0];
  const hidden = name === undefined ? undefined : output[name];
  if (!(hidden?.data instanceof Float32Array)) throw new Error('The model gave no vectors');
  const vector = hidden.data.slice(0, MEANING_MODEL.dimensions);
  for (const tensor of Object.values(output)) tensor.dispose();
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index++) vector[index] = (vector[index] ?? 0) / norm;
  return { vector, tokens: ids.length };
}

async function answer(request: EmbedRequest): Promise<EmbedAnswer> {
  if (request.op === 'load') {
    if (model) {
      await model;
      return { id: request.id, op: 'load', from: 'memory' };
    }
    const started = loaded(request.keep);
    model = started.then(({ model }) => model);
    // A load that fails lets the next try again.
    model.catch(() => {
      model = null;
    });
    return { id: request.id, op: 'load', from: (await started).from };
  }
  if (!model) throw new Error('The model isn’t loaded');
  const ready = await model;
  const prefix = request.kind === 'query' ? MEANING_MODEL.queryPrefix : '';
  const vectors: Float32Array[] = [];
  const tokens: number[] = [];
  // One at a time, so a long run never holds a short one up for long.
  for (const text of request.texts) {
    const one = await embedOne(ready, prefix + text);
    vectors.push(one.vector);
    tokens.push(one.tokens);
  }
  return { id: request.id, op: 'embed', vectors, tokens };
}

self.onmessage = ({ data }: MessageEvent<EmbedRequest>) => {
  answer(data).then(
    (result) => {
      const transfer = result.op === 'embed' ? result.vectors.map((vector) => vector.buffer) : [];
      self.postMessage(result, { transfer });
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      self.postMessage({ id: data.id, op: 'error', message } satisfies EmbedAnswer);
    },
  );
};
