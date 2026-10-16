// The workshop's bundler (ADR 0004), in a module worker of the page:
// esbuild's WebAssembly build, with every file handed to it in memory. It
// fetches nothing but its WebAssembly, so an import resolves only to the
// draft's own files, or to the SDK and React the app carries. It only
// bundles; it never runs plugin code.
import type { BuildDiagnostic } from '@wikistow/contracts';
import * as esbuild from 'esbuild-wasm/esm/browser.js';
import wasmURL from 'esbuild-wasm/esbuild.wasm?url';
import library from 'virtual:workshop-library';
import { IMPORTS, OFFERED } from './library';
import type { BuildAnswer, BuildRequest } from './builder';

const LOADERS: Readonly<Record<string, esbuild.Loader>> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.json': 'json',
};
const loaderOf = (path: string) => LOADERS[/\.[^./]+$/.exec(path)?.[0] ?? ''];

const dirname = (path: string) => path.split('/').slice(0, -1).join('/');

/** `path` with `.` and `..` resolved; a leading `..` stays, as outside the top. */
function normalize(path: string) {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

const LIBRARY = new Map(Object.entries(library));
const NAMED = Object.keys(OFFERED).join(', ');

/** Resolve imports to the draft's files and the library, refusing everything else. */
function confined(files: ReadonlyMap<string, string>): esbuild.Plugin {
  return {
    name: 'workshop',
    setup(build) {
      build.onResolve({ filter: /.*/ }, ({ path, importer, namespace, kind }) => {
        if (kind === 'entry-point') return { path, namespace: 'workspace' };
        const mapped = IMPORTS[path];
        if (mapped !== undefined) return { path: mapped, namespace: 'library' };
        if (!path.startsWith('./') && !path.startsWith('../')) {
          return {
            errors: [
              {
                text: `Can’t import “${path}”. A workshop plugin imports its own files (./…) and ${NAMED}. Nothing else can be installed here.`,
              },
            ],
          };
        }
        const joined = normalize(`${dirname(importer)}/${path}`);
        if (namespace === 'library') {
          return LIBRARY.has(joined)
            ? { path: joined, namespace }
            : { errors: [{ text: `The library has no ${joined}` }] };
        }
        if (joined === '..' || joined.startsWith('../')) {
          return { errors: [{ text: `“${path}” is outside the draft.` }] };
        }
        const found = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']
          .map((suffix) => joined + suffix)
          .find((candidate) => files.has(candidate));
        if (found === undefined) return { errors: [{ text: `There’s no ${joined} to import.` }] };
        if (loaderOf(found) === undefined) {
          return {
            errors: [
              {
                text: `Only TypeScript, JavaScript and JSON can be imported. Styles go in public/ and the manifest’s styles.`,
              },
            ],
          };
        }
        return { path: found, namespace: 'workspace' };
      });
      build.onLoad({ filter: /.*/, namespace: 'workspace' }, ({ path }) => ({
        contents: files.get(path) ?? '',
        loader: loaderOf(path) ?? 'ts',
      }));
      build.onLoad({ filter: /.*/, namespace: 'library' }, ({ path }) => ({
        contents: LIBRARY.get(path) ?? '',
        loader: loaderOf(path) ?? 'js',
      }));
    },
  };
}

const diagnostic =
  (severity: BuildDiagnostic['severity']) =>
  ({ text, location }: esbuild.Message): BuildDiagnostic => ({
    severity,
    file: location?.file.replace(/^workspace:/, '') ?? null,
    line: location?.line ?? null,
    column: location ? location.column + 1 : null,
    message: text,
  });

async function bundle(files: ReadonlyMap<string, string>, entry: string, output: string) {
  // What the build said, which a failed build only tells `onEnd`.
  let said: Pick<esbuild.BuildResult, 'errors' | 'warnings'> = { errors: [], warnings: [] };
  try {
    const result = await esbuild.build({
      entryPoints: [entry],
      outfile: output,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2024',
      jsx: 'automatic',
      // Readable, for whoever approves it.
      minify: false,
      charset: 'utf8',
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
      plugins: [
        confined(files),
        { name: 'said', setup: (build) => build.onEnd((result) => void (said = result)) },
      ],
    });
    return { text: result.outputFiles[0]?.text ?? '', ...said };
  } catch {
    return { text: null, ...said };
  }
}

// esbuild runs here, not in a worker of its own: that would be a `blob:`
// worker, which the app's CSP refuses. WebAssembly compiles under its
// 'wasm-unsafe-eval'.
const ready = esbuild.initialize({ wasmURL, worker: false });
ready.catch(() => {});

// Set before anything is awaited, so no early request is lost.
self.onmessage = async ({ data }: MessageEvent<BuildRequest>) => {
  const { id, files, entries } = data;
  try {
    await ready;
  } catch (error) {
    const said = error instanceof Error ? error.message : 'it didn’t load';
    self.postMessage({
      id,
      outputs: {},
      diagnostics: [
        {
          severity: 'error',
          file: null,
          line: null,
          column: null,
          message: `The plugin bundler couldn’t start: ${said}`,
        },
      ],
      failed: true,
    } satisfies BuildAnswer);
    return;
  }
  const workspace = new Map(files);
  const outputs: Record<string, string> = {};
  const diagnostics: BuildDiagnostic[] = [];
  for (const { output, entry } of entries) {
    const built = await bundle(workspace, entry, output);
    diagnostics.push(...built.errors.map(diagnostic('error')));
    diagnostics.push(...built.warnings.map(diagnostic('warning')));
    if (built.text !== null) outputs[output] = built.text;
  }
  self.postMessage({ id, outputs, diagnostics, failed: false } satisfies BuildAnswer);
};
