// The render worker (`createRenderer`): renders one body at a time, off the
// server's thread. A render that throws, as one nested past the stack does,
// answers `ok: false`, and so does one whose rendering is past
// `RENDERING_LIMIT`, which every visit would load and send.
import { parentPort } from 'node:worker_threads';
import { renderBody, type RenderInput, type Rendered } from './render.ts';

/** The most a rendering's HTML may come to, as UTF-16 code units. */
const RENDERING_LIMIT = 4 * 1024 * 1024;

export type RenderRequest = { id: number; input: RenderInput };
export type RenderResponse = { id: number } & (
  | { ok: true; rendered: Rendered }
  | { ok: false; tooLarge: boolean }
);

const sizeOf = ({ segments }: Rendered) =>
  segments.reduce((size, segment) => size + (typeof segment === 'string' ? segment.length : 0), 0);

parentPort?.on('message', ({ id, input }: RenderRequest) => {
  let answer: RenderResponse;
  try {
    const rendered = renderBody(input);
    answer =
      sizeOf(rendered) > RENDERING_LIMIT
        ? { id, ok: false, tooLarge: true }
        : { id, ok: true, rendered };
  } catch {
    answer = { id, ok: false, tooLarge: false };
  }
  parentPort?.postMessage(answer);
});
