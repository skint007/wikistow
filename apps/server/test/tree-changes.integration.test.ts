import {
  pageOperations as pages,
  spaceOperations,
  watchTreeChanges,
  type SpaceId,
} from '@wikistow/client';
import { listenForTreeChanges } from '@wikistow/server';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { PASSWORD } from './support/accounts.ts';
import { personWithVault } from './support/content.ts';
import { openCopy } from './support/copies.ts';
import { Browser, createTestApp, type TestApp } from './support/harness.ts';
import { invite, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
let listening: Awaited<ReturnType<typeof listenForTreeChanges>>;
beforeAll(async () => {
  t = await createTestApp();
  listening = await listenForTreeChanges(t.config.databaseUrl, t.treeChanges.changed);
});
afterAll(async () => {
  t.treeChanges.close();
  await listening.close();
  await t.drop();
});

// The spaces `person`'s app hears of, in order, once its stream is open.
async function hearing(person: Person, signal: AbortSignal) {
  const heard: SpaceId[] = [];
  const { promise: open, resolve } = Promise.withResolvers<void>();
  void watchTreeChanges({
    fetch: async (url, init) => {
      const response = await person.browser.fetch(url, init);
      if (response.ok) resolve();
      return response;
    },
    signal,
    onChange: (spaceIds) => heard.push(...spaceIds),
    onMissed: () => {},
  });
  await open;
  return heard;
}

const SOON = { timeout: 5_000 };

it('tells everyone who sees some of a space that its tree changed, and nobody else', async () => {
  const owner = await personWithVault(t);
  const [member, outsider] = await Promise.all([personWithVault(t), personWithVault(t)]);
  const lib = await library(owner);
  await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, member, 'reader')],
  });
  const elsewhere = await spaceOperations.createSpace(outsider.ctx, { name: 'Elsewhere' });
  const stop = new AbortController();
  try {
    const [byOwner, byMember, byOutsider] = await Promise.all([
      hearing(owner, stop.signal),
      hearing(member, stop.signal),
      hearing(outsider, stop.signal),
    ]);
    const folder = () =>
      spaceOperations.createFolder(outsider.ctx, {
        spaceId: elsewhere,
        parentId: null,
        name: 'Notes',
      });

    await folder();
    await expect.poll(() => byOutsider, SOON).toContain(elsewhere);
    const before = byOutsider.length;
    // The owner sees all of the space, and the member only the shared folder.
    await pages.createPage(owner.ctx, { spaceId: lib.spaceId, parentId: lib.shared, title: 'New' });
    await expect.poll(() => byOwner, SOON).toContain(lib.spaceId);
    await expect.poll(() => byMember, SOON).toContain(lib.spaceId);
    // Heard in order, so the outsider's second change comes after anything
    // they could have heard of the owner's.
    await folder();
    await expect.poll(() => byOutsider.length, SOON).toBeGreaterThan(before);
    expect(new Set(byOutsider)).toEqual(new Set([elsewhere]));
    expect([...byOwner, ...byMember]).not.toContain(elsewhere);

    // A stream lasts only as long as its session.
    const other = new Browser(t.app);
    const signIn = { email: owner.email, password: PASSWORD };
    expect(
      (await other.request('/api/auth/sign-in/email', { method: 'POST', json: signIn })).status,
    ).toBe(200);
    const bySignedOut = await hearing({ ...owner, browser: other }, stop.signal);
    expect((await other.request('/api/auth/sign-out', { method: 'POST', json: {} })).status).toBe(
      200,
    );
    const ownerHeard = byOwner.length;
    await pages.createPage(owner.ctx, {
      spaceId: lib.spaceId,
      parentId: lib.shared,
      title: 'Later',
    });
    await expect.poll(() => byOwner.length, SOON).toBeGreaterThan(ownerHeard);
    expect(bySignedOut).toEqual([]);

    // Deleting the shared folder shuts the member out, and they still hear
    // of it, so their sidebar drops it.
    const memberHeard = byMember.length;
    await pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: lib.shared });
    await expect.poll(() => byMember.slice(memberHeard), SOON).toContain(lib.spaceId);
  } finally {
    stop.abort();
  }
});

it('tells someone given access and shut out again before either is told', async () => {
  const [owner, member] = await Promise.all([personWithVault(t), personWithVault(t)]);
  const lib = await library(owner);
  const stop = new AbortController();
  try {
    const [byOwner, byMember] = await Promise.all([
      hearing(owner, stop.signal),
      hearing(member, stop.signal),
    ]);
    // Once the owner hears of a change made now, the library's own changes
    // are told, and the share starts the next gathering.
    await pages.createPage(owner.ctx, { spaceId: lib.spaceId, parentId: null, title: 'New' });
    await expect.poll(() => byOwner, SOON).toContain(lib.spaceId);
    await shareFolder(owner.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [await invite(owner, member, 'reader')],
    });
    await pages.deleteNode(owner.ctx, { spaceId: lib.spaceId, nodeId: lib.shared });
    await expect.poll(() => byMember, SOON).toContain(lib.spaceId);
  } finally {
    stop.abort();
  }
});

it('tells both spaces when a move between them finishes', async () => {
  const [owner, fromMember, toMember] = await Promise.all([
    personWithVault(t),
    personWithVault(t),
    personWithVault(t),
  ]);
  const lib = await library(owner);
  await shareFolder(owner.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(owner, fromMember, 'reader')],
  });
  const board = await spaceOperations.createSpace(owner.ctx, { name: 'Board' });
  const pinned = await spaceOperations.createFolder(owner.ctx, {
    spaceId: board,
    parentId: null,
    name: 'Pinned',
  });
  await shareFolder(owner.ctx, {
    spaceId: board,
    rootId: pinned,
    people: [await invite(owner, toMember, 'reader')],
  });
  // Opened and sent before anyone listens: hidden nodes name no space.
  const move = await openCopy(owner.ctx, {
    kind: 'move',
    from: lib.spaceId,
    nodeId: lib.shared,
    to: board,
    parentId: pinned,
  });
  await move.open();
  await move.send();
  const stop = new AbortController();
  try {
    const [byFrom, byTo] = await Promise.all([
      hearing(fromMember, stop.signal),
      hearing(toMember, stop.signal),
    ]);
    await move.finish();
    // The source's member loses the folder, and the destination's gains it.
    await expect.poll(() => byFrom, SOON).toContain(lib.spaceId);
    await expect.poll(() => byTo, SOON).toContain(board);
  } finally {
    stop.abort();
  }
});

it('tells nobody of a copy opened, sent and cancelled while they listen', async () => {
  const [owner, toMember] = await Promise.all([personWithVault(t), personWithVault(t)]);
  const lib = await library(owner);
  const board = await spaceOperations.createSpace(owner.ctx, { name: 'Board' });
  const pinned = await spaceOperations.createFolder(owner.ctx, {
    spaceId: board,
    parentId: null,
    name: 'Pinned',
  });
  await shareFolder(owner.ctx, {
    spaceId: board,
    rootId: pinned,
    people: [await invite(owner, toMember, 'reader')],
  });
  const scratch = await spaceOperations.createSpace(owner.ctx, { name: 'Scratch' });
  const theirs = await spaceOperations.createSpace(toMember.ctx, { name: 'Theirs' });
  const stop = new AbortController();
  try {
    const [byOwner, byTo] = await Promise.all([
      hearing(owner, stop.signal),
      hearing(toMember, stop.signal),
    ]);
    const copy = await openCopy(owner.ctx, {
      from: lib.spaceId,
      nodeId: lib.shared,
      to: board,
      parentId: pinned,
    });
    await copy.open();
    await copy.send();
    await copy.cancel();
    // A change each hears afterwards, in order, so anything the copy told them came first.
    await spaceOperations.createFolder(owner.ctx, { spaceId: scratch, parentId: null, name: 'A' });
    await spaceOperations.createFolder(toMember.ctx, {
      spaceId: theirs,
      parentId: null,
      name: 'B',
    });
    await expect.poll(() => byOwner, SOON).toContain(scratch);
    await expect.poll(() => byTo, SOON).toContain(theirs);
    expect(byOwner).not.toContain(board);
    expect(byTo).not.toContain(board);
  } finally {
    stop.abort();
  }
});
