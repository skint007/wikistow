import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { LogEntry } from '../src/http/logger.ts';
import { scheduleSweep } from '../src/sweep.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduleSweep', () => {
  it('logs a failing sweep and keeps running it', async () => {
    vi.useFakeTimers();
    const logs: LogEntry[] = [];
    const failing = scheduleSweep(
      (entry) => logs.push(entry),
      'failing-sweep',
      () => Promise.reject(new TypeError('broken')),
      1000,
    );
    try {
      await vi.advanceTimersByTimeAsync(3500);
      expect(logs).toContainEqual({
        level: 'error',
        event: 'failing-sweep-failed',
        name: 'TypeError',
      });
      expect(logs.filter((entry) => entry.event === 'failing-sweep-failed')).toHaveLength(4);
    } finally {
      clearInterval(failing);
    }
  });
});
