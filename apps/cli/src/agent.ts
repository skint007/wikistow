// Opening the agent for a command: unlock the key file, load the local
// state, and open the agent's session with its person (protocol section 9.3).
import {
  agentContactsMark,
  createApiClient,
  CryptoError,
  openAgentSession,
  restoreNotice,
  saveContacts,
  unseenRestore,
  type ClientContext,
  type Fetch,
} from '@wikistow/client';
import { systemRoutes } from '@wikistow/contracts';
import { join } from 'node:path';
import { CliError } from './exit.ts';
import { configDir, readPrivateFile, WINDOWS } from './files.ts';
import type { Io } from './io.ts';
import { Journal } from './journal.ts';
import { openKeyFile, parseKeyFile, type KeyFile, type Secrets, type Unlock } from './keyfile.ts';
import { REMEDIES, systemStore, type SecretStore } from './secret-store.ts';
import { LocalState } from './state.ts';

export const KEY_FILE = 'agent.key';
export const STATE_FILE = 'state';

/** How a command may be unlocked, from its options. */
export type UnlockOptions = {
  /** Read the passphrase from this inherited file descriptor. */
  passphraseFd?: number | undefined;
  /** Ask for the passphrase even though a secret store is configured. */
  usePassphrase?: boolean | undefined;
};

/** Makes the secret store a key file names. Tests pass their own. */
export type StoreFactory = (tool: string, io: Io) => SecretStore;
export const systemSecretStore: StoreFactory = (tool, io) => systemStore(tool, io.env);

/**
 * The `fetch` the CLI sends with: no cookie, no Origin (a bearer request
 * with either is refused, section 9.6), and no redirects, so the token
 * never follows one to another host.
 */
export const cliFetch: Fetch = (url, init) => globalThis.fetch(url, { ...init, redirect: 'error' });

/** A passphrase from an inherited file descriptor: its whole content, less one line end. */
export function passphraseFromFd(io: Io, fd: number): string {
  // A terminal would show it as it is typed, and keep it in its scrollback.
  if (io.isTerminal(fd)) {
    throw new CliError(
      'usage',
      `File descriptor ${fd} is a terminal, which would show the passphrase; ` +
        'leave out --passphrase-fd to be asked for it with echo off',
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = io.readFd(fd);
  } catch (cause) {
    throw new CliError('usage', `Can't read a passphrase from file descriptor ${fd}`, { cause });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new CliError('usage', 'The passphrase is not UTF-8', { cause });
  }
  return text.replace(/\r?\n$/, '');
}

export function readKeyFile(io: Io): { dir: string; file: KeyFile } {
  const dir = configDir(io.env);
  const bytes = readPrivateFile(join(dir, KEY_FILE));
  if (!bytes) {
    throw new CliError('not-enrolled', 'This CLI is not enrolled; run `wikistow agent enroll`');
  }
  return { dir, file: parseKeyFile(bytes) };
}

/**
 * The secret that opens `file`: from `--passphrase-fd`; else from the
 * configured secret store, which fails closed when it can't give one; else
 * asked for on the terminal with echo off. Never from arguments or the
 * environment.
 */
export async function unlockSecret(
  io: Io,
  file: KeyFile,
  options: UnlockOptions,
  makeStore: StoreFactory,
): Promise<Unlock> {
  if (options.passphraseFd !== undefined) {
    return { kind: 'passphrase', passphrase: passphraseFromFd(io, options.passphraseFd) };
  }
  if (file.secretStore && !options.usePassphrase) {
    const secret = makeStore(file.secretStore.tool, io).lookup(file.secretStore.account);
    if (!secret) {
      throw new CliError(
        'secret-store-missing',
        `The configured secret store gave no unlock secret for this agent. ${REMEDIES}`,
      );
    }
    return { kind: 'secret-store', secret };
  }
  const passphrase = await io.askSecret('Passphrase for the WikiStow agent key file: ');
  if (passphrase === null) {
    throw new CliError(
      'locked',
      `No terminal to ask for the passphrase; pass --passphrase-fd${WINDOWS ? ' 0' : ''} ` +
        'or configure a secret store',
    );
  }
  return { kind: 'passphrase', passphrase };
}

export type OpenedAgent = {
  dir: string;
  file: KeyFile;
  secrets: Secrets;
  dataKey: Uint8Array;
  state: LocalState;
  journal: Journal;
  ctx: ClientContext;
};

/** A time as the CLI prints it, in UTC to the minute: `2026-10-15 09:30 UTC`. */
const utcMinute = (iso: string) =>
  `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Unlock and open the agent's session. Its first-seen pins, marks and
 * contacts mark come from the local state, and `finish` keeps what the
 * session changed for the next run. After a restore of the server it
 * hasn't seen, it says so on standard error and starts over from what the
 * server serves now (`unseenRestore`).
 */
export async function openAgent(
  io: Io,
  {
    unlock,
    idempotencyKey = null,
    input,
    makeStore = systemSecretStore,
    send = cliFetch,
  }: {
    unlock: UnlockOptions;
    idempotencyKey?: string | null;
    /** What a change command was asked to do, for the journal (`inputHash`). */
    input?: string;
    makeStore?: StoreFactory;
    send?: Fetch;
  },
): Promise<OpenedAgent> {
  const { dir, file } = readKeyFile(io);
  const { secrets, dataKey } = openKeyFile(file, await unlockSecret(io, file, unlock, makeStore));
  const state = LocalState.open(join(dir, STATE_FILE), secrets.stateKey, file.agentId);
  const journal = new Journal({
    dir,
    agentId: file.agentId,
    server: file.server,
    stateKey: secrets.stateKey,
    key: idempotencyKey,
    ...(input === undefined ? {} : { input }),
    now: () => io.now(),
  });
  const api = createApiClient({
    baseUrl: file.server,
    fetch: journal.fetch(send),
    token: secrets.token,
  });
  const { restore } = await api.call(systemRoutes.installation);
  const unseen = unseenRestore(restore, state.restoredAt);
  if (unseen) {
    state.startOver(unseen.restoredAt);
    io.stderr.write(`${restoreNotice(unseen, utcMinute)}\n`);
  }
  const ctx = await openAgentSession(api, {
    identity: secrets.identity,
    person: secrets.person,
    mark: state.contactsMark,
    marks: state,
    pins: state,
  }).catch((error: unknown) => {
    // A person's app stops sealing their record to an agent it revoked. The
    // server could withhold it too, but either way this agent must stop.
    if (error instanceof CryptoError && error.code === 'wrong-recipient') {
      throw new CliError(
        'not-in-record',
        'Its person’s contacts record no longer includes this agent: most likely they revoked it',
        { cause: error },
      );
    }
    throw error;
  });
  if (ctx.installationId !== secrets.installationId) {
    throw new CryptoError('binding-mismatch', 'The server is another installation');
  }
  state.keepContactsMark(agentContactsMark(ctx));
  return { dir, file, secrets, dataKey, state, journal, ctx };
}

/** Keep the session's first-seen pins and contacts mark for the next run. */
export async function finish({ ctx, state }: Pick<OpenedAgent, 'ctx' | 'state'>): Promise<void> {
  await saveContacts(ctx);
  state.keepContactsMark(agentContactsMark(ctx));
}
