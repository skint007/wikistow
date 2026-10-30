// What the CLI reads and writes besides its own files: the terminal, the
// standard streams and a few environment values. Tests pass their own.
import { forTerminal, isUtf8Locale, toAsciiJson } from '@wikistow/client';
import type { Failure } from './exit.ts';
import { WINDOWS } from './files.ts';

export interface Io {
  readonly stdout: { write(text: string): void; readonly isTTY: boolean };
  /** Bytes to standard output as they are: a downloaded file. */
  writeStdout(bytes: Uint8Array): Promise<void>;
  readonly stderr: { write(text: string): void };
  /**
   * Only where to look and how to print: `XDG_CONFIG_HOME`, `HOME`,
   * `APPDATA` and the locale. The CLI never takes a secret from the environment.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** All of standard input, for `--file -`. */
  readStdin(): Promise<Uint8Array>;
  /** One line of standard input, without its line end; null at its end. */
  readLine(): Promise<string | null>;
  /** All of an inherited file descriptor, for `--passphrase-fd`. */
  readFd(fd: number): Uint8Array;
  /** Whether a file descriptor is a terminal. */
  isTerminal(fd: number): boolean;
  /** Ask on the terminal without echoing, or null when there is no terminal to ask on. */
  askSecret(prompt: string): Promise<string | null>;
  /** Wait between polls. */
  sleep(ms: number): Promise<void>;
  now(): Date;
  /**
   * A signal aborted by the first SIGINT or SIGTERM until `release`, for a
   * change that cleans up when it stops; a second one stops the CLI as usual.
   */
  stopOnSignal(): { signal: AbortSignal; release(): void };
}

/**
 * Everything the CLI prints. Text it didn't write (server text, decrypted
 * content) goes through `foreign`, and `--json` goes through `toAsciiJson`,
 * so nothing it prints can carry a terminal escape (protocol section 9.3).
 * What the user gave it, such as a path, prints as it is: escaped, every
 * backslash in a Windows path would show doubled.
 */
export class Printer {
  readonly json: boolean;
  readonly #io: Io;
  readonly #utf8: boolean;
  #warning: Failure | null = null;

  constructor(io: Io, { json }: { json: boolean }) {
    this.#io = io;
    this.json = json;
    // Windows has no locale variables, and its consoles show Unicode.
    this.#utf8 = WINDOWS || isUtf8Locale(io.env);
  }

  /** A foreign string, escaped for this terminal's encoding. */
  foreign(text: string): string {
    return forTerminal(text, { utf8: this.#utf8 });
  }

  /** A foreign string, escaped to ASCII whatever the locale: during enrollment. */
  ascii(text: string): string {
    return forTerminal(text, { utf8: false });
  }

  /** A line of human output. Pass foreign parts through `foreign` first. */
  line(text = ''): void {
    this.#io.stdout.write(`${text}\n`);
  }

  /** A line for the person at the terminal, kept off standard output. */
  note(text = ''): void {
    this.#io.stderr.write(`${text}\n`);
  }

  /**
   * Something that went wrong after the command did what it was asked:
   * reported with its result, which still stands, and its exit status.
   */
  warn(failure: Failure): void {
    this.#warning = failure;
  }

  get warning(): Failure | null {
    return this.#warning;
  }

  /** The command's result: JSON, or the human lines `human` prints. */
  result(value: Record<string, unknown>, human: () => void): void {
    const warning = this.#warning;
    if (this.json) {
      this.#io.stdout.write(toAsciiJson(warning ? { ...value, warning } : value));
      return;
    }
    human();
    if (warning) this.failure(warning);
  }

  /**
   * Decrypted content as it is, with nothing escaped, which section 9.3
   * allows only when standard output isn't a terminal. On a terminal it is
   * escaped like any other foreign text.
   */
  raw(text: string): void {
    this.#io.stdout.write(this.#io.stdout.isTTY ? this.foreign(text) : text);
  }

  failure(failure: Failure): void {
    if (this.json) {
      const { exit, code, message, outcomeUnknown, reason, detail } = failure;
      this.#io.stdout.write(
        toAsciiJson({
          error: {
            exit,
            code,
            message,
            ...(outcomeUnknown ? { outcomeUnknown } : {}),
            ...(reason ? { reason } : {}),
            ...detail,
          },
        }),
      );
      return;
    }
    // The message is the CLI's own, with any path in it as given; the reason is foreign.
    const reason = failure.reason ? ` (${this.foreign(failure.reason)})` : '';
    this.note(`wikistow: ${failure.message}${reason} [${this.foreign(failure.code)}]`);
    if (failure.detail) {
      for (const [name, value] of Object.entries(failure.detail)) {
        this.note(`  ${name}: ${this.foreign(String(value))}`);
      }
    }
  }
}
