// The model search by meaning runs, in the web build (ADR 0016, decision 3).
// The build fetches it from Hugging Face at the revision `MEANING_MODEL`
// pins, checks each file's SHA-256, and fails on any other bytes. The
// model and its tokenizer become hashed files under `MEANING_FILES`, and
// they and the runtime's WebAssembly each have a Brotli copy beside them,
// which the
// server sends to a browser that accepts Brotli (`serveWebApp`). The
// service worker keeps none of them, and the desktop package none of the
// copies.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, brotliDecompress, constants } from 'node:zlib';
import { MEANING_MODEL } from '../../packages/ui/src/meaning/model.ts';

/** The folder of the build holding the model's files, and nothing else. */
export const MEANING_FILES = '/assets/meaning/';

/**
 * Where fetched files and their Brotli copies are kept between builds, by
 * hash: `WIKISTOW_MODEL_CACHE`, or a folder under the workspace's
 * `node_modules`.
 */
const CACHE =
  process.env['WIKISTOW_MODEL_CACHE'] ||
  fileURLToPath(new URL('../../node_modules/.cache/wikistow-meaning/', import.meta.url));

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const short = (hash: string) => hash.slice(0, 16);

async function keep(name: string, bytes: Uint8Array) {
  await mkdir(CACHE, { recursive: true });
  const temporary = join(CACHE, `${name}.${process.pid}.part`);
  await writeFile(temporary, bytes);
  await rename(temporary, join(CACHE, name));
}

type Pinned = { readonly path: string; readonly sha256: string };

/** A pinned file's bytes, from the cache or else from Hugging Face, checked either way. */
async function pinned(file: Pinned): Promise<Uint8Array> {
  const kept = await readFile(join(CACHE, file.sha256)).catch(() => null);
  if (kept && sha256(kept) === file.sha256) return kept;
  const url = `https://huggingface.co/${MEANING_MODEL.repository}/resolve/${MEANING_MODEL.revision}/${file.path}`;
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = sha256(bytes);
      // Not one to retry: the file there isn't the one pinned.
      if (hash !== file.sha256) {
        throw Object.assign(
          new Error(`${url} has SHA-256 ${hash}, not ${file.sha256} as pinned in MEANING_MODEL`),
          { final: true },
        );
      }
      await keep(file.sha256, bytes);
      return bytes;
    } catch (error) {
      if (error instanceof Error && 'final' in error) throw error;
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw new Error(`Couldn’t fetch the model file ${file.path}`, { cause: failure });
}

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

/** `bytes` with Brotli at its best, kept by their hash, as it takes a while. */
async function brotli(bytes: Uint8Array): Promise<Uint8Array> {
  const name = `${sha256(bytes)}.br`;
  const kept = await readFile(join(CACHE, name)).catch(() => null);
  if (kept && (await decompress(kept).then(sha256, () => null)) === sha256(bytes)) return kept;
  const compressed = await compress(bytes, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_LGWIN]: constants.BROTLI_MAX_WINDOW_BITS,
      [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
    },
  });
  await keep(name, compressed);
  return compressed;
}

/**
 * The runtime's WebAssembly, as the worker's build writes it: the runtime
 * names it for its build (`new URL(…, import.meta.url)`), and the worker
 * imports it with `?url`, so it is one file under `/assets/`.
 */
const RUNTIME_WASM = /^\/assets\/ort-wasm-simd-threaded-[^/]+\.wasm$/;

/**
 * Whether `path` is one of the model's files or the runtime's WebAssembly,
 * which only someone who turns on search by meaning downloads.
 */
export const meaningFile = (path: string) =>
  path.startsWith(MEANING_FILES) || RUNTIME_WASM.test(path);

/**
 * Each file's path in the build. Their hashes are pinned, so their names
 * are known before they are fetched.
 */
const { model, tokenizer, tokenizerConfig } = MEANING_MODEL.files;
export const meaningFiles = {
  model: `${MEANING_FILES}${MEANING_MODEL.name}-${short(model.sha256)}.onnx`,
  tokenizer: `${MEANING_FILES}tokenizer-${short(tokenizer.sha256)}.json`,
};
const pinnedFiles = new Map<string, Pinned>([
  [meaningFiles.model, model],
  [meaningFiles.tokenizer, tokenizer],
]);

const VIRTUAL = 'virtual:meaning-model';

/**
 * `virtual:meaning-model`, for the embedding worker: where the model and
 * its tokenizer are, and the tokenizer's settings, a few hundred bytes,
 * carried in the worker. Only the worker's build reads it (`worker.plugins`).
 */
export const meaningModule = {
  name: 'meaning-model',
  resolveId: (id: string) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
  load: async (id: string) => {
    if (id !== `\0${VIRTUAL}`) return null;
    const config: unknown = JSON.parse(new TextDecoder().decode(await pinned(tokenizerConfig)));
    return `export const files = ${JSON.stringify(meaningFiles)};\nexport const tokenizerConfig = ${JSON.stringify(config)};\n`;
  },
};

type Bundle = Record<string, { type: string; fileName: string; source?: string | Uint8Array }>;

/**
 * The model and its tokenizer in the build, and a Brotli copy of each and
 * of the runtime's WebAssembly; on the dev server, the two from the cache.
 */
export const meaningModel = {
  name: 'meaning-files',
  configureServer(server: {
    middlewares: {
      use: (path: string, handle: (req: unknown, res: ServerResponse) => void) => void;
    };
  }) {
    for (const [path, file] of pinnedFiles) {
      server.middlewares.use(path, (_req, res) => {
        pinned(file).then(
          (bytes) => {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.end(bytes);
          },
          (error: unknown) => {
            res.statusCode = 500;
            res.end(String(error));
          },
        );
      });
    }
  },
  generateBundle: {
    // After the worker's build has put the runtime's WebAssembly in the bundle.
    order: 'post' as const,
    async handler(
      this: {
        emitFile: (file: { type: 'asset'; fileName: string; source: Uint8Array }) => string;
      },
      _options: unknown,
      bundle: Bundle,
    ) {
      const files: [string, Uint8Array][] = await Promise.all(
        [...pinnedFiles].map(
          async ([path, file]) => [path.slice(1), await pinned(file)] as [string, Uint8Array],
        ),
      );
      for (const [path, bytes] of files) {
        this.emitFile({ type: 'asset', fileName: path, source: bytes });
      }
      const runtime = Object.values(bundle).filter(
        (file) => file.type === 'asset' && RUNTIME_WASM.test(`/${file.fileName}`),
      );
      if (runtime.length !== 1) {
        throw new Error(
          `The build has ${runtime.length} copies of the runtime’s WebAssembly, not one`,
        );
      }
      for (const { fileName, source } of runtime) {
        if (source instanceof Uint8Array) files.push([fileName, source]);
      }
      await Promise.all(
        files.map(async ([path, bytes]) => {
          this.emitFile({ type: 'asset', fileName: `${path}.br`, source: await brotli(bytes) });
        }),
      );
    },
  },
};
