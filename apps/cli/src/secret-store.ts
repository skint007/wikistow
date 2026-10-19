// The OS secret store for unattended unlocking (wikistow.md, gate L359):
// the Secret Service on Linux, through libsecret's `secret-tool`; the login
// Keychain on macOS, through `/usr/bin/security`; Credential Manager on
// Windows, through Windows PowerShell. It is used only once configured, and
// fails closed: a store that has gone, or answers nothing, leaves the key
// file locked rather than falling back to anything weaker.
import { fromBase64, toBase64 } from '@wikistow/client';
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import { CliError } from './exit.ts';
import { WINDOWS } from './files.ts';

/** Where the unlock secret is kept: one entry per agent. */
export interface SecretStore {
  /** The secret, or null when the store has no such entry. Throws when the store can't be reached. */
  lookup(account: string): Uint8Array | null;
  store(account: string, secret: Uint8Array): void;
  clear(account: string): void;
}

/** Each system's store, and its name as `agent status` shows it. */
export const STORE_NAMES = {
  'secret-service': 'Secret Service',
  keychain: 'macOS Keychain',
  'credential-manager': 'Windows Credential Manager',
};

/** The store this system has. */
export const SYSTEM_STORE: keyof typeof STORE_NAMES =
  process.platform === 'darwin' ? 'keychain' : WINDOWS ? 'credential-manager' : 'secret-service';

const DEFAULT_SECRET_TOOL = '/usr/bin/secret-tool';
const SECURITY = '/usr/bin/security';
const SERVICE = 'wikistow';

/** The Windows folder, which only an administrator can write to. */
function systemRoot(env: Readonly<Record<string, string | undefined>>): string {
  const root = env.SystemRoot;
  if (!root || !win32.isAbsolute(root)) {
    throw new CliError(
      'secret-store-missing',
      `SystemRoot isn’t set, so Windows PowerShell can’t be found. ${REMEDIES}`,
    );
  }
  return root;
}

/** Windows PowerShell 5.1 in the Windows folder: never one found on PATH. */
const windowsPowerShell = (root: string) =>
  win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** The program this system's store runs, unless `--secret-tool` names another secret-tool. */
export function systemTool(env: Readonly<Record<string, string | undefined>>): string {
  switch (SYSTEM_STORE) {
    case 'keychain':
      return SECURITY;
    case 'credential-manager':
      return windowsPowerShell(systemRoot(env));
    case 'secret-service':
      return DEFAULT_SECRET_TOOL;
  }
}

/** This system's store, through `tool`. */
export function systemStore(
  tool: string,
  env: Readonly<Record<string, string | undefined>>,
): SecretStore {
  switch (SYSTEM_STORE) {
    case 'keychain':
      return new KeychainStore(tool);
    case 'credential-manager':
      return new CredentialStore(tool, env);
    case 'secret-service':
      return new SecretToolStore(tool, env);
  }
}

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
export const REMEDIES = {
  'secret-service':
    'Pass --use-passphrase to type the passphrase instead; or install secret-tool ' +
    '(libsecret-tools on Debian and Ubuntu, libsecret elsewhere), or give its path with ' +
    '--secret-tool PATH, and make sure the desktop keyring is unlocked',
  keychain:
    'Pass --use-passphrase to type the passphrase instead; or run it in a session ' +
    'on the Mac’s desktop, such as Terminal, with the login keychain unlocked. Over SSH ' +
    'the login keychain stays locked until security unlock-keychain unlocks it',
  'credential-manager':
    'Pass --use-passphrase to type the passphrase instead; or run it as the Windows ' +
    'user who turned the store on, and check Credential Manager still lists the agent ' +
    'under Web Credentials (wikistow)',
}[SYSTEM_STORE];

/** How to remove an agent's unlock secret from this system's store by hand. */
export function clearByHand(account: string): string {
  switch (SYSTEM_STORE) {
    case 'keychain':
      return `with: security delete-generic-password -s ${SERVICE} -a ${account}`;
    case 'credential-manager':
      return `in Credential Manager, under Web Credentials: ${SERVICE}, ${account}`;
    case 'secret-service':
      return `with: secret-tool clear service ${SERVICE} account ${account}`;
  }
}

/**
 * Run a store's `tool`, with `input` on its standard input. Its errors are
 * ignored: they never say more than its exit status.
 */
function runTool(
  tool: string,
  args: string[],
  env: Record<string, string>,
  input = '',
): { status: number | null; stdout: string } {
  const result = spawnSync(tool, args, {
    input,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
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

/** The secret a store printed, or null when it printed none. */
function secretOf(status: number | null, stdout: string): Uint8Array | null {
  if (status !== 0 || stdout.trim() === '') return null;
  try {
    return fromBase64(stdout.trim());
  } catch {
    return null;
  }
}

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
    return runTool(this.tool, args, this.#env, input);
  }

  lookup(account: string): Uint8Array | null {
    // secret-tool exits 1, with nothing on its output, both for no entry
    // and for a store it can't reach. Either way the CLI stays locked.
    const { status, stdout } = this.#run(['lookup', 'service', SERVICE, 'account', account]);
    return secretOf(status, stdout);
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

/**
 * The login Keychain, through macOS's own `security`, which System
 * Integrity Protection keeps as Apple shipped it. The secret goes in
 * through `security -i`, which reads the command from standard input: as an
 * argument, `-w` would show it to anyone listing processes. Over SSH the
 * login keychain is locked, and `security` fails at once rather than ask.
 */
export class KeychainStore implements SecretStore {
  readonly tool: string;

  constructor(tool: string) {
    this.tool = tool;
  }

  #run(args: string[], input = ''): { status: number | null; stdout: string } {
    requireTrustedTool(this.tool);
    return runTool(this.tool, args, { LANG: 'C' }, input);
  }

  lookup(account: string): Uint8Array | null {
    const { status, stdout } = this.#run([
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      account,
      '-w',
    ]);
    return secretOf(status, stdout);
  }

  store(account: string, secret: Uint8Array): void {
    // Account IDs and base64url need no quoting.
    const { status } = this.#run(
      ['-i'],
      `add-generic-password -U -s ${SERVICE} -a ${account} -l "WikiStow agent key file" -w ${toBase64(secret)}\n`,
    );
    if (status !== 0) {
      throw new CliError(
        'secret-store-missing',
        `The login keychain refused to keep the secret. ${REMEDIES}`,
      );
    }
  }

  clear(account: string): void {
    const { status } = this.#run(['delete-generic-password', '-s', SERVICE, '-a', account]);
    // 44: no such entry, so nothing is left to remove.
    if (status !== 0 && status !== 44) {
      throw new CliError('secret-store-missing', 'The login keychain refused to remove the secret');
    }
  }
}

/**
 * Credential Manager's Web Credentials, through Windows PowerShell and
 * WinRT's PasswordVault, which needs nothing compiled (about 0.3 s a run).
 * The script is the command line, and names the account; the secret
 * crosses standard input and output only. PowerShell gets only SystemRoot
 * from the environment, which is all it needs.
 */
export class CredentialStore implements SecretStore {
  readonly tool: string;
  readonly #env: Record<string, string>;

  constructor(tool: string, env: Readonly<Record<string, string | undefined>>) {
    const root = systemRoot(env);
    const system = windowsPowerShell(root);
    if (tool.toLowerCase() !== system.toLowerCase()) {
      throw new CliError(
        'secret-store-missing',
        `Refusing to run ${tool}: the secret store runs only ${system}`,
      );
    }
    this.tool = system;
    this.#env = { SystemRoot: root };
  }

  #run(script: string, input = ''): { status: number | null; stdout: string } {
    const vault = `$ErrorActionPreference = 'Stop'
$null = [Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
`;
    const command = Buffer.from(vault + script, 'utf16le').toString('base64');
    return runTool(
      this.tool,
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', command],
      this.#env,
      input,
    );
  }

  lookup(account: string): Uint8Array | null {
    // Retrieve throws, so PowerShell exits 1, when there is no such entry.
    const { status, stdout } = this.#run(
      `$c = $vault.Retrieve('${SERVICE}', '${account}')
$c.RetrievePassword()
[Console]::Out.Write($c.Password)`,
    );
    return secretOf(status, stdout);
  }

  store(account: string, secret: Uint8Array): void {
    const { status } = this.#run(
      `$vault.Add((New-Object Windows.Security.Credentials.PasswordCredential('${SERVICE}', '${account}', [Console]::In.ReadToEnd())))`,
      toBase64(secret),
    );
    if (status !== 0) {
      throw new CliError(
        'secret-store-missing',
        `Credential Manager refused to keep the secret. ${REMEDIES}`,
      );
    }
  }

  clear(account: string): void {
    // RetrieveAll, unlike Retrieve, gives nothing rather than throwing when there is no entry.
    const { status } = this.#run(
      `$vault.RetrieveAll() | Where-Object { $_.Resource -eq '${SERVICE}' -and $_.UserName -eq '${account}' } | ForEach-Object { $vault.Remove($_) }`,
    );
    if (status !== 0) {
      throw new CliError('secret-store-missing', 'Credential Manager refused to remove the secret');
    }
  }
}
