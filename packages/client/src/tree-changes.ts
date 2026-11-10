import { commentRoutes, structureRoutes, type PageId, type SpaceId } from '@wikistow/contracts';
import type { z } from 'zod';
import type { Fetch } from './api/client.ts';
import { jsonLines } from './json-lines.ts';

// The pause before opening the stream again: doubled after each try in a
// row that fails, up to the longest.
const FIRST_PAUSE_MS = 1000;
const LONGEST_PAUSE_MS = 30_000;
// The server sends a blank line every 15 seconds; three missed means the
// connection is gone.
const QUIET_MS = 45_000;

/**
 * Hear which spaces' trees change (`structureRoutes.treeChanges`) until
 * `signal` aborts: `onChange` gets the spaces each event names. A stream
 * that ends, fails or goes quiet opens again after a pause, and `onMissed`
 * runs once it has: whatever changed meanwhile went unheard.
 *
 *   const stop = new AbortController();
 *   void watchTreeChanges({
 *     signal: stop.signal,
 *     onChange: (spaceIds) => spaceIds.forEach(reloadTree),
 *     onMissed: reloadAllTrees,
 *   });
 */
export const watchTreeChanges = ({
  onChange,
  ...options
}: Watching & { onChange: (spaceIds: SpaceId[]) => void }): Promise<void> =>
  watchStream(structureRoutes.treeChanges, options, ({ spaceIds }) => onChange(spaceIds));

/**
 * Hear which pages' comments change (`commentRoutes.commentChanges`, ADR
 * 0014 decision 8), as `watchTreeChanges` hears the tree: `onChange` gets
 * the pages each event names, and `onMissed` runs after a stream opened
 * again.
 */
export const watchCommentChanges = ({
  onChange,
  ...options
}: Watching & { onChange: (pageIds: PageId[]) => void }): Promise<void> =>
  watchStream(commentRoutes.commentChanges, options, ({ pageIds }) => onChange(pageIds));

type Watching = {
  baseUrl?: string;
  fetch?: Fetch;
  signal: AbortSignal;
  onMissed: () => void;
};

// Read one stream route's events until `signal` aborts, opening it again
// after a pause whenever it ends, fails or goes quiet.
async function watchStream<E extends z.ZodType>(
  { path, event }: { path: string; event: E },
  {
    baseUrl = '',
    fetch: send = (url, init) => globalThis.fetch(url, init),
    signal,
    onMissed,
  }: Watching,
  onEvent: (event: z.output<E>) => void,
): Promise<void> {
  let pause = FIRST_PAUSE_MS;
  let dropped = false;
  while (!signal.aborted) {
    try {
      const response = await send(`${baseUrl}${path}`, {
        method: 'GET',
        credentials: 'same-origin',
        signal,
      });
      if (response.ok) {
        pause = FIRST_PAUSE_MS;
        if (dropped) onMissed();
        for await (const line of jsonLines(response, event, signal, QUIET_MS)) onEvent(line);
      } else {
        await response.body?.cancel();
      }
    } catch {
      // No answer, a dropped stream, or the stop: each tries again or ends below.
    }
    dropped = true;
    await rest(pause, signal);
    pause = Math.min(pause * 2, LONGEST_PAUSE_MS);
  }
}

// Wait `ms`, or less if `signal` aborts first.
function rest(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}
