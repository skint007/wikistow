// The command line: parse it, run the command, and turn whatever happened
// into an exit status (`exit.ts`).
import { AttachmentId, FolderId, PageId, RevisionId, SpaceId } from '@wikistow/contracts';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { cliFetch, systemSecretStore, type UnlockOptions } from './agent.ts';
import { enroll, secretStore, status, type Deps } from './commands/agent.ts';
import {
  attachFile,
  createFolder,
  createPage,
  downloadAttachment,
  draftPage,
  listSpaces,
  pageHistory,
  publishPage,
  publishTo,
  readPage,
  tree,
  unpublishPage,
  type AttachmentPick,
  type ContentArgs,
} from './commands/content.ts';
import { exportMarkdown } from './commands/export.ts';
import { search } from './commands/search.ts';
import { classify, CliError, EXIT, type ExitStatus } from './exit.ts';
import { WINDOWS } from './files.ts';
import { COMMAND_HELP, USAGE, VERSION } from './help.ts';
import { Printer, type Io } from './io.ts';
import { SYSTEM_STORE, systemTool } from './secret-store.ts';
import { SKILL } from './skill.ts';

type Options = NonNullable<ParseArgsConfig['options']>;

const COMMON = {
  json: { type: 'boolean' },
  'passphrase-fd': { type: 'string' },
  'use-passphrase': { type: 'boolean' },
  'idempotency-key': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies Options;

/** Each command's own options, past the common ones, and how many IDs it takes. */
const COMMANDS = {
  'agent enroll': {
    options: {
      server: { type: 'string' },
      'secret-store': { type: 'boolean' },
      'secret-tool': { type: 'string' },
      'fingerprint-answer-from-stdin': { type: 'boolean' },
    },
    positionals: 0,
  },
  'agent status': { options: {}, positionals: 0 },
  whoami: { options: {}, positionals: 0 },
  'agent secret-store': { options: { 'secret-tool': { type: 'string' } }, positionals: 1 },
  skill: { options: {}, positionals: 0 },
  'spaces list': { options: {}, positionals: 0 },
  tree: { options: { space: { type: 'string' } }, positionals: 0 },
  search: { options: { space: { type: 'string' } }, positionals: 1 },
  export: {
    options: { space: { type: 'string' }, folder: { type: 'string' }, out: { type: 'string' } },
    positionals: 0,
  },
  'folder create': {
    options: { space: { type: 'string' }, parent: { type: 'string' }, name: { type: 'string' } },
    positionals: 0,
  },
  'page read': {
    options: { draft: { type: 'boolean' }, revision: { type: 'string' } },
    positionals: 1,
  },
  'page create': {
    options: {
      folder: { type: 'string' },
      space: { type: 'string' },
      title: { type: 'string' },
      file: { type: 'string' },
    },
    positionals: 0,
  },
  'page draft': {
    options: { base: { type: 'string' }, file: { type: 'string' }, title: { type: 'string' } },
    positionals: 1,
  },
  'page publish': {
    options: {
      revision: { type: 'string' },
      'base-published': { type: 'string' },
      'permission-version': { type: 'string' },
    },
    positionals: 1,
  },
  'page unpublish': { options: { 'base-published': { type: 'string' } }, positionals: 1 },
  'page publish-to': {
    options: {
      space: { type: 'string' },
      folder: { type: 'string' },
      revision: { type: 'string' },
      draft: { type: 'boolean' },
      attachments: { type: 'string' },
      'base-copy': { type: 'string' },
      'permission-version': { type: 'string' },
      preview: { type: 'boolean' },
    },
    positionals: 1,
  },
  'page attach': {
    options: {
      file: { type: 'string' },
      name: { type: 'string' },
      'media-type': { type: 'string' },
      base: { type: 'string' },
    },
    positionals: 1,
  },
  'page history': { options: {}, positionals: 1 },
  'page download-attachment': {
    options: { draft: { type: 'boolean' }, revision: { type: 'string' }, out: { type: 'string' } },
    positionals: 2,
  },
} as const satisfies Record<string, { options: Options; positionals: number }>;

export type CommandName = keyof typeof COMMANDS;

const isCommand = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

/** The command named by the first words of `argv`, and the rest. */
function commandOf(argv: readonly string[]): { name: CommandName; rest: string[] } {
  const words = argv.slice(0, 2);
  for (const length of [2, 1]) {
    const name = words.slice(0, length).join(' ');
    if (isCommand(name)) return { name, rest: argv.slice(length) };
  }
  throw new CliError('usage', 'Unknown command; see wikistow --help');
}

type Values = Record<string, string | boolean | undefined>;

function required(values: Values, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '') {
    throw new CliError('usage', `--${name} is required`);
  }
  return value;
}

const optional = (values: Values, name: string): string | null => {
  const value = values[name];
  return typeof value === 'string' ? value : null;
};

/** An ID from the command line, checked against its pattern before it goes anywhere. */
function id<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: string,
  what: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CliError('usage', `That is not a ${what} ID`);
  return parsed.data;
}

/** `--permission-version`: the number page read, tree or --preview showed, if given. */
function permissionVersionOf(values: Values): number | null {
  const value = optional(values, 'permission-version');
  if (value === null) return null;
  if (!/^[0-9]{1,15}$/.test(value)) {
    throw new CliError(
      'usage',
      '--permission-version takes the number page read or --preview shows',
    );
  }
  return Number(value);
}

/** `--attachments`: all, none, or attachment IDs between commas. */
function attachmentsOf(value: string): AttachmentPick {
  if (value === 'all' || value === 'none') return value;
  return value.split(',').map((one) => id(AttachmentId, one, 'attachment'));
}

function unlockOf(values: Values): UnlockOptions {
  const fd = optional(values, 'passphrase-fd');
  if (fd !== null && !/^[0-9]{1,4}$/.test(fd)) {
    throw new CliError('usage', '--passphrase-fd takes a file descriptor number');
  }
  // A Windows program inherits no descriptors past the standard three.
  if (WINDOWS && fd !== null && Number(fd) !== 0) {
    throw new CliError(
      'usage',
      'On Windows, --passphrase-fd takes only 0, standard input; see wikistow --help',
    );
  }
  return {
    passphraseFd: fd === null ? undefined : Number(fd),
    usePassphrase: values['use-passphrase'] === true,
  };
}

/** `--secret-tool`: another secret-tool, so only where the store is the Secret Service. */
function secretToolOf(values: Values): string | null {
  const tool = optional(values, 'secret-tool');
  if (tool !== null && SYSTEM_STORE !== 'secret-service') {
    throw new CliError('usage', '--secret-tool is only for secret-tool on Linux');
  }
  return tool;
}

/** The shape of the IDs WikiStow makes: 16 random bytes, base64url. */
const MADE_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * `args` with every option before a `--` and every argument after it.
 * IDs are base64url and may start with `-` or even `--`, which `parseArgs`
 * would take for an option, or refuse as an option's value: so an option
 * that takes a value always takes the next word, a word that is no option
 * but has an ID's shape is an argument while the command still wants one,
 * and any other word that doesn't start with `--` is an argument. After a
 * `--`, every word is an argument.
 */
function separated(args: readonly string[], options: Options, wanted: number): string[] {
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      if (arg === '-h') flags.push(arg);
      else positionals.push(arg);
      continue;
    }
    const [name = '', ...value] = arg.slice(2).split('=');
    const option = Object.hasOwn(options, name) ? options[name] : undefined;
    if (!option) {
      if (positionals.length < wanted && MADE_ID.test(arg)) {
        positionals.push(arg);
        continue;
      }
      throw new CliError('usage', `Unknown option --${name}; see wikistow --help`);
    }
    if (option.type === 'boolean') {
      if (value.length > 0) throw new CliError('usage', `--${name} takes no value`);
      flags.push(arg);
    } else if (value.length > 0) flags.push(arg);
    else if (i + 1 < args.length) flags.push(`--${name}=${args[++i] ?? ''}`);
    else throw new CliError('usage', `--${name} needs a value`);
  }
  return [...flags, '--', ...positionals];
}

/** What a command line asks for, parsed and checked, ready to run. */
function parse(argv: readonly string[]) {
  const { name, rest } = commandOf(argv);
  const spec = COMMANDS[name];
  const options: Options = { ...COMMON, ...spec.options };
  const args = separated(rest, options, spec.positionals);
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args,
      options,
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] };
  } catch (cause) {
    // `separated` has refused every mistake it can name already.
    throw new CliError('usage', 'Unknown option or missing value; see wikistow --help', { cause });
  }
  const { values, positionals } = parsed;
  // Help is decided from the parsed options, so a value such as --title -h
  // can't turn a change into a help text that exits 0 having done nothing.
  if (values.help === true) return { name, help: true } as const;
  if (positionals.length !== spec.positionals) {
    throw new CliError(
      'usage',
      `${name} takes ${spec.positionals || 'no'} argument${spec.positionals === 1 ? '' : 's'}; see wikistow --help`,
    );
  }
  const key = optional(values, 'idempotency-key');
  const changes = ['folder create', 'page create', 'page draft', 'page publish', 'page attach'];
  if (key !== null && !changes.includes(name)) {
    throw new CliError('usage', '--idempotency-key is only for create, draft, publish and attach');
  }
  const unlock = unlockOf(values);
  if (unlock.passphraseFd === 0) {
    // Read to its end for the passphrase, standard input has nothing left.
    if (name === 'agent enroll') {
      throw new CliError(
        'usage',
        'agent enroll reads the fingerprint’s yes from standard input, so not the passphrase',
      );
    }
    if (values.file === '-') {
      throw new CliError(
        'usage',
        '--file - and --passphrase-fd 0 both read standard input; give one of them a file',
      );
    }
  }
  const content: ContentArgs = { unlock, idempotencyKey: key };
  return { name, help: false, values, positionals, content } as const;
}

type Parsed = Extract<ReturnType<typeof parse>, { help: false }>;

/** Run one command line and give its exit status. Nothing here calls `process.exit`. */
export async function run(
  argv: readonly string[],
  io: Io,
  deps: Partial<Deps> = {},
): Promise<ExitStatus> {
  const [first] = argv;
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    io.stdout.write(USAGE);
    return first === undefined ? EXIT.usage : EXIT.ok;
  }
  if (first === '--version') {
    io.stdout.write(`wikistow ${VERSION}\n`);
    return EXIT.ok;
  }
  const all: Deps = {
    makeStore: systemSecretStore,
    send: cliFetch,
    pollMs: 1000,
    ...deps,
  };
  let command: ReturnType<typeof parse>;
  try {
    command = parse(argv);
  } catch (error) {
    // Unparsed, so --json is only a guess, and only the error's form hangs on it.
    const failure = classify(error);
    new Printer(io, { json: argv.includes('--json') }).failure(failure);
    return failure.exit;
  }
  if (command.help) {
    io.stdout.write(COMMAND_HELP[command.name]);
    return EXIT.ok;
  }
  const out = new Printer(io, { json: command.values.json === true });
  try {
    await dispatch(io, out, command, all);
    return out.warning?.exit ?? EXIT.ok;
  } catch (error) {
    const failure = classify(error);
    out.failure(failure);
    return failure.exit;
  }
}

async function dispatch(io: Io, out: Printer, command: Parsed, deps: Deps) {
  const { name, values, positionals, content } = command;
  const [first = ''] = positionals;
  switch (name) {
    case 'agent enroll': {
      const store = values['secret-store'] === true;
      const tool = secretToolOf(values);
      if (tool !== null && !store)
        throw new CliError('usage', '--secret-tool goes with --secret-store');
      return enroll(
        io,
        out,
        {
          server: required(values, 'server'),
          unlock: content.unlock,
          secretTool: store ? (tool ?? systemTool(io.env)) : null,
          answerFromStdin: values['fingerprint-answer-from-stdin'] === true,
        },
        deps,
      );
    }
    case 'agent status':
    case 'whoami':
      return status(io, out, { unlock: content.unlock }, deps);
    case 'agent secret-store': {
      if (first !== 'enable' && first !== 'disable') {
        throw new CliError('usage', 'agent secret-store takes enable or disable');
      }
      return secretStore(
        io,
        out,
        {
          action: first,
          unlock: content.unlock,
          secretTool: secretToolOf(values) ?? systemTool(io.env),
        },
        deps,
      );
    }
    case 'skill':
      return out.result({ skill: SKILL }, () => io.stdout.write(SKILL));
    case 'spaces list':
      return listSpaces(io, out, content, deps);
    case 'tree':
      return tree(
        io,
        out,
        { ...content, spaceId: id(SpaceId, required(values, 'space'), 'space') },
        deps,
      );
    case 'search': {
      // Words are runs of letters and digits; a query of none would match nothing.
      if (!/[\p{L}\p{N}]/u.test(first)) {
        throw new CliError('usage', 'search takes some words to look for');
      }
      const space = optional(values, 'space');
      return search(
        io,
        out,
        { ...content, query: first, spaceId: space === null ? null : id(SpaceId, space, 'space') },
        deps,
      );
    }
    case 'export': {
      const space = optional(values, 'space');
      const folder = optional(values, 'folder');
      return exportMarkdown(
        io,
        out,
        {
          ...content,
          spaceId: space === null ? null : id(SpaceId, space, 'space'),
          folderId: folder === null ? null : id(FolderId, folder, 'folder'),
          out: required(values, 'out'),
        },
        deps,
      );
    }
    case 'folder create': {
      const space = optional(values, 'space');
      const parent = optional(values, 'parent');
      if (space === null && parent === null) {
        throw new CliError('usage', 'folder create takes --space, --parent or both');
      }
      // Trimmed, as WikiStow's New folder trims it, and as long as a folder's name may be.
      const name = required(values, 'name').trim();
      if (name === '' || name.length > 200) {
        throw new CliError('usage', '--name takes a name of 1 to 200 characters');
      }
      return createFolder(
        io,
        out,
        {
          ...content,
          spaceId: space === null ? null : id(SpaceId, space, 'space'),
          parentId: parent === null ? null : id(FolderId, parent, 'folder'),
          name,
        },
        deps,
      );
    }
    case 'page read': {
      const revision = optional(values, 'revision');
      return readPage(
        io,
        out,
        {
          ...content,
          pageId: id(PageId, first, 'page'),
          draft: values.draft === true,
          revisionId: revision === null ? null : id(RevisionId, revision, 'revision'),
        },
        deps,
      );
    }
    case 'page create': {
      const space = optional(values, 'space');
      return createPage(
        io,
        out,
        {
          ...content,
          folderId: id(FolderId, required(values, 'folder'), 'folder'),
          spaceId: space === null ? null : id(SpaceId, space, 'space'),
          title: required(values, 'title'),
          file: required(values, 'file'),
        },
        deps,
      );
    }
    case 'page draft':
      return draftPage(
        io,
        out,
        {
          ...content,
          pageId: id(PageId, first, 'page'),
          base: id(RevisionId, required(values, 'base'), 'revision'),
          file: required(values, 'file'),
          title: optional(values, 'title'),
        },
        deps,
      );
    case 'page publish': {
      const base = required(values, 'base-published');
      return publishPage(
        io,
        out,
        {
          ...content,
          pageId: id(PageId, first, 'page'),
          revisionId: id(RevisionId, required(values, 'revision'), 'revision'),
          basePublished: base === 'none' ? null : id(RevisionId, base, 'published revision'),
          permissionVersion: permissionVersionOf(values),
        },
        deps,
      );
    }
    case 'page unpublish': {
      const base = required(values, 'base-published');
      if (base === 'none') {
        throw new CliError('usage', 'A page with no publication has nothing to unpublish');
      }
      return unpublishPage(
        io,
        out,
        {
          ...content,
          pageId: id(PageId, first, 'page'),
          basePublished: id(RevisionId, base, 'published revision'),
        },
        deps,
      );
    }
    case 'page publish-to': {
      const folder = optional(values, 'folder');
      const preview = values.preview === true;
      const sending = ['base-copy', 'attachments', 'permission-version'];
      if (preview && sending.some((name) => values[name] !== undefined)) {
        throw new CliError(
          'usage',
          '--preview sends nothing: leave out --base-copy, --attachments and --permission-version',
        );
      }
      const base = preview ? null : required(values, 'base-copy');
      return publishTo(
        io,
        out,
        {
          ...content,
          pageId: id(PageId, first, 'page'),
          revisionId: id(RevisionId, required(values, 'revision'), 'revision'),
          draft: values.draft === true,
          spaceId: id(SpaceId, required(values, 'space'), 'space'),
          folderId: folder === null ? null : id(FolderId, folder, 'folder'),
          send:
            base === null
              ? null
              : {
                  baseCopy: base === 'none' ? null : id(RevisionId, base, 'published revision'),
                  attachments: attachmentsOf(required(values, 'attachments')),
                  permissionVersion: permissionVersionOf(values),
                },
        },
        deps,
      );
    }
    case 'page attach': {
      const base = optional(values, 'base');
      return attachFile(
        io,
        out,
        {
          ...content,
          pageId: id(PageId, first, 'page'),
          file: required(values, 'file'),
          name: optional(values, 'name'),
          mediaType: optional(values, 'media-type'),
          base: base === null ? null : id(RevisionId, base, 'revision'),
        },
        deps,
      );
    }
    case 'page download-attachment': {
      const revision = optional(values, 'revision');
      const [, second = ''] = positionals;
      return downloadAttachment(
        io,
        out,
        {
          ...content,
          pageId: id(PageId, first, 'page'),
          attachmentId: id(AttachmentId, second, 'attachment'),
          draft: values.draft === true,
          revisionId: revision === null ? null : id(RevisionId, revision, 'revision'),
          out: required(values, 'out'),
        },
        deps,
      );
    }
    case 'page history':
      return pageHistory(io, out, { ...content, pageId: id(PageId, first, 'page') }, deps);
  }
}
