// Running the embedding worker (ADR 0016, step 2) from one of the app's
// pages, as the built app serves it, and timing it, by talking to the built
// worker in its own terms (`EmbedRequest`).
import type { Page } from '@playwright/test';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  EmbedAnswer,
  EmbedAsk,
  EmbedRequest,
} from '../../../packages/ui/src/meaning/embedder';

const ASSETS = fileURLToPath(new URL('../dist/assets/', import.meta.url));

/** The built worker's path, as the app would start it. */
export async function embedWorker(assets = ASSETS): Promise<string> {
  const names = (await readdir(assets)).filter((name) => /^embed\.worker-[\w-]+\.js$/.test(name));
  if (names.length !== 1) throw new Error(`The build has ${names.length} embedding workers`);
  return `/assets/${names[0]}`;
}

/** What one run of the worker found, and how long each part took, in milliseconds. */
export type Run = {
  from: string;
  /** Fetching or reading the files and making the session. */
  loadMs: number;
  /** The first embedding after that, which warms the session. */
  firstMs: number;
  /** The median of `repeats` embeddings of the query, and of the passage. */
  queryMs: number;
  passageMs: number;
  passageTokens: number;
  query: number[];
  /** Each passage's similarity to the query. */
  scores: number[];
};

/**
 * In `page`, start the worker at `worker`, load the model (keeping its
 * files in the worker's cache with `keep`), embed `query` and `passages`,
 * then time `repeats` more of the query and of the first passage, and stop it.
 */
export async function embedIn(
  page: Page,
  worker: string,
  options: { keep: boolean; query: string; passages: string[]; repeats?: number },
): Promise<Run> {
  return page.evaluate(
    async ({ worker, keep, query, passages, repeats }) => {
      const started = new Worker(worker, { type: 'module' });
      let next = 0;
      const ask = (request: EmbedAsk) =>
        new Promise<EmbedAnswer>((resolve, reject) => {
          const id = next++;
          const listen = ({ data }: MessageEvent<EmbedAnswer>) => {
            if (data.id !== id) return;
            started.removeEventListener('message', listen);
            if (data.op === 'error') reject(new Error(data.message));
            else resolve(data);
          };
          started.addEventListener('message', listen);
          started.onerror = (event) => reject(new Error(`The worker failed: ${event.message}`));
          started.postMessage({ ...request, id } satisfies EmbedRequest);
        });
      const embedded = async (kind: 'query' | 'passage', texts: string[]) => {
        const answer = await ask({ op: 'embed', kind, texts });
        if (answer.op !== 'embed') throw new Error('Not an embedding');
        return answer;
      };
      const median = (times: number[]) => times.sort((a, b) => a - b)[times.length >> 1] ?? NaN;
      const timed = async (kind: 'query' | 'passage', text: string) => {
        const times: number[] = [];
        for (let run = 0; run < repeats; run++) {
          const start = performance.now();
          await embedded(kind, [text]);
          times.push(performance.now() - start);
        }
        return median(times);
      };
      try {
        let start = performance.now();
        const loaded = await ask({ op: 'load', keep });
        if (loaded.op !== 'load') throw new Error('Not loaded');
        const loadMs = performance.now() - start;
        start = performance.now();
        const [queryVector] = (await embedded('query', [query])).vectors;
        const firstMs = performance.now() - start;
        const { vectors, tokens } = await embedded('passage', passages);
        if (!queryVector) throw new Error('No vector for the query');
        const scores = vectors.map((vector) =>
          vector.reduce((sum, value, index) => sum + value * (queryVector[index] ?? 0), 0),
        );
        return {
          from: loaded.from,
          loadMs,
          firstMs,
          queryMs: await timed('query', query),
          passageMs: await timed('passage', passages[0] ?? ''),
          passageTokens: tokens[0] ?? 0,
          query: [...queryVector],
          scores,
        };
      } finally {
        started.terminate();
      }
    },
    { worker, repeats: 7, ...options },
  );
}

/** A search, and the page it means, which shares none of its words, then one it doesn't. */
export const QUERY = 'trip to the coast';
export const PASSAGES = [
  // About 256 tokens, the longest passage the index will embed (decision 4).
  'Summer holiday in Cornwall. We rented a cottage in St Ives for a week in August, five minutes from Porthmeor beach. ' +
    'The children spent every morning in the rock pools and learnt to body-board on the small waves by the surf school, ' +
    'while we took turns walking the path along the cliffs towards Zennor. On the Wednesday it rained, so we drove to the ' +
    'Eden Project and then had fish and chips on the harbour wall, guarding them from the gulls. The tide goes out a long ' +
    'way at Hayle, which makes it a good beach for kites and sandcastles, and the café there does the best pasties we found. ' +
    'Book the cottage early: the owner, Mrs Penrose, lets it to the same families every year and only advertises what is ' +
    'left in January. Bring wetsuits, as the sea is cold even in August, and a windbreak. Parking in town is hard, so leave ' +
    'the car at Lelant and take the little train along the bay, which is half the fun. Next year we would like to try ' +
    'the Scilly ferry from Penzance, if the weather is calm enough for the crossing, and spend a night on Tresco.',
  'The boiler keeps losing pressure. Top it up to 1.5 bar with the filling loop under the boiler, and call the engineer ' +
    'if it falls below 1 bar again within a week.',
];
