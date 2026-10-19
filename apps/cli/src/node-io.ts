// The real terminal and streams, for `main.ts`.
import { readSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { isatty } from 'node:tty';
import { CliError } from './exit.ts';
import type { Io } from './io.ts';

const ENV_NAMES = [
  'XDG_CONFIG_HOME',
  'HOME',
  'APPDATA',
  'LC_ALL',
  'LC_CTYPE',
  'LANG',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'SystemRoot',
] as const;

export function nodeIo(): Io {
  return {
    stdout: {
      write: (text) => process.stdout.write(text),
      isTTY: process.stdout.isTTY === true,
    },
    stderr: { write: (text) => process.stderr.write(text) },
    writeStdout: (bytes) =>
      new Promise((resolve, reject) =>
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve())),
      ),
    env: Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]])),
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return new Uint8Array(Buffer.concat(chunks));
    },
    readLine,
    readFd,
    isTerminal: (fd) => isatty(fd),
    askSecret: (prompt) => askSecret(prompt),
    sleep: (ms) => delay(ms),
    now: () => new Date(),
  };
}

/**
 * One line of standard input. The reader closes after it, as an open one
 * would keep a terminal's input, and so the CLI, running once it is done.
 */
function readLine(): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = createInterface({ input: process.stdin, terminal: false });
    reader.once('line', (line) => {
      resolve(line);
      reader.close();
    });
    reader.once('close', () => resolve(null));
  });
}

/**
 * All of file descriptor `fd`, to its end. A pipe may be non-blocking and
 * empty for now, so `EAGAIN` waits a little and reads again, for up to a
 * minute.
 */
export function readFd(fd: number): Uint8Array {
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(4096);
  const until = Date.now() + 60_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let read: number;
    try {
      read = readSync(fd, buffer);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' || Date.now() > until) throw error;
      Atomics.wait(pause, 0, 0, 10);
      continue;
    }
    if (read === 0) return new Uint8Array(Buffer.concat(chunks));
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
}

/**
 * Ask on the terminal with echo off: raw mode, so nothing typed is shown.
 * Null when standard input isn't a terminal: then there is nobody to ask.
 */
export function askSecret(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stderr,
): Promise<string | null> {
  if (!input.isTTY) return Promise.resolve(null);
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  let typed = '';
  return new Promise<string | null>((resolve, reject) => {
    const done = (error?: CliError) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      output.write('\n');
      if (error) reject(error);
      else resolve(typed);
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003' || char === '\u0004') {
          return done(new CliError('cancelled', 'Cancelled'));
        }
        if (char === '\u007f' || char === '\b') typed = typed.replace(/[\s\S]$/u, '');
        else typed += char;
      }
    };
    input.on('data', onData);
  });
}
