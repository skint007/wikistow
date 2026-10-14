// The real CLI, built the way CI builds it, run as a separate process the
// way an agent runs it, against the server the browser tests use.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CLI_DIR = fileURLToPath(new URL('../../cli', import.meta.url));
const SERVER = `http://127.0.0.1:${Number(process.env['E2E_PORT'] ?? 3100)}`;
export const AGENT_PASSPHRASE = 'agent key file passphrase for e2e PLAINTEXT-AGENT-e2e7';

const made: string[] = [];
// CLI processes still running: a failed step can leave `enroll` waiting.
const running = new Set<ChildProcess>();

/** Build `dist/wikistow.mjs` with `vp pack` outside the workspace; returns its path. */
export async function buildCli(): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), 'wikistow-e2e-cli-'));
  made.push(out);
  await promisify(execFile)(
    join(CLI_DIR, '../../node_modules/.bin/vp'),
    ['pack', '--out-dir', out],
    {
      cwd: CLI_DIR,
      timeout: 180_000,
    },
  );
  return join(out, 'wikistow.mjs');
}

/** Stop any CLI still running, then remove the bundle and every home made for an installation. */
export async function cleanUpCli() {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export type Run = { code: number | null; stdout: string; stderr: string };

/** One CLI installation: a home of its own, and a way to run the bundle in it. */
export async function cliInstall(bin: string) {
  const home = await mkdtemp(join(tmpdir(), 'wikistow-e2e-home-'));
  made.push(home);
  await mkdir(join(home, '.config'), { mode: 0o700 });

  const start = (args: readonly string[]) => {
    const child = spawn(process.execPath, [bin, ...args, '--passphrase-fd', '3'], {
      env: { HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    running.add(child);
    child.on('close', () => running.delete(child));
    const fd3 = child.stdio[3] as NodeJS.WritableStream;
    fd3.on('error', () => {});
    fd3.end(AGENT_PASSPHRASE);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const done = new Promise<Run>((resolve) =>
      child.on('close', (code) => resolve({ code, stdout, stderr })),
    );
    return {
      child,
      done,
      /** Wait for `pattern` on standard error, and give its first group. */
      async waitFor(pattern: RegExp, ms = 30_000): Promise<string> {
        const until = Date.now() + ms;
        for (;;) {
          const match = pattern.exec(stderr);
          if (match) return match[1] ?? match[0];
          if (child.exitCode !== null || Date.now() > until) {
            throw new Error(`never saw ${pattern}; stdout ${stdout}; stderr ${stderr}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
    };
  };

  /** Run a command to the end with `--json`, giving its exit code and parsed answer. */
  const json = async (args: readonly string[], stdin = '') => {
    const run = start([...args, '--json']);
    run.child.stdin?.end(stdin);
    const result = await run.done;
    return { ...result, answer: JSON.parse(result.stdout || 'null') as Record<string, unknown> };
  };

  /** Start enrolling: resolves with the lookup code and the fingerprint the CLI printed. */
  const enroll = async () => {
    const run = start(['agent', 'enroll', '--server', SERVER, '--fingerprint-answer-from-stdin']);
    const code = await run.waitFor(/Lookup code: ([0-9A-Z]{4}-[0-9A-Z]{4})/);
    return {
      code,
      /** Once the browser claimed it: the fingerprint the CLI worked out itself. */
      fingerprint: () => run.waitFor(/Enrollment fingerprint:\n {2}([0-9a-f ]{49})\n/),
      /** Its user types yes, as they would after comparing. */
      confirm: async () => {
        run.child.stdin?.write('yes\n');
        await run.waitFor(/Waiting for approval/);
        run.child.stdin?.end();
      },
      done: run.done,
    };
  };

  return { home, json, enroll };
}
