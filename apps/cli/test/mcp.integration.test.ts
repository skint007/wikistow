// `wikistow mcp`, the built CLI, driven by the MCP SDK's own client over
// standard input and output, as an agent's harness starts it, against the
// real server app with a real database.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { pageOperations as pages } from '@wikistow/client';
import { personWithVault } from '@wikistow/server-app/testing/content';
import { createTestApp, type TestApp } from '@wikistow/server-app/testing/harness';
import { invite, library, shareFolder } from '@wikistow/server-app/testing/sharing';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import {
  BIN,
  buildCli,
  cleanUp,
  cli,
  cliHome,
  enroll,
  listen,
  PASSPHRASE,
  type Answer,
  type Listening,
} from './support/cli.ts';

let t: TestApp;
let server: Listening;
beforeAll(async () => {
  [t] = await Promise.all([createTestApp(), buildCli()]);
  server = await listen(t);
}, 180_000);
afterAll(async () => {
  await server.close();
  await Promise.all([t.drop(), cleanUp()]);
});

it('serves the commands as tools, with their checks and output', async () => {
  const alice = await personWithVault(t);
  const bob = await personWithVault(t);
  const lib = await library(alice);
  await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, bob, 'editor', true)],
  });
  const home = await cliHome();
  await enroll(server, home, bob, {
    picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: true }],
  });

  // The passphrase on descriptor 3, read once and kept for every call.
  const passphrase = join(home.home, 'passphrase');
  await writeFile(passphrase, PASSPHRASE, { mode: 0o600 });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: '/bin/sh',
      args: [
        '-c',
        'exec "$0" "$1" mcp --passphrase-fd 3 3<"$2"',
        process.execPath,
        BIN,
        passphrase,
      ],
      env: { HOME: home.home, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stderr: 'pipe',
    }),
  );
  try {
    expect(client.getInstructions()).toContain('## Leave changes as drafts');
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('page_draft');
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const [first] = result.content as { type: 'text'; text: string }[];
      return {
        isError: result.isError === true,
        text: first?.text ?? '',
        json: (): Answer => JSON.parse(first?.text ?? ''),
      };
    };

    const tree = await call('tree', { space: lib.spaceId });
    expect(tree.json()).toMatchObject({ pages: [{ id: lib.page.pageId, title: 'Plan' }] });

    // The Markdown itself stands in for --file -, and comes back as written,
    // in the CLI's ASCII-only JSON.
    const markdown = 'Café notes, see [[Plan]].\n';
    const created = await call('page_create', {
      folder: lib.shared,
      title: 'Notes',
      markdown,
      'idempotency-key': 'mcp-create-1',
    });
    expect(created.isError, created.text).toBe(false);
    const made = created.json();
    const read = await call('page_read', { 'page-id': made.pageId, draft: true });
    expect(read.text).toContain('Caf\\u00e9');
    expect(read.json()).toMatchObject({ revisionId: made.revisionId, title: 'Notes', markdown });
    // The same key makes the change once.
    const again = await call('page_create', {
      folder: lib.shared,
      title: 'Notes',
      markdown,
      'idempotency-key': 'mcp-create-1',
    });
    expect(again.json().pageId).toBe(made.pageId);

    // A stale base is refused as the command refuses it: exit 3, with the heads.
    const page = { spaceId: lib.spaceId, pageId: made.pageId };
    await pages.editDraft(alice.ctx, page, { markdown: 'Alice got there first' });
    const stale = await call('page_draft', {
      'page-id': made.pageId,
      base: made.revisionId,
      markdown: 'late words',
    });
    expect(stale.isError).toBe(true);
    expect(stale.json().error).toMatchObject({ exit: 3, code: 'stale-head' });
    const usage = await call('page_draft', {
      'page-id': made.pageId,
      base: made.revisionId,
      markdown: 'one',
      file: 'two.md',
    });
    expect(usage.json().error).toMatchObject({ exit: 2, code: 'usage' });
  } finally {
    await client.close();
  }

  // An agent that can't open stops at once, with the command's status.
  const unenrolled = await cliHome();
  const stopped = await cli(unenrolled, ['mcp']);
  expect(stopped.code).toBe(5);
  expect(stopped.stdout).toBe('');
  expect(stopped.stderr).toContain('not enrolled');
}, 120_000);
