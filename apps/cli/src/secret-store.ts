// An OS secret store for unattended unlocking (wikistow.md, gate L359): the
// Secret Service, through libsecret's `secret-tool`. It is used only once
// configured, and fails closed: a store that has gone, or answers nothing,
// leaves the key file locked rather than falling back to anything weaker.
import { fromBase64, toBase64 } from '@wikistow/client';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliError } from './exit.ts';

/** Where the unlock secret is kept: one entry per agent. */
export interface SecretStore {
  /** The secret, or null when the store has no such entry. Throws when the store can't be reached. */
  lookup(account: string): Uint8Array | null;
  store(account: string, secret: Uint8Array): void;
  clear(account: string): void;
}

export const DEFAULT_SECRET_TOOL = '/usr/bin/secret-tool';

/**
 * Refuse to run `tool` unless only root could have put it there. The key
 * file names the tool, and it runs before anything in the file can be
 * checked, so a tool someone else could write would run as this user. The
 * tool as named, where it leads, and every directory above either must be
 * root's and writable by nobody else, as OpenSSH's StrictModes asks of the
 * files it trusts. A build for the CLI's own tests may trust any tool; the
 * build that ships pins that off (`vite.config.ts`).
 */
export function requireTrustedTool(tool: string): void {
  if (import.meta.env?.WIKISTOW_TEST_TRUST_ANY_SECRET_TOOL === 'yes') return;
  let real: string;
  try {
    real = realpathSync(tool);
  } catch (cause) {
    throw new CliError('secret-store-missing', `${tool} is not there. ${REMEDIES}`, { cause });
  }
  const above = (path: string) => {
    const dirs: string[] = [];
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      dirs.push(dir);
      if (dir === dirname(dir)) return dirs;
    }
  };
  for (const path of new Set([...above(tool), tool, ...above(real), real])) {
    const stats = lstatSync(path);
    const writable = !stats.isSymbolicLink() && (stats.mode & 0o022) !== 0;
    if (stats.uid !== 0 || writable) {
      throw new CliError(
        'secret-store-missing',
        `Refusing to run ${tool}: ${path} is ${writable ? 'writable by others' : 'not root’s'}. ` +
          'Give --secret-tool a secret-tool that root installed',
      );
    }
  }
  if (!statSync(real).isFile()) {
    throw new CliError('secret-store-missing', `Refusing to run ${tool}: it is not a file`);
  }
}

/** What to do when the secret store can't unlock the agent. */
export const REMEDIES =
  'Pass --use-passphrase to type the passphrase instead; or install secret-tool ' +
  '(libsecret-tools on Debian and Ubuntu, libsecret elsewhere), or give its path with ' +
  '--secret-tool PATH, and make sure the desktop keyring is unlocked';

const SERVICE = 'wikistow';

/**
 * The Secret Service, through `tool`. The secret only ever crosses its
 * standard input and output, never its arguments or environment. The tool
 * gets a bare environment: the session bus, and `SECRET_BACKEND=service`,
 * so libsecret can't pick its file backend instead.
 */
export class SecretToolStore implements SecretStore {
  readonly tool: string;
  readonly #env: Record<string, string>;

  constructor(tool: string, env: Readonly<Record<string, string | undefined>>) {
    if (!tool.startsWith('/')) throw new CliError('usage', 'Give secret-tool as an absolute path');
    this.tool = tool;
    this.#env = { SECRET_BACKEND: 'service', LANG: 'C' };
    for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'HOME'] as const) {
      const value = env[name];
      if (value !== undefined) this.#env[name] = value;
    }
  }

  #run(args: string[], input = ''): { status: number | null; stdout: string } {
    requireTrustedTool(this.tool);
    const result = spawnSync(this.tool, args, {
      input,
      env: this.#env,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      throw new CliError(
        'secret-store-missing',
        timedOut
          ? `The secret store didn’t answer in 30 seconds: its keyring may be locked. ${REMEDIES}`
          : `The secret store can’t be reached. ${REMEDIES}`,
        { cause: result.error },
      );
    }
    return { status: result.status, stdout: result.stdout };
  }

  lookup(account: string): Uint8Array | null {
    const { status, stdout } = this.#run(['lookup', 'service', SERVICE, 'account', account]);
    // secret-tool exits 1, with nothing on its output, both for no entry
    // and for a store it can't reach. Either way the CLI stays locked.
    if (status !== 0 || stdout.trim() === '') return null;
    try {
      return fromBase64(stdout.trim());
    } catch {
      return null;
    }
  }

  store(account: string, secret: Uint8Array): void {
    const { status } = this.#run(
      ['store', '--label=WikiStow agent key file', 'service', SERVICE, 'account', account],
      toBase64(secret),
    );
    if (status !== 0) {
      throw new CliError(
        'secret-store-missing',
        'The secret store refused to keep the secret: check its keyring is unlocked',
      );
    }
  }

  clear(account: string): void {
    const { status } = this.#run(['clear', 'service', SERVICE, 'account', account]);
    if (status !== 0) {
      throw new CliError('secret-store-missing', 'The secret store refused to remove the secret');
    }
  }
}
