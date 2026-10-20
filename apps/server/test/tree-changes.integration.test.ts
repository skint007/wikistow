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
