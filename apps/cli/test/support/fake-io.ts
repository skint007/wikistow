// An `Io` in memory, and a private directory for one test's files.
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../../src/io.ts';

export function fakeIo({
  env = {},
  isTTY = false,
}: {
  env?: Record<string, string>;
  isTTY?: boolean;
} = {}) {
  const written = { stdout: '', stderr: '' };
  const asked: string[] = [];
  const io: Io = {
    stdout: { write: (text) => void (written.stdout += text), isTTY },
    stderr: { write: (text) => void (written.stderr += text) },
    writeStdout: async (bytes) => void (written.stdout += new TextDecoder().decode(bytes)),
    env: { LANG: 'C.UTF-8', ...env },
    readStdin: async () => new Uint8Array(),
    readLine: async () => null,
    readFd: () => {
      throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
    },
    isTerminal: () => false,
    // There is no terminal to ask on.
    askSecret: async (prompt) => {
      asked.push(prompt);
      return null;
    },
    sleep: async () => {},
    now: () => new Date(),
  };
  return { io, written, asked };
}

/** A fresh `~/.config/wikistow`, mode 700, as enrollment makes it. */
export async function privateDir() {
  const home = await mkdtemp(join(tmpdir(), 'wikistow-unit-'));
  const dir = join(home, '.config', 'wikistow');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { home, dir };
}
