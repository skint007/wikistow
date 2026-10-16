import { pluginRoutes, type BuildDiagnostic } from '@wikistow/contracts';
import { checkPlugin, PluginFolderError, type CheckedPlugin } from '@wikistow/plugin-sdk/files';
import { Manifest, MANIFEST_FILE } from '@wikistow/plugin-sdk/manifest';

/** What the build worker bundles: the draft's files, and each output's entry among them. */
export type BuildRequest = {
  id: number;
  files: [path: string, text: string][];
  entries: { output: string; entry: string }[];
};

/** Each output's bundled text, when its entry built; what esbuild said; and whether the worker is broken. */
export type BuildAnswer = {
  id: number;
  outputs: Record<string, string>;
  diagnostics: BuildDiagnostic[];
  failed: boolean;
};

type Bundled = Pick<BuildAnswer, 'outputs' | 'diagnostics'>;

/**
 * The bundler (`build-worker.ts`) in a module worker of the page, so a
 * build never holds up the page. It starts with the first build and runs
 * until `stop`; a crash fails the builds waiting on it, and the next
 * starts afresh.
 */
export class Bundler {
  #worker: Worker | null = null;
  #next = 0;
  readonly #waiting = new Map<number, { resolve: (out: Bundled) => void; reject: () => void }>();

  #started() {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL('./build-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }: MessageEvent<BuildAnswer>) => {
      this.#waiting.get(data.id)?.resolve(data);
      this.#waiting.delete(data.id);
      // Its esbuild never started: the next build tries a new worker.
      if (data.failed && this.#worker === worker) this.stop();
    };
    worker.onerror = () => {
      if (this.#worker === worker) this.stop();
    };
    this.#worker = worker;
    return worker;
  }

  bundle(files: ReadonlyMap<string, string>, entries: BuildRequest['entries']): Promise<Bundled> {
    const worker = this.#started();
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, {
        resolve,
        reject: () => reject(new Error('The plugin bundler stopped.')),
      });
      worker.postMessage({ id, files: [...files], entries } satisfies BuildRequest);
    });
  }

  stop() {
    this.#worker?.terminate();
    this.#worker = null;
    for (const { reject } of this.#waiting.values()) reject();
    this.#waiting.clear();
  }
}

/** A build that worked: its folder's files, checked and hashed as the library does. */
export type Built = CheckedPlugin & { bytes: ReadonlyMap<string, Uint8Array> };

/** What a build said, and its folder if it worked. */
export type BuildResult = { diagnostics: BuildDiagnostic[]; built: Built | null };

const error = (message: string, file: string | null = null): BuildDiagnostic => ({
  severity: 'error',
  file,
  line: null,
  column: null,
  message,
});

/** Why the library would refuse the built folder `bytes`, or null when it wouldn't. */
function libraryProblem(bytes: ReadonlyMap<string, Uint8Array>, manifest: Manifest) {
  if (bytes.size > pluginRoutes.MAX_VERSION_FILES) {
    return `A plugin holds ${pluginRoutes.MAX_VERSION_FILES} files at most.`;
  }
  for (const path of bytes.keys()) {
    const problem = pluginRoutes.uploadPathProblem(path);
    if (problem) return problem;
  }
  const size = [...bytes.values()].reduce((total, data) => total + data.length, 0);
  if (size > pluginRoutes.MAX_VERSION_BYTES) return 'A plugin holds 10 MB at most.';
  const script = manifest.script && bytes.get(manifest.script);
  if (script && script.length > pluginRoutes.MAX_SCRIPT_BYTES) {
    return 'A plugin’s script is 1 MB at most.';
  }
  return null;
}

/**
 * Build a draft's files as `wikistow-plugin build` lays them out: the
 * manifest, `ui.js` and `script.js` from `src/<name>.ts(x)`, and
 * `public/`'s files at the top, plus every draft file under `source/`, so
 * a published version carries its source. Checked with the library's
 * limits, so a build that couldn't be published fails as a build, and
 * hashed as an install hashes it.
 */
export async function buildDraft(
  texts: ReadonlyMap<string, string>,
  bundler: Bundler,
): Promise<BuildResult> {
  const failed = (diagnostics: BuildDiagnostic[]): BuildResult => ({ diagnostics, built: null });
  const raw = texts.get(MANIFEST_FILE);
  if (raw === undefined) return failed([error(`The draft has no ${MANIFEST_FILE}.`)]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (problem) {
    const said = problem instanceof Error ? problem.message : 'it isn’t JSON';
    return failed([error(`${MANIFEST_FILE} isn’t valid JSON: ${said}`, MANIFEST_FILE)]);
  }
  const checked = Manifest.safeParse(parsed);
  if (!checked.success) {
    return failed(
      checked.error.issues.map((issue) =>
        error(`${issue.path.join('.') || 'The manifest'}: ${issue.message}`, MANIFEST_FILE),
      ),
    );
  }
  const manifest = checked.data;
  const entries: BuildRequest['entries'] = [];
  for (const output of [manifest.ui, manifest.script]) {
    if (output === undefined) continue;
    const name = output.replace(/^.*\//, '').replace(/\.[^.]*$/, '');
    const entry = [`src/${name}.tsx`, `src/${name}.ts`].find((path) => texts.has(path));
    if (!entry) return failed([error(`There’s no src/${name}.ts or .tsx for ${output}.`)]);
    entries.push({ output, entry });
  }
  const { outputs, diagnostics } = await bundler.bundle(texts, entries);
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return failed(diagnostics);
  const encoder = new TextEncoder();
  const bytes = new Map<string, Uint8Array>();
  for (const [path, text] of texts) {
    bytes.set(`source/${path}`, encoder.encode(text));
    if (path.startsWith('public/')) bytes.set(path.slice('public/'.length), encoder.encode(text));
  }
  for (const [output, text] of Object.entries(outputs)) bytes.set(output, encoder.encode(text));
  bytes.set(MANIFEST_FILE, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  const problem = libraryProblem(bytes, manifest);
  if (problem) return failed([...diagnostics, error(problem)]);
  try {
    return { diagnostics, built: { ...(await checkPlugin(bytes)), bytes } };
  } catch (thrown) {
    if (!(thrown instanceof PluginFolderError)) throw thrown;
    return failed([...diagnostics, error(thrown.message)]);
  }
}
