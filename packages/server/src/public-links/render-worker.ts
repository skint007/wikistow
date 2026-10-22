// The render worker (`createRenderer`): renders one body at a time, off the
// server's thread. A render that throws, as one nested past the stack does,
// answers `ok: false`.
import { parentPort } from 'node:worker_threads';
import { renderBody, type RenderInput, type Rendered } from './render.ts';

export type RenderRequest = { id: number; input: RenderInput };
export type RenderResponse = { id: number } & ({ ok: true; rendered: Rendered } | { ok: false });

parentPort?.on('message', ({ id, input }: RenderRequest) => {
  let answer: RenderResponse;
  try {
    answer = { id, ok: true, rendered: renderBody(input) };
  } catch {
    answer = { id, ok: false };
  }
  parentPort?.postMessage(answer);
});
