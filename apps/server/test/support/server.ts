import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vite-plus/test';

type Line = { level: string; event: string } & Record<string, unknown>;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * The real server, src/main.ts, started in a process of its own on
 * `databaseUrl` and `blobDir`, as the container starts it.
 * It applies pending migrations itself, and sends no mail. Call it in a test:
 * it is stopped when the test ends, if it still runs.
 */
export async function startServer(databaseUrl: string, blobDir: string) {
  const main = fileURLToPath(new URL('../../src/main.ts', import.meta.url));
  const child = spawn(process.execPath, [main], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      DATABASE_URL: databaseUrl,
      BLOB_DIR: blobDir,
      PORT: String(await freePort()),
      PUBLIC_ORIGIN: 'http://localhost',
      BETTER_AUTH_SECRET: 'test-secret-that-is-longer-than-32-characters',
      SMTP_URL: 'smtp://127.0.0.1:1',
      SMTP_FROM: 'WikiStow <test@localhost>',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const logs: Line[] = [];
  let partial = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) logs.push(JSON.parse(line) as Line);
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
  onTestFinished(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  return {
    logs,
    /** Its exit status, once it stops. */
    exited,
    /**
     * Wait until it has logged each of `events`. Starting takes seconds on
     * an idle machine and many times that on a runner shared with other
     * pipelines, so this waits up to 45 seconds.
     */
    async waitFor(...events: string[]) {
      const until = Date.now() + 45_000;
      while (!events.every((event) => logs.some((line) => line.event === event))) {
        if (child.exitCode !== null || Date.now() > until) {
          throw new Error(`never logged ${events.join(', ')}: ${JSON.stringify(logs)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    /** Stop it as Docker does, and give its exit status. */
    async stop() {
      child.kill('SIGTERM');
      return exited;
    },
  };
}
