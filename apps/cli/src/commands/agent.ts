// `wikistow agent enroll|status|secret-store`: the agent itself.
import {
  agentContactsMark,
  agentEnrollment,
  createApiClient,
  MemoryAgentPins,
  MemoryKeyVersionMarks,
  openAgentSession,
  type ClientContext,
  type Fetch,
} from '@wikistow/client';
import { systemRoutes } from '@wikistow/contracts';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  finish,
  KEY_FILE,
  openAgent,
  passphraseFromFd,
  readKeyFile,
  STATE_FILE,
  unlockSecret,
  type StoreFactory,
  type UnlockOptions,
} from '../agent.ts';
import { classify, CliError, EXIT } from '../exit.ts';
import { configDir, ensurePrivateDir, writePrivateFile } from '../files.ts';
import type { Io, Printer } from '../io.ts';
import { JOURNAL_DIR } from '../journal.ts';
import {
  checkNewPassphrase,
  createKeyFile,
  keyFileBytes,
  openKeyFile,
  withoutSecretStore,
  withSecretStore,
  type KeyFile,
} from '../keyfile.ts';
import { LocalState } from '../state.ts';

export type Deps = { makeStore: StoreFactory; send: Fetch; pollMs: number };

/**
 * The server's origin. Plain HTTP only to this machine: a bearer token and
 * the enrollment must not cross a network in the clear.
 */
export function serverOrigin(server: string): string {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new CliError('usage', 'Give --server as a URL, such as https://wiki.example');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new CliError('usage', 'The server must use https (plain http only on this machine)');
  }
  return url.origin;
}

/**
 * A new passphrase: from `--passphrase-fd`, or typed twice on the terminal.
 * Checked here, before enrolling, since the token comes only once.
 */
async function newPassphrase(io: Io, unlock: UnlockOptions): Promise<string> {
  if (unlock.passphraseFd !== undefined) {
    const passphrase = passphraseFromFd(io, unlock.passphraseFd);
    checkNewPassphrase(passphrase);
    return passphrase;
  }
  const first = await io.askSecret('New passphrase for the agent key file: ');
  if (first === null) {
    throw new CliError('locked', 'No terminal to ask for a passphrase; pass --passphrase-fd');
  }
  checkNewPassphrase(first);
  const again = await io.askSecret('The same passphrase again: ');
  if (again !== first) throw new CliError('usage', 'The passphrases differ');
  return first;
}

/** Who this agent is, from its own entry in its person's record. */
function whoami(ctx: ClientContext, file: KeyFile) {
  const entry = ctx.agent?.entry;
  return {
    agentId: file.agentId,
    server: file.server,
    name: entry?.label.name ?? null,
    enrolledAt: entry?.label.enrolledAt ?? null,
    person: ctx.agent?.person.id ?? null,
    shares: (entry?.shares ?? []).map(({ spaceId, shareId, drafts }) => ({
      spaceId,
      shareId,
      drafts,
    })),
    secretStore: file.secretStore === null ? null : { tool: file.secretStore.tool },
  };
}

function printWhoami(out: Printer, who: ReturnType<typeof whoami>) {
  out.result(who, () => {
    out.line(`Agent ${who.agentId}`);
    out.line(`  name: ${out.foreign(who.name ?? '(none)')}`);
    out.line(`  enrolled: ${out.foreign(who.enrolledAt ?? '(unknown)')}`);
    out.line(`  for person: ${who.person ?? '(unknown)'}`);
    out.line(`  server: ${out.foreign(who.server)}`);
    out.line(`  unlocks with: ${who.secretStore ? 'secret store' : 'passphrase'}`);
    for (const share of who.shares) {
      out.line(
        `  share ${share.shareId} in space ${share.spaceId}${share.drafts ? ' (drafts)' : ''}`,
      );
    }
  });
}

/** Configure the secret store: keep a fresh unlock secret there, and check it reads back. */
function addSecretStore(
  io: Io,
  file: KeyFile,
  dataKey: Uint8Array,
  tool: string,
  makeStore: StoreFactory,
): KeyFile {
  const store = makeStore(tool, io);
  const secret = randomBytes(32);
  store.store(file.agentId, secret);
  const back = store.lookup(file.agentId);
  if (!back || Buffer.compare(Buffer.from(back), secret) !== 0) {
    throw new CliError(
      'secret-store-missing',
      'The secret store did not give the secret back: check its keyring is unlocked',
    );
  }
  return withSecretStore(
    file,
    dataKey,
    { tool, service: 'wikistow', account: file.agentId },
    secret,
  );
}

/**
 * Enroll (protocol section 9.2): fresh keys, a lookup code for the person,
 * the fingerprint both sides compare, then the token, once. Server text is
 * printed ASCII-only, and the fingerprint last, computed here.
 */
export async function enroll(
  io: Io,
  out: Printer,
  {
    server,
    unlock,
    secretTool,
    answerFromStdin,
  }: {
    server: string;
    unlock: UnlockOptions;
    secretTool: string | null;
    /** Take the fingerprint's yes from a standard input that isn't a terminal. */
    answerFromStdin: boolean;
  },
  deps: Deps,
): Promise<void> {
  const origin = serverOrigin(server);
  const dir = configDir(io.env);
  ensurePrivateDir(dir);
  // Another agent's files would refuse this one's, after the token it gets
  // only once. Its journal can't be resent as this agent either.
  const left = [KEY_FILE, STATE_FILE, JOURNAL_DIR].filter((name) => existsSync(join(dir, name)));
  if (left.length > 0) {
    throw new CliError(
      'usage',
      `This CLI is already enrolled (${dir} holds ${left.join(', ')}); ` +
        `to enroll again, move the whole directory away, for example mv "${dir}" "${dir}.old"`,
    );
  }
  const passphrase = await newPassphrase(io, unlock);
  // Only a person who compared the fingerprints may say yes; a program
  // piping into the CLI could say it without looking.
  if (!answerFromStdin && !io.isTerminal(0)) {
    throw new CliError(
      'usage',
      'Standard input is not a terminal, so nobody may be there to compare the fingerprint. ' +
        'Run this in a terminal, or give --fingerprint-answer-from-stdin if a person ' +
        'compares it and types the answer into standard input',
    );
  }
  const api = createApiClient({ baseUrl: origin, fetch: deps.send });
  // A restore from before this agent existed is nothing to tell it about.
  const { restore } = await api.call(systemRoutes.installation);
  const pending = await agentEnrollment.requestEnrollment(api, () => io.now());
  const cancel = () => agentEnrollment.cancelEnrollment(api, pending).catch(() => {});
  out.note(`Lookup code: ${pending.requested.lookupCode}`);
  out.note('Enter it under Agents in WikiStow, signed in and unlocked. Waiting…');

  const poll = async (waiting: readonly string[]) => {
    for (;;) {
      const polled = await agentEnrollment.pollEnrollment(api, pending, () => io.now());
      if (!waiting.includes(polled.state)) return polled;
      await io.sleep(deps.pollMs);
    }
  };
  const claimed = await poll(['requested']);
  if (claimed.state !== 'claimed') {
    throw new CliError(
      'expired',
      `The enrollment ended before anyone claimed it (${claimed.state})`,
    );
  }
  const { claimer } = claimed;
  // Section 9.3: the claimer's name and email are the server's word, printed
  // ASCII-only, and before the fingerprint.
  out.note(
    `Claimed by ${out.ascii(claimer.name)} <${out.ascii(claimer.email)}>, as the server says.`,
  );
  out.note('');
  out.note('Enrollment fingerprint:');
  out.note(`  ${claimer.fingerprint}`);
  out.note('');
  out.note(`Does your browser show exactly ${claimer.fingerprint}? Type yes to continue:`);
  const answer = await io.readLine();
  if (answer?.trim() !== 'yes') {
    await cancel();
    throw new CliError('cancelled', 'Enrollment cancelled; nothing was enrolled');
  }
  await agentEnrollment.confirmEnrollment(api, pending, claimer);
  out.note('Confirmed. Waiting for approval…');
  const approved = await poll(['claimed', 'cli-confirmed']);
  if (approved.state !== 'approved') {
    throw new CliError('expired', `The enrollment ended without approval (${approved.state})`);
  }
  const { token, identity } = agentEnrollment.openDeliveredToken(pending, claimer.person, approved);

  // Pin the person only once its enrollment of this agent checks out under
  // their key: opening the session verifies it (section 9.3).
  const agentApi = createApiClient({ baseUrl: origin, fetch: deps.send, token });
  const ctx = await openAgentSession(agentApi, {
    identity,
    person: claimer.person,
    marks: new MemoryKeyVersionMarks(),
    pins: new MemoryAgentPins(),
  });
  const stateKey = randomBytes(32);
  let file = createKeyFile({
    server: origin,
    passphrase,
    secrets: {
      installationId: ctx.installationId,
      identity,
      person: claimer.person,
      token,
      stateKey,
    },
  });
  // The token came once: keep it, opened by the passphrase, before anything else can fail.
  writePrivateFile(join(dir, KEY_FILE), keyFileBytes(file));
  const state = LocalState.create(
    join(dir, STATE_FILE),
    stateKey,
    file.agentId,
    restore?.restoredAt ?? null,
  );
  state.keepContactsMark(agentContactsMark(ctx));
  if (secretTool !== null) {
    const { dataKey } = openKeyFile(file, { kind: 'passphrase', passphrase });
    try {
      file = addSecretStore(io, file, dataKey, secretTool, deps.makeStore);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      throw new CliError(
        error.code,
        `Enrolled, and the passphrase unlocks it, but the secret store failed: ${error.message}`,
      );
    }
    writePrivateFile(join(dir, KEY_FILE), keyFileBytes(file));
  }
  printWhoami(out, whoami(ctx, file));
}

/** `agent status`: who this agent is, checked with the server. */
export async function status(
  io: Io,
  out: Printer,
  { unlock }: { unlock: UnlockOptions },
  deps: Deps,
): Promise<void> {
  const agent = await openAgent(io, { unlock, makeStore: deps.makeStore, send: deps.send });
  await finish(agent);
  printWhoami(out, whoami(agent.ctx, agent.file));
}

/**
 * `agent secret-store enable|disable`. Enabling needs the passphrase, so
 * the store only ever adds a way in that the person chose.
 */
export async function secretStore(
  io: Io,
  out: Printer,
  {
    action,
    unlock,
    secretTool,
  }: { action: 'enable' | 'disable'; unlock: UnlockOptions; secretTool: string },
  deps: Deps,
): Promise<void> {
  const { dir, file } = readKeyFile(io);
  const secret = await unlockSecret(
    io,
    file,
    action === 'enable' ? { ...unlock, usePassphrase: true } : unlock,
    deps.makeStore,
  );
  const { dataKey } = openKeyFile(file, secret);
  const next =
    action === 'enable'
      ? addSecretStore(io, file, dataKey, secretTool, deps.makeStore)
      : withoutSecretStore(file);
  writePrivateFile(join(dir, KEY_FILE), keyFileBytes(next));
  // Only once the key file no longer names it, so a failure never strands
  // the agent. Left in the store, the secret still opens any copy of the
  // key file made before: say so, and how to remove it.
  if (action === 'disable' && file.secretStore) {
    try {
      deps.makeStore(file.secretStore.tool, io).clear(file.agentId);
    } catch (error) {
      out.warn({
        exit: EXIT.failed,
        code: 'secret-not-cleared',
        message:
          'The key file no longer uses the secret store, but its unlock secret is still ' +
          'there, and opens any older copy of the key file. Remove it with: secret-tool ' +
          `clear service wikistow account ${file.agentId}`,
        reason: classify(error).message,
      });
    }
  }
  out.result({ agentId: file.agentId, secretStore: action === 'enable' }, () =>
    out.line(
      action === 'enable'
        ? 'The secret store now unlocks this agent'
        : 'Only the passphrase unlocks this agent now',
    ),
  );
}
