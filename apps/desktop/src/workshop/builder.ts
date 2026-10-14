import type { BuildDiagnostic } from '@wikistow/contracts';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

/** What the build worker bundles: the workspace's files, and each output's entry among them. */
export type BuildRequest = {
  files: [path: string, text: string][];
  entries: { output: string; entry: string }[];
};

const Diagnostic = z.object({
  severity: z.enum(['error', 'warning']),
  file: z.string().nullable(),
  line: z.number().nullable(),
  column: z.number().nullable(),
  message: z.string(),
});

const Answer = z.object({
  id: z.number(),
  outputs: z.record(z.string(), z.string()),
  diagnostics: z.array(Diagnostic),
});

/** Each output's bundled text, when every entry built; and what the bundler said. */
export type BuildOutput = { outputs: Record<string, string>; diagnostics: BuildDiagnostic[] };

/**
 * The workshop's bundler (`build-worker.ts`) in a worker thread, so a
 * build never holds up the main process. It starts with the first build
 * and runs until `stop`. `script` is the worker's bundled file and `wasm`
 * esbuild's WebAssembly, both beside the app's main bundle.
 */
export function workshopBuilder(script: URL, wasm: string) {
  let worker: Worker | null = null;
  let next = 0;
  const waiting = new Map<number, { resolve: (output: BuildOutput) => void; reject: () => void }>();

  const failAll = () => {
    for (const { reject } of waiting.values()) reject();
    waiting.clear();
  };

  const started = () => {
    if (worker) return worker;
    const thread = new Worker(script, { workerData: { wasm } });
    thread.on('message', (message: unknown) => {
      const answer = Answer.parse(message);
      waiting.get(answer.id)?.resolve(answer);
      waiting.delete(answer.id);
    });
    // A crash fails the builds waiting on it; the next build starts afresh.
    // A stopped thread's own end comes later, and its builds have failed already.
    const ended = () => {
      if (worker !== thread) return;
      worker = null;
      failAll();
    };
    thread.on('error', ended);
    thread.on('exit', ended);
    worker = thread;
    return thread;
  };

  return {
    build(request: BuildRequest): Promise<BuildOutput> {
      const thread = started();
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, {
          resolve,
          reject: () => reject(new Error('The plugin bundler stopped')),
        });
        thread.postMessage({ id, ...request });
      });
    },
    stop() {
      const thread = worker;
      worker = null;
      failAll();
      void thread?.terminate();
    },
  };
}
