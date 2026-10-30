// The built CLI (`dist/wikistow.mjs`), run as a separate process the way
// an agent runs it, against the real server app with a real database. Its
// person works through the client library, as their web app would.
import { pageOperations as pages, spaceOperations, utf8 } from '@wikistow/client';
import type { PageId, SpaceId } from '@wikistow/contracts';
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
  start,
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

describe('making folders', () => {
  it('makes a folder in its share, one inside that, and a page there', async () => {
    const { alice, lib, run } = await bobsAgent();
    const { spaceId } = lib;

    // With no --parent, at the top of its share.
    const outer = await run(['folder', 'create', '--space', spaceId, '--name', ' Notebooks ']);
    expect(outer.code, outer.stdout).toBe(0);
    const notebooks = outer.json();
    expect(notebooks).toEqual({
      spaceId,
      parentId: lib.shared,
      folderId: expect.any(String),
      name: 'Notebooks',
    });
    // With only --parent, the space is looked up.
    const inner = await run(['folder', 'create', '--parent', notebooks.folderId, '--name', 'Home']);
    expect(inner.code, inner.stdout).toBe(0);
    const home = inner.json();
    expect(home).toMatchObject({ spaceId, parentId: notebooks.folderId });
    const page = await run(
      ['page', 'create', '--folder', home.folderId, '--title', 'Router', '--file', '-'],
      { stdin: 'notes' },
    );
    expect(page.code, page.stdout).toBe(0);

    const tree = (await run(['tree', '--space', spaceId])).json();
    expect(tree.folders).toEqual(
      expect.arrayContaining([
        { id: notebooks.folderId, parentId: lib.shared, name: 'Notebooks' },
        { id: home.folderId, parentId: notebooks.folderId, name: 'Home' },
      ]),
    );
    expect(tree.pages).toContainEqual(
      expect.objectContaining({ id: page.json().pageId, parentId: home.folderId }),
    );
    // Alice sees them too, with the look New folder starts with.
    const hers = await spaceOperations.loadTree(alice.ctx, spaceId);
    const made = hers.folders.find((f) => f.id === home.folderId)?.metadata?.opened;
    expect(made?.kind === 'current' && made.metadata).toMatchObject({ name: 'Home', emoji: '⭐' });
  }, 60_000);

  it('is refused outside its shares, as page create is', async () => {
    const { lib, run } = await bobsAgent();
    const where = ['--space', lib.spaceId];
    const folder = await run(['folder', 'create', ...where, '--parent', lib.above, '--name', 'X']);
    const page = await run(
      ['page', 'create', ...where, '--folder', lib.above, '--title', 'X', '--file', '-'],
      { stdin: 'x' },
    );
    expect(page.code).not.toBe(0);
    expect(folder.code, folder.stdout).toBe(page.code);
    expect(folder.json().error.code).toBe(page.json().error.code);
    const tree = (await run(['tree', '--space', lib.spaceId])).json();
    expect(tree.folders).toEqual([{ id: lib.shared, parentId: null, name: 'Shared' }]);
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

  it('makes one folder when a folder create’s answer is lost', async () => {
    const { lib, run } = await bobsAgent();
    const sent: string[] = [];
    let drop = true;
    server.hooks.intercept = async (request, forward) => {
      if (request.method !== 'POST' || !request.url.endsWith(`/spaces/${lib.spaceId}/folders`)) {
        return forward();
      }
      sent.push(await request.clone().text());
      const res = await forward();
      if (!drop) return res;
      drop = false;
      return new Response('upstream went away', { status: 502 });
    };
    try {
      const args = ['folder', 'create', '--space', lib.spaceId, '--name', 'Once'];
      const key = ['--idempotency-key', 'folder-retry-1'];
      const first = await run([...args, ...key]);
      expect(first.code).toBe(1);
      expect(first.json().error).toMatchObject({ outcomeUnknown: true });
      const second = await run([...args, ...key]);
      expect(second.code, second.stdout).toBe(0);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toBe(sent[0]);
      expect(second.json().folderId).toBe(JSON.parse(sent[0] ?? '{}').folderId);
      const tree = (await run(['tree', '--space', lib.spaceId])).json();
      const folders = tree.folders as { name: string }[];
      expect(folders.filter((f) => f.name === 'Once')).toHaveLength(1);
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

/**
 * Alice's library, with a folder Trip in Shared holding a published page
 * that links to Plan and Route, and Route, a draft alone; and a folder
 * Recipes she shares with Bob to read, with Soup published in it. And her board, with Pinned, where
 * Bob's agent may publish, and Drafts, where Bob publishes but his agent
 * may only edit. His agent has all four.
 */
async function copyWorld() {
  const alice = await personWithVault(t);
  const bob = await personWithVault(t);
  const lib = await library(alice);
  const { spaceId } = lib;
  const folder = (space: typeof spaceId, parentId: typeof lib.shared | null, name: string) =>
    spaceOperations.createFolder(alice.ctx, { spaceId: space, parentId, name });
  const page = (parentId: typeof lib.shared, title: string, markdown: string) =>
    pages.createPage(alice.ctx, { spaceId, parentId, title, markdown });
  const trip = await folder(spaceId, lib.shared, 'Trip');
  const packing = await page(trip, 'Packing', 'see [[Route]] and [[Plan]]');
  await pages.publishPage(alice.ctx, { spaceId, pageId: packing });
  const route = await page(trip, 'Route', 'north');
  const recipes = await folder(spaceId, null, 'Recipes');
  const soup = await page(recipes, 'Soup', 'leeks');
  await pages.publishPage(alice.ctx, { spaceId, pageId: soup });
  const board = await spaceOperations.createSpace(alice.ctx, { name: 'Board' });
  const pinned = await folder(board, null, 'Pinned');
  const drafts = await folder(board, null, 'Drafts');
  for (const [space, rootId, role] of [
    [spaceId, lib.shared, 'editor'],
    [spaceId, recipes, 'reader'],
    [board, pinned, 'editor'],
    [board, drafts, 'editor'],
  ] as const) {
    const people = [await invite(alice, bob, role, role === 'editor')];
    await shareFolder(alice.ctx, { spaceId: space, rootId, people });
  }
  const home = await cliHome();
  const { agentId } = await enroll(server, home, bob, {
    picks: [
      { spaceId, folderId: lib.shared, role: 'editor', canPublish: true },
      { spaceId, folderId: recipes, role: 'reader' },
      { spaceId: board, folderId: pinned, role: 'editor', canPublish: true },
      { spaceId: board, folderId: drafts, role: 'editor' },
    ],
  });
  const run = (args: readonly string[]) =>
    cli(home, [...args, '--json'], { passphrase: PASSPHRASE });
  return { alice, lib, trip, packing, route, soup, board, pinned, drafts, home, agentId, run };
}

/** The pages Alice sees in `folderId` of `spaceId`, by title. */
async function titlesIn(
  alice: Awaited<ReturnType<typeof personWithVault>>,
  spaceId: SpaceId,
  folderId: string,
) {
  const tree = await spaceOperations.loadTree(alice.ctx, spaceId);
  return tree.pages.filter((p) => p.parentId === folderId).map((p) => p.title);
}

describe('copying', () => {
  it('copies a page and a folder into another space within its picks', async () => {
    const w = await copyWorld();
    const plan = w.lib.page.pageId;

    const page = await w.run(['page', 'copy', plan, '--space', w.board, '--folder', w.pinned]);
    expect(page.code, page.stdout).toBe(0);
    const copied = page.json();
    expect(copied).toEqual({
      kind: 'page',
      earlier: false,
      source: { spaceId: w.lib.spaceId, nodeId: plan },
      spaceId: w.board,
      nodeId: expect.any(String),
      parentId: w.pinned,
      pages: 1,
      folders: 0,
      unpublished: [],
      links: [],
    });
    // Where the agent may publish, the copy has both versions, written by the agent.
    const at = { spaceId: w.board, pageId: copied.nodeId as PageId };
    const { heads } = await pages.loadPage(w.alice.ctx, at.pageId);
    const open = async (audience: 'draft' | 'published', head: unknown) => {
      const opened = await pages.openRevisionOf(w.alice.ctx, at, audience, head as never);
      const payload = opened.opened.kind === 'current' ? opened.opened.payload : null;
      return { author: opened.record.authorId, markdown: payload?.markdown };
    };
    expect(await open('draft', heads.draftHead)).toEqual({
      author: w.agentId,
      markdown: 'draft words',
    });
    expect(await open('published', heads.publishedHead)).toEqual({
      author: w.agentId,
      markdown: 'published words',
    });

    // Where it may only edit, a published page arrives with its draft
    // alone, and is named. With only --folder, the space is looked up.
    const folder = await w.run(['folder', 'copy', w.trip, '--folder', w.drafts]);
    expect(folder.code, folder.stdout).toBe(0);
    const trip = folder.json();
    expect(trip).toEqual({
      kind: 'folder',
      earlier: false,
      source: { spaceId: w.lib.spaceId, nodeId: w.trip },
      spaceId: w.board,
      nodeId: expect.any(String),
      parentId: w.drafts,
      pages: 2,
      folders: 1,
      unpublished: [{ pageId: expect.any(String), sourceId: w.packing, title: 'Packing' }],
      // Route comes along; Plan stays behind.
      links: [{ kind: 'wikilink', page: 'plan', text: 'Plan', count: 1 }],
    });
    const tree = (await w.run(['tree', '--space', w.board])).json();
    expect(tree.folders).toContainEqual({ id: trip.nodeId, parentId: w.drafts, name: 'Trip' });
    const inTrip = (tree.pages as Record<string, unknown>[])
      .filter((p) => p.parentId === trip.nodeId)
      .map(({ id, title, publishedHead }) => ({ id, title, publishedHead }));
    const [packing] = trip.unpublished as { pageId: string }[];
    expect(inTrip).toEqual(
      expect.arrayContaining([
        { id: packing?.pageId, title: 'Packing', publishedHead: null },
        { id: expect.any(String), title: 'Route', publishedHead: null },
      ]),
    );

    // Without --json, where it went.
    const text = await cli(w.home, ['page', 'copy', w.route, '--folder', w.pinned], {
      passphrase: PASSPHRASE,
    });
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(
      new RegExp(
        `^Copied page ${w.route} to folder ${w.pinned} of space ${w.board}, as page [\\w-]{22}: 1 page and 0 folders\\n$`,
      ),
    );
  }, 120_000);

  it('is refused outside its picks, and where it only reads', async () => {
    const w = await copyWorld();
    const nodes = async () =>
      (await t.db.select({ id: schema.nodes.id }).from(schema.nodes)).map((n) => n.id).sort();
    const before = await nodes();

    const beside = await w.run(['page', 'copy', w.lib.beside.pageId, '--folder', w.pinned]);
    expect(beside.code, beside.stdout).toBe(4);
    const above = ['--space', w.lib.spaceId, '--folder', w.lib.above];
    const into = await w.run(['page', 'copy', w.lib.page.pageId, ...above]);
    expect(into.code, into.stdout).toBe(4);
    // It reads Soup, but only an editor copies.
    const read = await w.run(['page', 'copy', w.soup, '--folder', w.pinned]);
    expect(read.code, read.stdout).toBe(1);
    expect(read.json().error.code).toBe('forbidden');
    expect(read.json().error.message).toContain('allowed to edit');
    expect(read.json().error.message).not.toContain('publish');
    // The server's own words come with it.
    expect(read.json().error.reason).toEqual(expect.any(String));
    // Two shares in that space, so it must be told which.
    const two = await w.run(['page', 'copy', w.lib.page.pageId, '--space', w.lib.spaceId]);
    expect(two.code, two.stdout).toBe(2);
    expect(two.json().error.message).toContain('give --folder');
    const self = await w.run(['folder', 'copy', w.lib.shared, '--folder', w.trip]);
    expect(self.code, self.stdout).toBe(2);

    // Nothing was made, hidden or not.
    expect(await nodes()).toEqual(before);
  }, 120_000);

  it('finishes again when the finish’s answer was lost, and makes a keyed copy once', async () => {
    const w = await copyWorld();
    const to = ['page', 'copy', w.lib.page.pageId, '--space', w.board, '--folder', w.pinned];
    const opened: string[] = [];
    let finishes = 0;
    // How many finishes from now land, but whose answers never come back.
    let lose = 0;
    // Whether finishes never reach the server.
    let drop = false;
    // Whether the server is too busy to finish, for longer than the CLI waits.
    let busy = false;
    // Whether a finish whose answer is lost leaves the server busy after it.
    let thenBusy = false;
    server.hooks.intercept = async (request, forward) => {
      const { pathname } = new URL(request.url);
      if (request.method === 'POST' && pathname === '/api/copies') {
        opened.push(JSON.parse(await request.clone().text()).nodes[0].nodeId);
      }
      const finish = request.method === 'POST' && pathname.endsWith('/finish');
      if (finish && drop) return new Response('gone', { status: 502 });
      if (finish && busy) {
        return Response.json(
          { error: { code: 'rate-limited', message: 'Too many requests' } },
          { status: 429, headers: { 'retry-after': '600' } },
        );
      }
      const res = await forward();
      if (finish) {
        finishes += 1;
        if (lose > 0) {
          lose -= 1;
          if (thenBusy) busy = true;
          return new Response('gone', { status: 502 });
        }
      }
      return res;
    };
    try {
      // The finish is sent again, and answered as the first was.
      lose = 1;
      const found = await w.run(to);
      expect(found.code, found.stdout).toBe(0);
      expect(found.json().nodeId).toBe(opened[0]);
      expect(finishes).toBe(2);
      expect(await titlesIn(w.alice, w.board, w.pinned)).toEqual(['Plan']);

      // No finish is ever answered: with a key, running it again is safe.
      const key = ['--idempotency-key', 'copy-retry-1'];
      lose = Number.POSITIVE_INFINITY;
      const lost = await w.run([...to, ...key]);
      lose = 0;
      expect(lost.code, lost.stdout).toBe(1);
      expect(lost.json().error).toMatchObject({ outcomeUnknown: true });
      expect(lost.json().error.message).toContain('same --idempotency-key');
      const again = await w.run([...to, ...key]);
      expect(again.code, again.stdout).toBe(0);
      expect(again.json().nodeId).toBe(opened[1]);
      expect(opened).toHaveLength(2);
      expect(await titlesIn(w.alice, w.board, w.pinned)).toEqual(['Plan', 'Plan']);

      // No finish ever reaches the server: the copy stays open, hidden, and
      // its nodes' IDs taken, so the same key can't copy until it is gone.
      const unfinished = ['--idempotency-key', 'copy-retry-3'];
      drop = true;
      const dropped = await w.run([...to, ...unfinished]);
      drop = false;
      expect(dropped.code, dropped.stdout).toBe(1);
      expect(dropped.json().error).toMatchObject({ outcomeUnknown: true });
      const refused = await w.run([...to, ...unfinished]);
      expect(refused.code, refused.stdout).toBe(1);
      expect(refused.json().error).toMatchObject({ code: 'unfinished' });
      expect(refused.json().error.message).toContain('new --idempotency-key');
      expect(opened).toHaveLength(4);
      expect(opened[3]).toBe(opened[2]);
      // A new key copies.
      const fresh = await w.run([...to, '--idempotency-key', 'copy-retry-4']);
      expect(fresh.code, fresh.stdout).toBe(0);
      expect(fresh.json().nodeId).toBe(opened[4]);
      expect(await titlesIn(w.alice, w.board, w.pinned)).toEqual(['Plan', 'Plan', 'Plan']);

      // The server stays too busy to finish: no later run could send that
      // finish, so the copy is cancelled, and the same key copies again.
      busy = true;
      const waiting = await w.run([...to, '--idempotency-key', 'copy-retry-5']);
      busy = false;
      expect(waiting.code, waiting.stdout).toBe(1);
      expect(waiting.json().error).toMatchObject({ code: 'busy' });
      expect(waiting.json().error.outcomeUnknown).toBeUndefined();
      expect(await titlesIn(w.alice, w.board, w.pinned)).toEqual(['Plan', 'Plan', 'Plan']);
      const later = await w.run([...to, '--idempotency-key', 'copy-retry-5']);
      expect(later.code, later.stdout).toBe(0);
      expect(later.json().nodeId).toBe(opened[5]);
      expect(await titlesIn(w.alice, w.board, w.pinned)).toEqual(['Plan', 'Plan', 'Plan', 'Plan']);

      // A finish made it, its answer lost, and the next stays busy: the cancel
      // leaves a finished copy be, and the tree shows it made.
      lose = 1;
      thenBusy = true;
      const landed = await w.run(to);
      busy = false;
      thenBusy = false;
      expect(landed.code, landed.stdout).toBe(0);
      expect(landed.json()).toMatchObject({ earlier: false, nodeId: opened.at(-1) });
      expect(await titlesIn(w.alice, w.board, w.pinned)).toHaveLength(5);

      // Every node of a keyed copy is made from the key, so a retry reports the copy's own IDs.
      const trip = ['folder', 'copy', w.trip, '--folder', w.drafts];
      const openings = opened.length + 1;
      const first = await w.run([...trip, '--idempotency-key', 'copy-retry-2']);
      expect(first.code, first.stdout).toBe(0);
      // Only where the earlier copy is: what is in the source now needn't be what it copied.
      const earlier = {
        kind: 'folder',
        earlier: true,
        spaceId: w.board,
        nodeId: first.json().nodeId,
        parentId: w.drafts,
      };
      const retried = await w.run([...trip, '--idempotency-key', 'copy-retry-2']);
      expect(retried.code, retried.stdout).toBe(0);
      expect(retried.json()).toEqual(earlier);
      expect(opened).toHaveLength(openings);
      const [packing] = first.json().unpublished as { pageId: string }[];
      expect(await titlesIn(w.alice, w.board, String(first.json().nodeId))).toEqual(
        expect.arrayContaining(['Packing', 'Route']),
      );
      const { heads } = await pages.loadPage(w.alice.ctx, packing?.pageId as PageId);
      expect(heads.publishedHead).toBeNull();

      // It is found even once the original is gone.
      await pages.deleteNode(w.alice.ctx, { spaceId: w.lib.spaceId, nodeId: w.trip });
      const gone = await w.run([...trip, '--idempotency-key', 'copy-retry-2']);
      expect(gone.code, gone.stdout).toBe(0);
      expect(gone.json()).toEqual(earlier);
      expect(opened).toHaveLength(openings);
    } finally {
      server.hooks.intercept = null;
    }
  }, 120_000);

  it('cancels the copy on Ctrl-C before the finish', async () => {
    const w = await copyWorld();
    const nodes = async () =>
      (await t.db.select({ id: schema.nodes.id }).from(schema.nodes)).map((n) => n.id).sort();
    const before = await nodes();
    let arrived = () => {};
    const sending = new Promise<void>((resolve) => (arrived = resolve));
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    server.hooks.intercept = async (request, forward) => {
      if (
        request.method === 'POST' &&
        /^\/api\/copies\/[^/]+\/records$/.test(new URL(request.url).pathname)
      ) {
        arrived();
        await held;
      }
      return forward();
    };
    const key = ['--idempotency-key', 'copy-stopped'];
    const to = ['folder', 'copy', w.trip, '--folder', w.drafts, ...key, '--json'];
    try {
      const run = start(w.home, to, { passphrase: PASSPHRASE });
      run.child.stdin?.end();
      await sending;
      run.child.kill('SIGINT');
      // The batch being sent is answered; the next step stops.
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      const stopped = await run.done;
      expect(stopped.code, stopped.stdout).toBe(1);
      expect(stopped.json().error).toMatchObject({ code: 'cancelled' });
      expect(await nodes()).toEqual(before);
    } finally {
      server.hooks.intercept = null;
    }
    // Cancelled, so the same key copies.
    const again = await w.run(to.slice(0, -1));
    expect(again.code, again.stdout).toBe(0);
    expect(again.json()).toMatchObject({ earlier: false, pages: 2, folders: 1 });
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
