/**
 * The model search by meaning runs (ADR 0016, decision 1): `bge-small-en-v1.5`
 * in the 8-bit ONNX form `Xenova/bge-small-en-v1.5` publishes, at a pinned
 * revision, each file by its SHA-256. The web build fetches the files from
 * Hugging Face at that revision and fails on any other bytes
 * (`apps/web/meaning.ts`), so a changed upload never reaches the app. The
 * model's hash names the embedding worker's cache, and will bind the kept
 * vectors to the model.
 */
export const MEANING_MODEL = {
  name: 'bge-small-en-v1.5',
  repository: 'Xenova/bge-small-en-v1.5',
  revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  files: {
    model: {
      path: 'onnx/model_quantized.onnx',
      sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
    },
    tokenizer: {
      path: 'tokenizer.json',
      sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
    },
    tokenizerConfig: {
      path: 'tokenizer_config.json',
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
    },
  },
  /** The length of each vector. */
  dimensions: 384,
  /** The most tokens it reads, its first and last included; the rest is cut. */
  maxTokens: 512,
  /** What a query starts with, and a passage doesn't, as the model card says. */
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
} as const;

/**
 * The embedding worker's cache of the model, its tokenizer and the
 * runtime's WebAssembly: named for the model's hash, and not starting
 * `wikistow-app-`, so a new build's service worker leaves it alone.
 */
export const MEANING_CACHE_PREFIX = 'wikistow-meaning-';
export const MEANING_CACHE = `${MEANING_CACHE_PREFIX}${MEANING_MODEL.files.model.sha256.slice(0, 16)}`;
