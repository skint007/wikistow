// The built CLI (`dist/wikistow.mjs`), run as a separate process the way
// an agent runs it, against the real server app with a real database. Its
// person works through the client library, as their web app would.
import { pageOperations as pages, spaceOperations, utf8 } from '@wikistow/client';
import { bumpPermissions, schema } from '@wikistow/server';
import { personWithVault } from '@wikistow/server-app/testing/content';
import { createTestApp, type TestApp } from '@wikistow/server-app/testing/harness';
import { invite, library, shareFolder } from '@wikistow/server-app/testing/sharing';
import { eq } from 'drizzle-orm';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  buildCli,
  cleanUp,
  cli,
  cliHome,
  enroll,
  fakeSecretTool,
  listen,
  PASSPHRASE,
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

/** Alice shares a folder with Bob as an editor who may publish; Bob's CLI gets it all. */
async function bobsAgent() {
  const alice = await personWithVault(t);
  const bob = await personWithVault(t);
  const lib = await library(alice);
  const shareId = await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, bob, 'editor', true)],
  });
  const home = await cliHome();
  const enrolled = await enroll(server, home, bob, {
    picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: true }],
  });
  const run = (args: readonly string[], options: { stdin?: string } = {}) =>
    cli(home, [...args, '--json'], { passphrase: PASSPHRASE, ...options });
  return { alice, lib, shareId, home, run, ...enrolled };
}

type Agent = Awaited<ReturnType<typeof bobsAgent>>;

const OBSIDIAN_NOTE = [
  '---',
  'tags: [network, home]',
  'aliases:',
  '  - "Router notes"',
  'link: "[[Not a link in frontmatter]]"',
  '---',
  '# Network notes',
  '',
  'See [[Plan]] and [[Shared/Plan|the plan]], then [[Nowhere]].',
  'Headings: [[#Network notes]] and [[Plan#Steps]].',
  'Inline `[[code]]` stays text, as does a block ref [[Plan#^abc]].',
  '![[router-photo.jpg]]',
  '',
  '```',
  '[[fenced]]',
  '```',
  '',
].join('\r\n');

describe('enrolling', () => {
  it('shows the person’s fingerprint, then writes a private key file', async () => {
    const bob = await personWithVault(t);
    const home = await cliHome();
    const enrolled = await enroll(server, home, bob, { name: 'laptop agent' });
    const who = enrolled.result.json();
    expect(who).toMatchObject({
      agentId: enrolled.agentId,
      name: 'laptop agent',
      person: bob.vault.identity.public.id,
      server: server.origin,
    });
    const keyFile = await readFile(join(home.dir, 'agent.key'), 'utf8');
    // A token's shape, with its dot: base64url ciphertext may hold wsa_ by chance, never a dot.
    expect(keyFile).not.toMatch(/wsa_[\w-]{22}\./);
    expect(keyFile).not.toContain(PASSPHRASE);
    const status = await cli(home, ['agent', 'status', '--json'], { passphrase: PASSPHRASE });
    expect(status.code, status.stderr).toBe(0);
    expect(status.json()).toMatchObject({ agentId: enrolled.agentId, name: 'laptop agent' });
  });
});

describe('an enrolled agent', () => {
  it('lists, creates, drafts, attaches, publishes and downloads', async () => {
    const { alice, lib, run, agentId, shareId, home } = await bobsAgent();

    const spaces = await run(['spaces', 'list']);
    expect(spaces.code, spaces.stderr).toBe(0);
    expect(spaces.json().spaces).toEqual([
      {
        spaceId: lib.spaceId,
        shareId,
        folderId: lib.shared,
        role: 'editor',
        canPublish: true,
        name: 'Shared',
      },
    ]);
    const tree = await run(['tree', '--space', lib.spaceId]);
    expect(tree.code, tree.stdout).toBe(0);
    expect(tree.json()).toMatchObject({
      space: null,
      folders: [{ id: lib.shared, parentId: null, name: 'Shared' }],
      pages: [{ id: lib.page.pageId, title: 'Plan' }],
    });

    // An Obsidian note, from standard input, keeps its frontmatter byte for byte.
    const created = await run(
      ['page', 'create', '--folder', lib.shared, '--title', 'Network notes', '--file', '-'],
      { stdin: OBSIDIAN_NOTE },
    );
    expect(created.code, created.stderr).toBe(0);
    const made = created.json();
    expect(made.spaceId).toBe(lib.spaceId);
    const read = await run(['page', 'read', made.pageId, '--draft']);
    expect(read.code, read.stderr).toBe(0);
    expect(read.json()).toMatchObject({
      revisionId: made.revisionId,
      title: 'Network notes',
      markdown: OBSIDIAN_NOTE,
      authorId: agentId,
    });
    // Alice reads exactly what the agent wrote.
    const page = { spaceId: lib.spaceId, pageId: made.pageId };
    const seen = await pages.openRevisionOf(alice.ctx, page, 'draft', made.revisionId);
    expect(seen.opened.kind === 'current' && seen.opened.payload.markdown).toBe(OBSIDIAN_NOTE);

    // A draft on a stale base is refused with the heads to start again from.
    await pages.editDraft(alice.ctx, page, { markdown: 'Alice got there first' });
    const { heads } = await pages.loadPage(alice.ctx, made.pageId);
    const stale = await run(
      ['page', 'draft', made.pageId, '--base', made.revisionId, '--file', '-'],
      { stdin: 'late words' },
    );
    expect(stale.code, stale.stdout).toBe(3);
    expect(stale.json()).toEqual({
      error: expect.objectContaining({
        exit: 3,
        code: 'stale-head',
        draftHead: heads.draftHead,
        publishedHead: null,
      }),
    });
    const drafted = await run(
      ['page', 'draft', made.pageId, '--base', String(heads.draftHead), '--file', '-'],
      { stdin: 'See [[Plan]].' },
    );
    expect(drafted.code, drafted.stderr).toBe(0);
    expect(drafted.json()).toMatchObject({
      basedOn: heads.draftHead,
      links: [{ status: 'resolved' }],
    });

    // It attaches a file, read from standard input.
    const attached = await run(
      ['page', 'attach', made.pageId, '--file', '-', '--name', 'router-photo.jpg'],
      { stdin: 'JPEG bytes' },
    );
    expect(attached.code, attached.stderr).toBe(0);
    const { attachment, revisionId: withFile } = attached.json();
    expect(attachment).toMatchObject({
      name: 'router-photo.jpg',
      mediaType: 'image/jpeg',
      size: 10,
    });

    // Publishing names the draft and the publication it replaces.
    const published = await run([
      'page',
      'publish',
      made.pageId,
      '--revision',
      withFile,
      '--base-published',
      'none',
    ]);
    expect(published.code, published.stderr).toBe(0);
    const { revisionId: publication } = published.json();
    const readBack = await run(['page', 'read', made.pageId]);
    expect(readBack.json()).toMatchObject({
      audience: 'published',
      revisionId: publication,
      attachments: [{ name: 'router-photo.jpg' }],
    });
    const opened = await pages.openRevisionOf(alice.ctx, page, 'published', publication);
    const [ref] = opened.opened.kind === 'current' ? opened.opened.payload.attachments : [];
    if (!ref) throw new Error('expected the attachment in the publication');
    const fromAlice = await pages.readAttachment(alice.ctx, page, 'published', ref);
    expect(new TextDecoder().decode(fromAlice)).toBe('JPEG bytes');

    // It downloads the file it can read: from the publication to a new file,
    // from the draft to standard output.
    const attachmentId = (attachment as { id: string }).id;
    const saved = join(home.home, 'photo.jpg');
    const download = ['page', 'download-attachment', made.pageId, attachmentId];
    const toFile = await run([...download, '--out', saved]);
    expect(toFile.code, toFile.stdout).toBe(0);
    expect(toFile.json()).toMatchObject({ revisionId: publication, out: saved });
    expect(await readFile(saved, 'utf8')).toBe('JPEG bytes');
    const toStdout = await cli(home, [...download, '--draft', '--out', '-'], {
      passphrase: PASSPHRASE,
    });
    expect(toStdout.code, toStdout.stderr).toBe(0);
    expect(toStdout.stdout).toBe('JPEG bytes');
    // About a dozen CLI runs, each deriving its key file's key: slow when
    // the whole suite runs at once.
  }, 120_000);

  it('publishes only to the readers it saw, given the permission version it read', async () => {
    const { alice, lib, run } = await bobsAgent();
    const made = (
      await run(['page', 'create', '--folder', lib.shared, '--title', 'Pinned', '--file', '-'], {
        stdin: 'one',
      })
    ).json();
    const look = async () => {
      const read = await run(['page', 'read', made.pageId, '--draft']);
      const tree = await run(['tree', '--space', lib.spaceId]);
      const { permissionVersion } = read.json();
      expect(tree.json().pages).toContainEqual(
        expect.objectContaining({ id: made.pageId, permissionVersion }),
      );
      return Number(permissionVersion);
    };
    const seen = await look();
    const publish = ['page', 'publish', made.pageId, '--revision', made.revisionId];
    const pinned = (version: number) => [
      ...publish,
      ...['--base-published', 'none', '--permission-version', String(version)],
    ];

    // Shared, moved or someone's access ended since it looked: nothing is published.
    await t.db.transaction((tx) => bumpPermissions(tx, lib.spaceId, [made.pageId]));
    const refused = await run(pinned(seen));
    expect(refused.code, refused.stdout).toBe(3);
    expect(refused.json().error).toMatchObject({ code: 'permission-version' });
    expect((await pages.loadPage(alice.ctx, made.pageId)).heads.publishedHead).toBeNull();

    const now = await look();
    expect(now).not.toBe(seen);
    const published = await run(pinned(now));
    expect(published.code, published.stdout).toBe(0);
    expect((await pages.loadPage(alice.ctx, made.pageId)).heads.publishedHead).toBe(
      published.json().revisionId,
    );
  }, 60_000);
});

describe('an export', () => {
  const FRONTMATTER = '---\r\ntags: [network]\r\nlink: "[[Plan]]"\r\n---\r\n';

  /**
   * Alice's shared folder, filled in: a folder whose name no file system
   * takes as it is, a page with frontmatter, CRLF lines, an embed, an
   * attachment link and links, one to a page renamed since.
   */
  async function filled(agent: Agent) {
    const { alice, lib } = agent;
    const { spaceId } = lib;
    const network = await spaceOperations.createFolder(alice.ctx, {
      spaceId,
      parentId: lib.shared,
      name: 'Network: home',
    });
    const oldId = await pages.createPage(alice.ctx, {
      spaceId,
      parentId: lib.shared,
      title: 'Old name',
      markdown: 'renamed since',
    });
    const routerId = await pages.createPage(alice.ctx, {
      spaceId,
      parentId: network,
      title: 'Router',
    });
    const router = { spaceId, pageId: routerId };
    const photo = await pages.uploadAttachment(alice.ctx, router, {
      name: 'photo.png',
      mediaType: 'image/png',
      bytes: utf8('PNG bytes'),
    });
    const manual = await pages.uploadAttachment(alice.ctx, router, {
      name: 'manual (v2).pdf',
      mediaType: 'application/pdf',
      bytes: utf8('PDF bytes'),
    });
    await pages.editDraft(alice.ctx, router, {
      attachments: [photo, manual],
      markdown: [
        `${FRONTMATTER}See [[Plan]], [[Private]] and [[Old name|the old one]].`,
        '![[photo.png]]',
        `[manual](attachment:${manual.id})\r\n`,
      ].join('\r\n\r\n'),
    });
    await pages.editDraft(alice.ctx, { spaceId, pageId: oldId }, { title: 'Renamed' });
    return { routerId, oldId, photo, manual };
  }

  const read = (path: string) => readFile(path, 'utf8');
  const mode = async (path: string) => (await stat(path)).mode & 0o777;

  it('writes what the agent edits, as Markdown files that link to each other', async () => {
    const agent = await bobsAgent();
    const { lib, run, home } = agent;
    const { routerId, oldId, photo, manual } = await filled(agent);
    const out = join(home.home, 'export');

    const exported = await run(['export', '--space', lib.spaceId, '--out', out]);
    expect(exported.code, exported.stderr).toBe(0);
    const { spaceId } = lib;
    expect(exported.json()).toEqual({
      out,
      pages: expect.arrayContaining([
        { spaceId, pageId: lib.page.pageId, path: 'Shared/Plan.md' },
        { spaceId, pageId: oldId, path: 'Shared/Renamed.md' },
        { spaceId, pageId: routerId, path: 'Shared/Network_ home/Router.md' },
      ]),
      attachments: [
        { spaceId, pageId: routerId, attachmentId: manual.id, path: 'attachments/manual (v2).pdf' },
        { spaceId, pageId: routerId, attachmentId: photo.id, path: 'attachments/photo.png' },
      ],
      skipped: [],
      unread: [],
    });
    expect(exported.json().pages).toHaveLength(3);
    // The agent edits, so it gets drafts; the share's root is its top, the
    // folder above it unseen.
    expect(await read(join(out, 'Shared/Plan.md'))).toBe('draft words');
    expect(await read(join(out, 'Shared/Network_ home/Router.md'))).toBe(
      [
        `${FRONTMATTER}See [[Plan]], [[Private]] and [[Renamed|the old one]].`,
        '![[../../attachments/photo.png]]',
        '[manual](../../attachments/manual%20%28v2%29.pdf)\r\n',
      ].join('\r\n\r\n'),
    );
    expect(await read(join(out, 'attachments/photo.png'))).toBe('PNG bytes');
    expect(await read(join(out, 'attachments/manual (v2).pdf'))).toBe('PDF bytes');
    expect((await readdir(out)).sort()).toEqual(['Shared', 'attachments']);
    for (const dir of ['', 'Shared', 'Shared/Network_ home', 'attachments']) {
      expect(await mode(join(out, dir))).toBe(0o700);
    }
    for (const file of ['Shared/Plan.md', 'attachments/photo.png']) {
      expect(await mode(join(out, file))).toBe(0o600);
    }
  }, 60_000);

  it('leaves out an attachment that is gone, and fails on a server error', async () => {
    const agent = await bobsAgent();
    const { run, home, lib } = agent;
    const { spaceId } = lib;
    const { routerId, photo, manual } = await filled(agent);
    const blob = (ref: { blobHash: string }) => `/api/blobs/${encodeURIComponent(ref.blobHash)}`;
    let failing = false;
    server.hooks.intercept = async (request, forward) => {
      const { pathname } = new URL(request.url);
      if (failing && pathname.startsWith('/api/blobs/')) {
        return new Response('{}', { status: 503 });
      }
      if (pathname === blob(photo)) return new Response('{}', { status: 404 });
      return forward();
    };
    try {
      const out = join(home.home, 'partial');
      const exported = await run(['export', '--space', spaceId, '--out', out]);
      expect(exported.code, exported.stderr).toBe(0);
      const left = { spaceId, pageId: routerId };
      expect(exported.json()).toMatchObject({
        attachments: [{ ...left, attachmentId: manual.id, path: 'attachments/manual (v2).pdf' }],
        skipped: [
          { ...left, attachmentId: photo.id, path: 'attachments/photo.png', reason: 'missing' },
        ],
      });
      expect(exported.json().pages).toHaveLength(3);
      // Its links still name where it would have been, so it can be put there.
      expect(await read(join(out, 'Shared/Network_ home/Router.md'))).toContain(
        '![[../../attachments/photo.png]]',
      );
      expect(await readdir(join(out, 'attachments'))).toEqual(['manual (v2).pdf']);

      // A failure every download shares fails the export, and what it wrote goes.
      failing = true;
      const failed = await run(['export', '--space', spaceId, '--out', join(home.home, 'none')]);
      expect(failed.code).not.toBe(0);
      await expect(stat(join(home.home, 'none'))).rejects.toThrow();
    } finally {
      server.hooks.intercept = null;
    }
  }, 60_000);
});

describe('an idempotency key', () => {
  it('resends the first run’s exact bytes, so a lost answer makes no duplicate', async () => {
    const { lib, run } = await bobsAgent();
    const sent: { key: string | null; body: string }[] = [];
    let drop = true;
    server.hooks.intercept = async (request, forward) => {
      if (request.method !== 'POST' || !request.url.endsWith(`/spaces/${lib.spaceId}/pages`)) {
        return forward();
      }
      sent.push({
        key: request.headers.get('idempotency-key'),
        body: await request.clone().text(),
      });
      const res = await forward();
      if (!drop) return res;
      // The change lands, but its answer never comes back.
      drop = false;
      return new Response('upstream went away', { status: 502 });
    };
    try {
      const args = ['page', 'create', '--folder', lib.shared, '--title', 'Retry', '--file', '-'];
      const key = ['--idempotency-key', 'create-retry-1'];
      const first = await run([...args, ...key], { stdin: 'once' });
      expect(first.code).toBe(1);
      expect(first.json().error).toMatchObject({ outcomeUnknown: true });
      const second = await run([...args, ...key], { stdin: 'once' });
      expect(second.code, second.stdout).toBe(0);
      expect(sent.map((s) => s.key)).toEqual(['create-retry-1', 'create-retry-1']);
      expect(sent[1]?.body).toBe(sent[0]?.body);
      const made = second.json();
      expect(made.pageId).toBe(JSON.parse(sent[0]?.body ?? '{}').pageId);
      const rows = await t.db
        .select({ id: schema.nodes.id })
        .from(schema.nodes)
        .where(eq(schema.nodes.spaceId, lib.spaceId));
      expect(rows.filter((row) => row.id === made.pageId)).toHaveLength(1);
      // The key belongs to that change: another change with it is refused here.
      const other = await run(
        ['page', 'draft', made.pageId, '--base', made.revisionId, '--file', '-', ...key],
        { stdin: 'other' },
      );
      expect(other.code).toBe(3);
      expect(other.json().error.code).toBe('journal-mismatch');
    } finally {
      server.hooks.intercept = null;
    }
  });
});

/**
 * Alice's library, its page published with two files and a link, and a
 * newer draft, and her board, another space. Bob edits and publishes in a
 * folder of each, and his agent has both.
 */
async function twoSpaces() {
  const alice = await personWithVault(t);
  const bob = await personWithVault(t);
  const lib = await library(alice);
  const { page } = lib;
  const attach = (name: string) =>
    pages.uploadAttachment(alice.ctx, page, {
      name,
      mediaType: 'text/plain',
      bytes: utf8(`the ${name} of the source`),
    });
  const files = [await attach('map.txt'), await attach('notes.txt')];
  await pages.editDraft(alice.ctx, page, { markdown: 'see [[Budget]]', attachments: files });
  await pages.publishPage(alice.ctx, page);
  await pages.editDraft(alice.ctx, page, { markdown: 'draft words, not yet published' });
  const board = await spaceOperations.createSpace(alice.ctx, { name: 'Board' });
  const pinned = await spaceOperations.createFolder(alice.ctx, {
    spaceId: board,
    parentId: null,
    name: 'Pinned',
  });
  for (const [spaceId, rootId] of [
    [lib.spaceId, lib.shared],
    [board, pinned],
  ] as const) {
    const people = [await invite(alice, bob, 'editor', true)];
    await shareFolder(alice.ctx, { spaceId, rootId, people });
  }
  const home = await cliHome();
  const { agentId } = await enroll(server, home, bob, {
    picks: [
      { spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: true },
      { spaceId: board, folderId: pinned, role: 'editor', canPublish: true },
    ],
  });
  const run = (args: readonly string[]) =>
    cli(home, [...args, '--json'], { passphrase: PASSPHRASE });
  const { heads } = await pages.loadPage(alice.ctx, page.pageId);
  return {
    alice,
    page,
    board,
    pinned,
    agentId,
    run,
    files,
    published: String(heads.publishedHead),
    draft: String(heads.draftHead),
  };
}

describe('publishing into another space', () => {
  it('copies the version and files it names, and never publishes over a copy unseen', async () => {
    const { alice, page, board, pinned, agentId, run, files, published, draft } = await twoSpaces();
    const [map, notes] = files;
    if (!map || !notes) throw new Error('expected two files');
    const to = ['page', 'publish-to', page.pageId, '--space', board, '--folder', pinned];

    // A look first: where it goes, every file the version lists, and the
    // links readers there may not open.
    const looked = await run([...to, '--revision', published, '--preview']);
    expect(looked.code, looked.stdout).toBe(0);
    expect(looked.json()).toMatchObject({
      preview: true,
      source: { ...page, revisionId: published, audience: 'published' },
      spaceId: board,
      pageId: null,
      parentId: pinned,
      state: 'new',
      publishedHead: null,
      baseCopy: null,
      region: 'share',
      attachments: [
        { id: map.id, name: 'map.txt' },
        { id: notes.id, name: 'notes.txt' },
      ],
      links: [expect.objectContaining({ text: 'Budget', count: 1 })],
    });

    // The copy lands, but its answer is lost: running it again is safe.
    const send = ['--base-copy', 'none', '--attachments', map.id];
    server.hooks.intercept = async (request, forward) => {
      const res = await forward();
      return request.method === 'POST' && /\/versions$/.test(new URL(request.url).pathname)
        ? new Response('gone', { status: 502 })
        : res;
    };
    try {
      const lost = await run([...to, '--revision', published, ...send]);
      expect(lost.code, lost.stdout).toBe(1);
      expect(lost.json().error).toMatchObject({ outcomeUnknown: true });
      expect(lost.json().error.message).toContain('Run the same command again');
    } finally {
      server.hooks.intercept = null;
    }
    // The copy it made is there, by the agent, with just the file it picked.
    const next = await run([...to, '--revision', draft, '--draft', '--preview']);
    expect(next.json()).toMatchObject({ state: 'existing', parentId: pinned });
    const copy = { spaceId: board, pageId: next.json().pageId };
    const history = await pages.loadHistory(alice.ctx, copy);
    const first = history[0]?.revisionId;
    if (!first) throw new Error('expected the copy published');
    expect(history.map((v) => v.publisher.identityId)).toEqual([agentId]);
    expect(next.json()).toMatchObject({ publishedHead: first, baseCopy: first });
    const copied = await pages.openRevisionOf(alice.ctx, copy, 'published', first);
    const payload = copied.opened.kind === 'current' ? copied.opened.payload : null;
    expect(payload?.markdown).toBe('see [[Budget]]');
    expect(payload?.attachments.map((a) => a.name)).toEqual(['map.txt']);
    // Run again, it finds that copy in the way, names it, and says it is of this version.
    const again = await run([...to, '--revision', published, ...send]);
    expect(again.code, again.stdout).toBe(3);
    expect(again.json().error).toMatchObject({
      code: 'stale-head',
      pageId: copy.pageId,
      publishedHead: first,
      baseCopy: first,
      sameVersion: true,
    });
    expect(await pages.loadHistory(alice.ctx, copy)).toHaveLength(1);
  }, 120_000);
});

describe('unlocking without a passphrase prompt (gate L359)', () => {
  it('uses a configured secret store', async () => {
    const bob = await personWithVault(t);
    const home = await cliHome();
    const store = await fakeSecretTool(home);
    await enroll(server, home, bob, { extra: ['--secret-store', '--secret-tool', store.tool] });
    // Unattended: no passphrase, no terminal.
    const status = await cli(home, ['agent', 'status', '--json']);
    expect(status.code, status.stderr).toBe(0);
    expect(status.json().secretStore).toEqual({ tool: store.tool, store: 'secret-service' });
  });
});
