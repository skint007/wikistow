// The workshop's bundler (#257), in a worker thread of the main process:
// esbuild's WebAssembly build, with every file handed to it in memory. It
// has no disk or network of its own, so an import resolves only to the
// workspace's own files, or to the SDK and React the app carries.
import type { BuildDiagnostic } from '@wikistow/contracts';
import * as esbuild from 'esbuild-wasm/esm/browser.js';
import library from 'virtual:workshop-library';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { IMPORTS, OFFERED } from './library.ts';

const Request = z.object({
  id: z.number(),
  files: z.array(z.tuple([z.string(), z.string()])),
  entries: z.array(z.object({ output: z.string(), entry: z.string() })),
});

const LOADERS: Readonly<Record<string, esbuild.Loader>> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.json': 'json',
};
const loaderOf = (path: string) => LOADERS[posix.extname(path)];

const LIBRARY = new Map(Object.entries(library));
const NAMED = Object.keys(OFFERED).join(', ');

// esbuild's browser build runs here without a worker of its own, and looks
// for the worker global `self`: this thread has nothing else to confuse.
Reflect.set(globalThis, 'self', globalThis);
const { wasm } = z.object({ wasm: z.string() }).parse(workerData);
const ready = readFile(wasm)
  .then((bytes) => WebAssembly.compile(bytes))
  .then((wasmModule) => esbuild.initialize({ wasmModule, worker: false }));

/** Resolve imports to the workspace's files and the library, refusing everything else. */
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
        const joined = posix.normalize(posix.join(posix.dirname(importer), path));
        if (namespace === 'library') {
          return LIBRARY.has(joined)
            ? { path: joined, namespace }
            : { errors: [{ text: `The library has no ${joined}` }] };
        }
        if (joined === '..' || joined.startsWith('../')) {
          return { errors: [{ text: `“${path}” is outside the workspace.` }] };
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

parentPort?.on('message', async (message: unknown) => {
  const { id, files, entries } = Request.parse(message);
  await ready;
  const workspace = new Map(files);
  const outputs: Record<string, string> = {};
  const diagnostics: BuildDiagnostic[] = [];
  for (const { output, entry } of entries) {
    const built = await bundle(workspace, entry, output);
    diagnostics.push(...built.errors.map(diagnostic('error')));
    diagnostics.push(...built.warnings.map(diagnostic('warning')));
    if (built.text !== null) outputs[output] = built.text;
  }
  parentPort?.postMessage({ id, outputs, diagnostics });
});
