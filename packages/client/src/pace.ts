// Long work on the main thread, such as an export, in slices: a page
// stays responsive to input, paint and a Cancel button between them.

/** Work between turns of the event loop: about two frames. */
const SLICE_MS = 30;

let since = performance.now();

type Yielding = { scheduler?: { yield?: () => Promise<void> } };

/**
 * Let the event loop run (a macrotask, so input and paint get in, not just
 * other promises) once this thread has worked `SLICE_MS` since it last did
 * here; until then it returns at once. Call it between steps of a long job.
 */
export async function pace(): Promise<void> {
  if (performance.now() - since < SLICE_MS) return;
  const { scheduler } = globalThis as Yielding;
  if (scheduler?.yield) await scheduler.yield();
  else await new Promise((resolve) => setTimeout(resolve, 0));
  since = performance.now();
}
