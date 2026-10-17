import { z } from 'zod';
import type { ApiClient } from './api/client.ts';
import { AccountId, FolderId, MetadataRevisionId, SpaceId } from './ids.ts';
import { NodeMetadata, type MetadataChanges } from './metadata.ts';
import { Format } from './payload.ts';
import type { ClientContext } from './operations/session.ts';
import * as spaces from './operations/spaces.ts';
import {
  changeVaultPassphrase,
  openVault,
  prepareVault,
  registerVault,
  type PreparedVault,
  type VaultCrypto,
} from './operations/vault.ts';
import type { UnlockedVault } from './vault.ts';

/** Signed in, whether or not the vault is unlocked. */
export type AccountContext = { api: ApiClient; crypto: VaultCrypto; accountId: AccountId };

/** Signed in with the vault unlocked: everything the content operations need. */
export type VaultContext = ClientContext & { crypto: VaultCrypto; unlocked: UnlockedVault };

/**
 * What a command can ask for before it runs. A caller passes whichever it
 * has; a command that names one the caller lacks (a locked vault, say) is
 * unavailable. Other layers add their own, such as the web app's UI state,
 * by augmenting this interface.
 */
export interface CommandContexts {
  account: AccountContext;
  vault: VaultContext;
}

export type Requirement = keyof CommandContexts;

/**
 * A named user action: a stable ID, a schema for its input, what it needs
 * before it can run, and the single authorized operation it calls. Buttons,
 * menus, shortcuts, a command palette, and the CLI run commands rather than
 * calling operations directly, so a later plugin API has one seam to expose.
 */
export type Command<
  Id extends string = string,
  R extends Requirement = Requirement,
  I extends z.ZodType = z.ZodType,
  O = unknown,
> = {
  readonly id: Id;
  readonly input: I;
  readonly requires: readonly R[];
  run(contexts: Pick<CommandContexts, R>, input: z.output<I>): Promise<O>;
};

/** Any command, for code that handles them generically. */
export type AnyCommand = Command;

/** Infers a command's types from its definition. */
export const defineCommand = <
  const Id extends string,
  R extends Requirement,
  I extends z.ZodType,
  O,
>(
  command: Command<Id, R, I, O>,
): Command<Id, R, I, O> => command;

export type CommandFailure = 'unavailable' | 'invalid-input';

export class CommandError extends Error {
  readonly code: CommandFailure;

  constructor(code: CommandFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommandError';
    this.code = code;
  }
}

/**
 * Run `command` with whatever contexts the caller has. The input is checked
 * against the command's schema first, since it may come from a palette or
 * the command line rather than typed code.
 */
export async function runCommand<C extends AnyCommand>(
  command: C,
  available: Partial<CommandContexts>,
  input: z.input<C['input']>,
): Promise<Awaited<ReturnType<C['run']>>> {
  const contexts: Partial<CommandContexts> = {};
  for (const requirement of command.requires) {
    const context = available[requirement];
    if (context === undefined)
      throw new CommandError('unavailable', `${command.id} needs ${requirement}`);
    Object.assign(contexts, { [requirement]: context });
  }
  const parsed = command.input.safeParse(input);
  if (!parsed.success)
    throw new CommandError('invalid-input', `Invalid input for ${command.id}`, {
      cause: parsed.error,
    });
  // Every requirement was copied in above; the compiler can't follow the loop.
  return (await command.run(contexts as CommandContexts, parsed.data)) as Awaited<
    ReturnType<C['run']>
  >;
}

// Checked without rebuilding: Zod copies objects key by key, which would drop
// a "__proto__" key from metadata a newer client wrote. `T` is what the
// operation takes; `schema` checks the same shape.
const exactly = <T>(schema: z.ZodType) => z.custom<T>((value) => schema.safeParse(value).success);

const Passphrase = z.object({ passphrase: z.string().min(1) });

const LoadedMetadata = exactly<spaces.LoadedMetadata>(
  z.object({
    head: MetadataRevisionId,
    opened: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('current'), metadata: NodeMetadata }),
      z.object({ kind: z.literal('newer-format'), format: Format }),
    ]),
  }),
);

const Changes = exactly<MetadataChanges>(
  NodeMetadata.pick({ name: true, tint: true, extensions: true })
    .extend({ emoji: NodeMetadata.shape.emoji.unwrap().nullable() })
    .partial(),
);

// Setting up is two commands, like the operations: the recovery key is shown
// and confirmed between them, and a register that lost its answer is retried
// with the same prepared vault, so the key shown stays the one that works.
const vaultPrepare = defineCommand({
  id: 'vault.prepare',
  requires: ['account'],
  input: Passphrase,
  run: ({ account }, { passphrase }) => prepareVault({ ...account, passphrase }),
});

// A prepared vault holds key bytes and comes from vault.prepare, never typed
// input; this only checks it is one. The server checks what is sent.
const Prepared = z.custom<PreparedVault>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'recoveryKey' in value &&
    typeof value.recoveryKey === 'string' &&
    'identity' in value &&
    'wrapper' in value &&
    'vault' in value,
);

const vaultRegister = defineCommand({
  id: 'vault.register',
  requires: ['account'],
  input: z.object({ prepared: Prepared }),
  run: ({ account }, { prepared }) => registerVault(account.api, prepared),
});

const vaultUnlock = defineCommand({
  id: 'vault.unlock',
  requires: ['account'],
  input: z.object({
    secret: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('passphrase'), passphrase: z.string().min(1) }),
      z.object({ kind: z.literal('recovery-key'), recoveryKey: z.string().min(1) }),
    ]),
  }),
  run: ({ account }, { secret }) => openVault({ ...account, secret }),
});

const vaultChangePassphrase = defineCommand({
  id: 'vault.changePassphrase',
  requires: ['vault'],
  input: Passphrase,
  run: ({ vault }, { passphrase }) =>
    changeVaultPassphrase({ ...vault, vault: vault.unlocked, passphrase }),
});

const spaceList = defineCommand({
  id: 'space.list',
  requires: ['vault'],
  input: z.object({}),
  run: ({ vault }) => spaces.loadSpaces(vault),
});

const spaceTree = defineCommand({
  id: 'space.tree',
  requires: ['vault'],
  input: z.object({ spaceId: SpaceId }),
  run: ({ vault }, { spaceId }) => spaces.loadTree(vault, spaceId),
});

const spaceCreate = defineCommand({
  id: 'space.create',
  requires: ['vault'],
  input: z.object({
    name: NodeMetadata.shape.name,
    emoji: NodeMetadata.shape.emoji,
    kind: z.enum(['personal', 'shared']).optional(),
  }),
  run: ({ vault }, { name, emoji, kind }) =>
    spaces.createSpace(vault, {
      name,
      ...(emoji === undefined ? {} : { emoji }),
      ...(kind === undefined ? {} : { kind }),
    }),
});

const folderCreate = defineCommand({
  id: 'folder.create',
  requires: ['vault'],
  input: z.object({
    spaceId: SpaceId,
    parentId: FolderId.nullable(),
    name: NodeMetadata.shape.name,
  }),
  run: ({ vault }, input) => spaces.createFolder(vault, input),
});

/** Rename a space or folder, or change its emoji or tint. */
const metadataUpdate = defineCommand({
  id: 'metadata.update',
  requires: ['vault'],
  input: z.object({
    spaceId: SpaceId,
    subject: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('space') }),
      z.object({ kind: z.literal('folder'), folderId: FolderId }),
    ]),
    current: LoadedMetadata,
    changes: Changes,
  }),
  run: ({ vault }, input) => spaces.updateMetadata(vault, input),
});

function byId<const T extends readonly AnyCommand[]>(
  ...list: T
): { readonly [C in T[number] as C['id']]: C } {
  const map: Record<string, AnyCommand> = {};
  for (const command of list) {
    if (command.id in map) throw new Error(`Two commands are named ${command.id}`);
    map[command.id] = command;
  }
  // Built from the same list the type is.
  return map as { readonly [C in T[number] as C['id']]: C };
}

/** Every command the client defines, by ID. */
export const commands = byId(
  vaultPrepare,
  vaultRegister,
  vaultUnlock,
  vaultChangePassphrase,
  spaceList,
  spaceTree,
  spaceCreate,
  folderCreate,
  metadataUpdate,
);

export type CommandId = keyof typeof commands;
