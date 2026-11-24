import { expect, test } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { launch, newProfile } from './desktop';

// Logging out, or `systemctl stop`, ends every process of the app at once,
// and Chromium moves the app itself into a systemd scope of its own, so its
// helpers can end first. Started through the unsandboxed zygote, a GPU
// process could then not start again, and Chromium crashed the app on purpose
// with a core dump (#627). The launcher's switches keep it from needing one.

/** The app's processes below `root`, by ID, with each one's `--type`. */
async function descendants(root: number): Promise<Map<number, string>> {
  const parents = new Map<number, number>();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
    // The name, in parentheses, may hold spaces; the parent's ID is the second field after it.
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (parent) parents.set(Number(entry), parent);
  }
  const found = new Map<number, string>();
  const below = (pid: number): boolean =>
    pid === root || (parents.has(pid) && below(parents.get(pid) ?? 0));
  for (const pid of parents.keys()) {
    if (pid === root || !below(pid)) continue;
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const type = /--type=([a-z-]+)/.exec(cmdline)?.[1];
    if (type) found.set(pid, type);
  }
  return found;
}

test('outlives its zygotes and GPU process ending first, and quits cleanly', async () => {
  test.skip(process.platform !== 'linux', 'only Linux has zygotes');
  const desktop = await launch(await newProfile());
  const app = desktop.app.process();
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    app.once('exit', (code, signal) => resolve({ code, signal })),
  );
  await expect(desktop.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const before = await descendants(app.pid ?? 0);
  const ending = [...before].filter(([, type]) => type === 'zygote' || type === 'gpu-process');
  expect(ending.map(([, type]) => type)).toContain('zygote');
  expect(ending.map(([, type]) => type)).toContain('gpu-process');
  for (const [pid] of ending) process.kill(pid, 'SIGTERM');

  // A new GPU process starts, and the app goes on.
  await expect
    .poll(async () => {
      if (app.exitCode !== null || app.signalCode !== null) {
        return `ended: ${app.signalCode ?? app.exitCode}`;
      }
      const now = await descendants(app.pid ?? 0);
      return [...now].some(([pid, type]) => type === 'gpu-process' && !before.has(pid))
        ? 'GPU process started again'
        : 'waiting';
    })
    .toBe('GPU process started again');
  await expect(desktop.window.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await desktop.app.close();
  expect(await exited).toEqual({ code: 0, signal: null });
});
