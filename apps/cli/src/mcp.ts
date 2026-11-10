// `wikistow mcp`: the CLI as an MCP server on standard input and output,
// for an agent's harness that speaks the Model Context Protocol. Each tool
// runs the command it is named for through `run`, with `--json`, and
// answers with what that printed. So a tool's checks, idempotency keys,
// exit statuses and output, foreign text escaped to ASCII (protocol
// section 9.3), are the command's own. Tools only, no resources.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readKeyFile, systemSecretStore, unlockSecret, type UnlockOptions } from './agent.ts';
import type { CommandName } from './cli.ts';
import type { Deps } from './commands/agent.ts';
import { classify, CliError, EXIT, type ExitStatus } from './exit.ts';
import { COMMAND_HELP, USAGE, VERSION } from './help.ts';
import { Printer, type Io } from './io.ts';
import { openKeyFile } from './keyfile.ts';
import { PROGRAM } from './program.ts';
import { SKILL_RULES } from './skill.ts';

/** `run` in cli.ts, passed in, as cli.ts runs this. */
type Run = (argv: readonly string[], io: Io, deps: Partial<Deps>) => Promise<ExitStatus>;

const ID = (what: string) => z.string().describe(what);
const KEY = z
  .string()
  .optional()
  .describe('--idempotency-key KEY: a new one for each change, the same one only to retry it');
const SPACE = ID('--space SPACE_ID');
const MARKDOWN = z
  .string()
  .optional()
  .describe('The Markdown itself, in place of --file -. Give this or file');
const FILE = z
  .string()
  .optional()
  .describe('--file PATH: a file holding the Markdown, by its full path');

type Tool = {
  command: CommandName;
  /** Inputs that are the command's arguments, in order; the rest are its options. */
  args?: readonly string[];
  /** Changes nothing. */
  reads?: true;
  input: Record<string, z.ZodType<Value>>;
};

/** What a tool takes: an argument, an option's value, or a flag. */
type Value = string | number | boolean | undefined;

/**
 * The commands an agent works with. Left out: enrolling and the secret
 * store, which are the person's, `skill`, which these tools' instructions
 * stand in for, and import and export, which read or write whole folders.
 */
const TOOLS: readonly Tool[] = [
  { command: 'agent status', reads: true, input: {} },
  { command: 'spaces list', reads: true, input: {} },
  { command: 'tree', reads: true, input: { space: SPACE } },
  {
    command: 'search',
    args: ['query'],
    reads: true,
    input: { query: z.string().describe('QUERY: the words to look for'), space: SPACE.optional() },
  },
  {
    command: 'page read',
    args: ['page-id'],
    reads: true,
    input: {
      'page-id': ID('PAGE_ID'),
      draft: z.boolean().optional().describe('--draft'),
      revision: ID('--revision REVISION_ID').optional(),
    },
  },
  {
    command: 'page create',
    input: {
      folder: ID('--folder FOLDER_ID'),
      title: z.string().describe('--title TITLE'),
      markdown: MARKDOWN,
      file: FILE,
      space: SPACE.optional(),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'page draft',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      base: ID('--base REVISION_ID: the draft head'),
      markdown: MARKDOWN,
      file: FILE,
      title: z.string().optional().describe('--title TITLE'),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'page attach',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      file: z.string().describe('--file PATH: the file to attach, by its full path'),
      name: z.string().optional().describe('--name NAME'),
      'media-type': z.string().optional().describe('--media-type TYPE'),
      base: ID('--base REVISION_ID: the draft head').optional(),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'page publish',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      revision: ID('--revision REVISION_ID: the draft head'),
      'base-published': ID('--base-published PUBLISHED_ID|none: the published head'),
      'permission-version': z.number().int().optional().describe('--permission-version N'),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'page unpublish',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      'base-published': ID('--base-published PUBLISHED_ID: the published head'),
    },
  },
  {
    command: 'page publish-to',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      space: SPACE,
      folder: ID('--folder FOLDER_ID').optional(),
      revision: ID('--revision REVISION_ID'),
      draft: z.boolean().optional().describe('--draft'),
      preview: z.boolean().optional().describe('--preview'),
      'base-copy': ID('--base-copy PUBLISHED_ID|none').optional(),
      attachments: z.string().optional().describe('--attachments all|none|ID,...'),
      'permission-version': z.number().int().optional().describe('--permission-version N'),
    },
  },
  {
    command: 'page copy',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      space: SPACE.optional(),
      folder: ID('--folder FOLDER_ID').optional(),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'page move',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      folder: ID('--folder FOLDER_ID|top'),
      'idempotency-key': KEY,
    },
  },
  { command: 'page history', args: ['page-id'], reads: true, input: { 'page-id': ID('PAGE_ID') } },
  { command: 'page links', args: ['page-id'], reads: true, input: { 'page-id': ID('PAGE_ID') } },
  {
    command: 'page comments',
    args: ['page-id'],
    reads: true,
    input: { 'page-id': ID('PAGE_ID') },
  },
  {
    command: 'page comment',
    args: ['page-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      text: z.string().describe('--text TEXT: the comment, in Markdown'),
      for: z
        .enum(['readers', 'editors'])
        .describe(
          '--for readers|editors: readers reaches everyone who can read the page; for a reply, its thread\'s "for"',
        ),
      'reply-to': ID("--reply-to COMMENT_ID: a thread's first comment, to reply to it").optional(),
    },
  },
  {
    command: 'page download-attachment',
    args: ['page-id', 'attachment-id'],
    input: {
      'page-id': ID('PAGE_ID'),
      'attachment-id': ID('ATTACHMENT_ID'),
      out: z
        .string()
        .describe('--out PATH: where to write the file, a full path that does not exist'),
      draft: z.boolean().optional().describe('--draft'),
      revision: ID('--revision REVISION_ID').optional(),
    },
  },
  {
    command: 'folder create',
    input: {
      name: z.string().describe('--name NAME'),
      space: SPACE.optional(),
      parent: ID('--parent FOLDER_ID').optional(),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'folder rename',
    args: ['folder-id'],
    input: {
      'folder-id': ID('FOLDER_ID'),
      name: z.string().describe('--name NAME'),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'folder move',
    args: ['folder-id'],
    input: {
      'folder-id': ID('FOLDER_ID'),
      folder: ID('--folder FOLDER_ID|top'),
      'idempotency-key': KEY,
    },
  },
  {
    command: 'folder copy',
    args: ['folder-id'],
    input: {
      'folder-id': ID('FOLDER_ID'),
      space: SPACE.optional(),
      folder: ID('--folder FOLDER_ID').optional(),
      'idempotency-key': KEY,
    },
  },
];

/** A command's tool name: `page publish-to` is `page_publish_to`. */
const toolName = (command: CommandName) => command.replace(/[ -]/g, '_');

/** What the server tells a client about itself, its tools and how to behave. */
const INSTRUCTIONS = `# WikiStow

These tools work in the wiki as this agent, with its own grants. Each runs
the \`${PROGRAM}\` command it is named for (page_read runs \`page read\`),
and its parameters are that command's options and arguments, named as
there: page-id for PAGE_ID, base-published for --base-published. It
answers with the command's --json output, and a failure with
{"error":{"exit":N,"code":"...","message":"...",...}}, N being the
command's exit status. Call help with a tool's name before its first use:
it gives the command's --help, the reference for its IDs, output and exit
statuses. help with no tool explains retrying a change and the exit
statuses. page_create and page_draft take the Markdown itself as
markdown. Below, commands are named as on the command line. import and
export aren't tools here: when the person asks for one, ask them to run
it in a terminal.

${SKILL_RULES}`;

/** The command line a tool call runs, but for unlocking, and what it reads as standard input. */
function commandLine(tool: Tool, input: Record<string, Value>) {
  const args = tool.args ?? [];
  const options: string[] = [];
  let stdin: Uint8Array | null = null;
  const { markdown, file, out } = input;
  if (markdown !== undefined && file !== undefined) {
    throw new CliError('usage', 'Give markdown or file, not both');
  }
  // Standard input and output carry the protocol.
  if (file === '-' || out === '-') {
    throw new CliError('usage', 'Standard input and output carry MCP here: give a path');
  }
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === false || args.includes(name)) continue;
    if (name === 'markdown') {
      options.push('--file=-');
      stdin = new TextEncoder().encode(String(value));
    } else options.push(value === true ? `--${name}` : `--${name}=${String(value)}`);
  }
  const words = tool.command.split(' ');
  return { options: [...words, ...options], args: args.map((name) => String(input[name])), stdin };
}

/**
 * `io` for one command, printing into strings: its standard input is
 * `stdin`, and it has no terminal to ask on.
 */
function captured(io: Io, stdin: Uint8Array | null) {
  const printed = { stdout: '', stderr: '' };
  const one: Io = {
    ...io,
    stdout: { write: (text) => void (printed.stdout += text), isTTY: false },
    stderr: { write: (text) => void (printed.stderr += text) },
    writeStdout: () => Promise.reject(new CliError('usage', 'Give --out a path')),
    readStdin: () => Promise.resolve(stdin ?? new Uint8Array()),
    readLine: () => Promise.resolve(null),
    askSecret: () => Promise.resolve(null),
  };
  return { io: one, printed };
}

/**
 * Serve the tools until standard input ends. The key file is unlocked
 * for each call, as for each command; a passphrase from `--passphrase-fd`
 * is read once, and kept for the next. The key file must open first: if
 * it doesn't, this says why on standard error and exits as a command would.
 */
export async function serveMcp(
  io: Io,
  unlock: UnlockOptions,
  deps: Partial<Deps>,
  run: Run,
): Promise<ExitStatus> {
  const read = new Map<number, Uint8Array>();
  // Never asks: standard input is the client's, even in a terminal.
  const kept: Io = {
    ...io,
    askSecret: () => Promise.resolve(null),
    readFd: (fd) => {
      const bytes = read.get(fd) ?? io.readFd(fd);
      read.set(fd, bytes);
      return bytes;
    },
  };
  const unlocking = [
    ...(unlock.passphraseFd === undefined ? [] : [`--passphrase-fd=${unlock.passphraseFd}`]),
    ...(unlock.usePassphrase ? ['--use-passphrase'] : []),
  ];
  // One command at a time, as they share the local state and journal.
  let last: Promise<unknown> = Promise.resolve();
  const runOne = (
    options: readonly string[],
    args: readonly string[],
    stdin: Uint8Array | null,
  ) => {
    const { io: one, printed } = captured(kept, stdin);
    // Every argument goes after a lone --, as an ID may start with one.
    const argv = [...options, ...unlocking, '--', ...args];
    const done = last.then(() => run(argv, one, deps));
    last = done.catch(() => {});
    return done.then((exit) => ({ exit, ...printed }));
  };

  // Only the key file is checked here: a server that doesn't answer yet
  // fails the calls made before it does, not the server.
  const out = new Printer(io, { json: false });
  try {
    const { file } = readKeyFile(kept);
    const makeStore = deps.makeStore ?? systemSecretStore;
    openKeyFile(file, await unlockSecret(kept, file, unlock, makeStore));
  } catch (error) {
    const failure = classify(error);
    out.failure(failure);
    return failure.exit;
  }

  const server = () => {
    const mcp = new McpServer(
      { name: PROGRAM, version: VERSION },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    const names = TOOLS.map((tool) => toolName(tool.command));
    mcp.registerTool(
      'help',
      {
        description:
          "A tool's command's --help, or with no tool, the CLI's overview: retrying a change, IDs and exit statuses",
        inputSchema: z.strictObject({ tool: z.enum(names).optional() }),
        annotations: { readOnlyHint: true },
      },
      ({ tool }) => {
        const command = TOOLS.find((one) => toolName(one.command) === tool)?.command;
        return { content: [{ type: 'text', text: command ? COMMAND_HELP[command] : USAGE }] };
      },
    );
    for (const tool of TOOLS) {
      // Its usage line and first paragraph; help has the rest.
      const description = COMMAND_HELP[tool.command].split('\n\n').slice(0, 2).join('\n\n');
      mcp.registerTool(
        toolName(tool.command),
        {
          description,
          inputSchema: z.strictObject(tool.input),
          annotations: { readOnlyHint: tool.reads === true },
        },
        async (input) => {
          let ran;
          try {
            const { options, args, stdin } = commandLine(tool, input);
            ran = await runOne([...options, '--json'], args, stdin);
          } catch (error) {
            // Refused before it ran, in the form the command refuses in.
            const { io: one, printed } = captured(kept, null);
            const failure = classify(error);
            new Printer(one, { json: true }).failure(failure);
            ran = { exit: failure.exit, ...printed };
          }
          const notes = ran.stderr === '' ? [] : [{ type: 'text' as const, text: ran.stderr }];
          return {
            content: [{ type: 'text', text: ran.stdout }, ...notes],
            // Exit 9 is done, with a warning: the change stands.
            isError: ran.exit !== EXIT.ok && ran.exit !== EXIT.stateNotSaved,
          };
        },
      );
    }
    return mcp;
  };

  const ended = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  serveStdio(server, {
    onerror: (error) => out.note(`${PROGRAM} mcp: ${out.foreign(error.message)}`),
  });
  await ended;
  // Let a command still running finish before the CLI exits.
  await last;
  return EXIT.ok;
}
