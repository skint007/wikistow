import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Run one of scripts/*.sh against `target`'s database and blob directory, as
 * an operator would, with `env` added to this process's environment. Aborting
 * `signal` sends it SIGTERM. The scripts need pg_dump, pg_restore and psql 17
 * on PATH.
 */
export async function script(
  name: string,
  target: { config: { databaseUrl: string }; blobDir: string },
  args: string[],
  { env = {}, signal }: { env?: Record<string, string>; signal?: AbortSignal } = {},
) {
  const path = fileURLToPath(new URL(`../../../../scripts/${name}`, import.meta.url));
  const { stdout } = await promisify(execFile)('sh', [path, ...args], {
    signal,
    env: {
      ...process.env,
      DATABASE_URL: target.config.databaseUrl,
      BLOB_DIR: target.blobDir,
      ...env,
    },
  });
  return stdout.trim();
}
