// The built CLI, run as its users run it, against the real server app
// listening on a loopback port, with a hook to make that server lie.
import { serve, type ServerType } from '@hono/node-server';
import { agentOperations } from '@wikistow/client';
import type { PageId, RevisionId, SpaceId } from '@wikistow/contracts';
import type { TestApp } from '@wikistow/server-app/testing/harness';
import type { Person } from '@wikistow/server-app/testing/sharing';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect } from 'vite-plus/test';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');
// Built outside the workspace, so the bundle can't find a dependency in
// node_modules that it left out, and CI's own build can't overwrite it.
const OUT_DIR = mkdtempSync(join(tmpdir(), 'wikistow-cli-dist-'));
const BIN = join(OUT_DIR, 'wikistow.mjs');

/** Build the bundle the tests run, with the same `vp pack` CI runs. */
export async function buildCli(): Promise<void> {
  const vp = join(APP_DIR, '../../node_modules/.bin/vp');
  // Its secret-tool stand-in is the user's own, which the real build refuses.
  const trustAny = '--env.WIKISTOW_TEST_TRUST_ANY_SECRET_TOOL=yes';
  await promisify(execFile)(vp, ['pack', '--out-dir', OUT_DIR, trustAny], {
    cwd: APP_DIR,
    timeout: 120_000,
  });
}

/** A request the server would answer, and how it would. */
export type Intercept = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

/** The test app on a loopback port. Set `intercept` to make it lie. */
export async function listen(t: TestApp) {
  const hooks: { intercept: Intercept | null } = { intercept: null };
  let server!: ServerType;
  const port = await new Promise<number>((resolve) => {
    server = serve(
      {
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request: Request, env: unknown) => {
          const forward = () => Promise.resolve(t.app.fetch(request, env));
          return hooks.intercept ? hooks.intercept(request, forward) : forward();
        },
      },
      (info) => resolve(info.port),
    );
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    hooks,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type Listening = Awaited<ReturnType<typeof listen>>;

const made: string[] = [OUT_DIR];

/** Remove the bundle and every home the tests made. */
export const cleanUp = () =>
  Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));

/** A home of its own for one CLI installation: `~` and `~/.config`. */
export async function cliHome() {
  const home = await mkdtemp(join(tmpdir(), 'wikistow-cli-'));
  made.push(home);
  const config = join(home, '.config');
  await mkdir(config, { mode: 0o700 });
  return { home, config, dir: join(config, 'wikistow') };
}

export type CliHome = Awaited<ReturnType<typeof cliHome>>;

/**
 * What `--json` printed, loosely typed for tests: a failure's `error`, the
 * IDs commands answer with, and anything else as unknown.
 */
export type Answer = {
  [field: string]: unknown;
  error: { exit: number; code: string; message: string; [field: string]: unknown };
  pageId: PageId;
  revisionId: RevisionId;
  spaceId: SpaceId;
  name: string;
  markdown: string;
};

export type Run = { code: number | null; stdout: string; stderr: string; json: () => Answer };

type RunOptions = {
  /** Given to the CLI on file descriptor 3, with `--passphrase-fd 3` added. */
  passphrase?: string;
  stdin?: string | Uint8Array;
};

/** Start the built CLI as `home`'s user. */
function start(home: CliHome, args: readonly string[], options: RunOptions = {}) {
  const withFd = options.passphrase === undefined ? args : [...args, '--passphrase-fd', '3'];
  const child = spawn(process.execPath, [BIN, ...withFd], {
    env: {
      HOME: home.home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
    },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const fd3 = child.stdio[3] as NodeJS.WritableStream;
  fd3.on('error', () => {});
  fd3.end(options.passphrase ?? '');
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const done = new Promise<Run>((resolve) => {
    child.on('close', (code) =>
      resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) as Answer }),
    );
  });
  return {
    child,
    done,
    /** Wait for `pattern` on standard error, and give its first group. */
    async waitFor(pattern: RegExp, ms = 15_000): Promise<string> {
      const until = Date.now() + ms;
      for (;;) {
        const match = pattern.exec(stderr);
        if (match) return match[1] ?? match[0];
        if (child.exitCode !== null || Date.now() > until) {
          throw new Error(`never saw ${pattern}; stdout ${stdout}; stderr ${stderr}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

/** Run the built CLI to the end. */
export async function cli(home: CliHome, args: readonly string[], options: RunOptions = {}) {
  const run = start(home, args, options);
  if (options.stdin === undefined) run.child.stdin?.end();
  return run.done;
}

export const PASSPHRASE = 'agent key file passphrase PLAINTEXT-CLI-PASS-5e1b';

/**
 * Enroll the CLI in `home` for `person`, the way the two of them would:
 * the CLI shows a code, the person claims it, both show one fingerprint,
 * the CLI's user types yes, the person approves with `picks`.
 */
export async function enroll(
  server: Listening,
  home: CliHome,
  person: Person,
  {
    picks = [],
    name = `cli ${Math.random().toString(36).slice(2, 8)}`,
    extra = [],
  }: {
    picks?: agentOperations.AgentPick[];
    name?: string;
    extra?: string[];
  } = {},
) {
  const enrolling = [
    'agent',
    'enroll',
    '--server',
    server.origin,
    '--fingerprint-answer-from-stdin',
  ];
  const run = start(home, [...enrolling, '--json', ...extra], {
    passphrase: PASSPHRASE,
  });
  const code = await run.waitFor(/Lookup code: ([0-9A-Z]{4}-[0-9A-Z]{4})/);
  const claim = await agentOperations.claimEnrollment(person.ctx, code);
  const shown = await run.waitFor(/Enrollment fingerprint:\n {2}([0-9a-f ]{49})\n/);
  expect(shown).toBe(claim.fingerprint);
  run.child.stdin?.write('yes\n');
  await run.waitFor(/Waiting for approval/);
  const agentId = await agentOperations.approveEnrollment(person.ctx, {
    claim,
    comparedFingerprint: claim.fingerprint,
    name,
    picks,
  });
  run.child.stdin?.end();
  const result = await run.done;
  expect(result.code, result.stderr).toBe(0);
  return { agentId, name, fingerprint: claim.fingerprint, result };
}

/** A stand-in for libsecret's `secret-tool`, keeping its one secret in a file. */
export async function fakeSecretTool(home: CliHome) {
  const dir = join(home.home, 'secret-tool');
  await mkdir(dir, { mode: 0o700 });
  const tool = join(dir, 'secret-tool');
  const kept = join(dir, 'kept');
  await writeFile(
    tool,
    `#!/bin/sh
case "$1" in
  store) cat > '${kept}' ;;
  lookup) [ -f '${kept}' ] || exit 1; cat '${kept}' ;;
  clear) rm -f '${kept}' ;;
  *) exit 2 ;;
esac
`,
  );
  await chmod(tool, 0o700);
  return { tool };
}
