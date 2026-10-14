import type { Log } from './http/logger.ts';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Run `sweep` now and then every `intervalMs`, logging what it removed as
 * `event`, or `<event>-failed`. A run still going when the next is due is
 * left to finish instead. Returns the timer, for shutdown.
 */
export function scheduleSweep(
  log: Log,
  event: string,
  sweep: () => Promise<Record<string, number>>,
  intervalMs = HOUR_MS,
) {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    sweep()
      .then(
        (removed) => log({ level: 'info', event, ...removed }),
        (error: unknown) =>
          log({
            level: 'error',
            event: `${event}-failed`,
            name: error instanceof Error ? error.name : 'unknown',
          }),
      )
      .finally(() => {
        running = false;
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
