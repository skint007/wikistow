// Following a rotation (protocol sections 4.6 and 8.4, #327, PR 3): the
// rotated person opens what was sealed to their earlier key, their contacts'
// apps and agents follow the chain to the new key, and a contact can decline.
import {
  ApiError,
  followOperations as follow,
  generateIdentity,
  inlineVaultCrypto,
  keyHash,
  lookupPeople,
  openAgentSession,
  openSession,
  ownerOperations,
  pageOperations as pages,
  replaceKeysOperations as replaceKeys,
  saveContacts,
  signIdentityRotation,
  spaceKeys,
  type ClientContext,
} from '@wikistow/client';

type PageRef = pages.PageRef;
import { FAST_KDF } from '@wikistow/client/testing';
import { identityRoutes, type RouteDef } from '@wikistow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { asAgent, enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { find, library, shareFolder, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ identityRotation: true });
});
afterAll(() => t.drop());

/** A person with a space, and so a contacts record. */
async function personWithLibrary() {
  const person = await personWithVault(t);
  const lib = await library(person);
  await saveContacts(person.ctx);
  return { person, lib };
}

/** Replace `person`'s keys, keeping `keep`, and open a session at the new key. */
async function rotate(person: Person, keep: readonly string[] = []) {
  const prepared = await replaceKeys.prepareRotation(person.ctx, {
    vault: person.vault,
    crypto: inlineVaultCrypto,
    passphrase: 'a brand new vault passphrase',
    kdf: FAST_KDF,
    keep,
  });
  await replaceKeys.sendRotation(person.api, prepared);
  const ctx = await openSession(person.api, prepared.vault);
  return {
    ctx,
    vault: prepared.vault,
    old: person.vault.identity.public,
    next: prepared.vault.identity.public,
  };
}

const draftOf = async (ctx: ClientContext, page: PageRef) => {
  const { heads } = await pages.loadPage(ctx, page.pageId);
  if (!heads.draftHead) throw new Error('expected a draft');
  return (await pages.openRevisionOf(ctx, page, 'draft', heads.draftHead, { fresh: true })).opened;
};

/** `ctx` with the answers of `route` changed by `change`, as a lying server would. */
function answering(ctx: ClientContext, route: RouteDef, change: (answer: unknown) => unknown) {
  const send = ctx.api.call as unknown as (r: RouteDef, input: unknown) => Promise<unknown>;
  const call = (async (r: RouteDef, input: unknown) => {
    const answer = await send(r, input);
    return r === route ? change(answer) : answer;
  }) as ClientContext['api']['call'];
  return { ...ctx, api: { ...ctx.api, call } };
}

describe('the rotated person', () => {
  it('opens what was sealed to their earlier key, and writes nothing under a version sealed to it', async () => {
    const { person: alice, lib } = await personWithLibrary();
    const { person: bob, lib: theirs } = await personWithLibrary();
    await shareFolder(bob.ctx, {
      spaceId: theirs.spaceId,
      rootId: theirs.shared,
      people: [{ person: await find(bob, alice), role: 'editor', canPublish: false }],
    });
    // What Alice wrote in Bob's share, at her old key.
    await pages.editDraft(alice.ctx, theirs.page, { markdown: 'Alice, before' });

    const { ctx } = await rotate(alice);
    // Her own pages, sealed to her old key.
    expect(await draftOf(ctx, lib.beside)).toMatchObject({ payload: { markdown: '' } });
    expect(await draftOf(ctx, lib.page)).toMatchObject({ payload: { markdown: 'draft words' } });
    // Bob's share, whose keys were sealed to her old key.
    expect(await draftOf(ctx, theirs.page)).toMatchObject({
      payload: { markdown: 'Alice, before' },
    });
    // Those keys only open: she waits for Bob to give her the share at her new key.
    expect(
      await rejection(pages.editDraft(ctx, theirs.page, { markdown: 'under the old keys' })),
    ).toMatch(/missing-key|key-version/);
    // In her own space she writes on, at her new key.
    await pages.editDraft(ctx, lib.beside, { markdown: 'Alice, after' });
    expect(await draftOf(ctx, lib.beside)).toMatchObject({ payload: { markdown: 'Alice, after' } });
  });
});

describe('agents and the history routes', () => {
  it('lets an agent read its own person’s chain, and the people it may look up only', async () => {
    const { person: alice } = await personWithLibrary();
    const agent = await enrolledAgent(t, alice);
    await saveContacts(alice.ctx);
    const { person: carol } = await personWithLibrary();
    const id = alice.vault.identity.public.id;
    const mine = await asAgent(t, agent.token, `/api/identities/${id}/rotations`);
    expect(mine.status).toBe(200);
    expect((await asAgent(t, agent.token, `/api/identities/${id}/versions/1`)).status).toBe(200);
    // Carol wrote nothing it can read.
    const other = carol.vault.identity.public.id;
    for (const path of [
      `/api/identities/${other}/rotations`,
      `/api/identities/${other}/versions/1`,
    ]) {
      expect((await asAgent(t, agent.token, path)).status).toBe(404);
    }
  });

  it('lets an agent read the chain of a person whose agent wrote what it reads', async () => {
    // Carol shares a folder with Alice and with Bob; only Alice's agent writes there.
    const { person: carol, lib } = await personWithLibrary();
    const { person: alice } = await personWithLibrary();
    const { person: bob } = await personWithLibrary();
    await shareFolder(carol.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [
        { person: await find(carol, alice), role: 'editor', canPublish: false },
        { person: await find(carol, bob), role: 'reader', canPublish: false },
      ],
    });
    const pick = { spaceId: lib.spaceId, folderId: lib.shared, canPublish: false };
    const writer = await enrolledAgent(t, alice, { picks: [{ ...pick, role: 'editor' }] });
    await pages.editDraft(writer.ctx, lib.page, { markdown: 'by Alice’s agent' });
    const reader = await enrolledAgent(t, bob, { picks: [{ ...pick, role: 'reader' }] });
    const id = alice.vault.identity.public.id;
    expect((await asAgent(t, reader.token, `/api/identities/${id}/versions/1`)).status).toBe(200);
  });
});

describe('a contact', () => {
  /** Bob, who shared with Alice, so pinned her; then Alice replaces her keys. */
  async function rotatedContact() {
    const { person: alice, lib } = await personWithLibrary();
    const { person: bob, lib: theirs } = await personWithLibrary();
    await shareFolder(bob.ctx, {
      spaceId: theirs.spaceId,
      rootId: theirs.shared,
      people: [{ person: await find(bob, alice), role: 'editor', canPublish: false }],
    });
    await pages.editDraft(alice.ctx, theirs.page, { markdown: 'Alice, before' });
    const rotated = await rotate(alice);
    return { alice, bob, lib, theirs, ...rotated };
  }

  it('follows a valid chain: the pin moves, unchecked, with a notice, and the old key opens only', async () => {
    const { alice, bob, theirs, old, next } = await rotatedContact();
    const id = old.id;
    expect(bob.ctx.trust.check(next).kind).toBe('changed');

    // Lookups side by side follow once, in one contacts write.
    const version = bob.ctx.contacts.book.record?.version ?? 0;
    await Promise.all([1, 2, 3, 4].map(() => lookupPeople(bob.ctx, [id])));
    expect(bob.ctx.contacts.book.record?.version).toBe(version + 1);
    expect(bob.ctx.trust.check(next)).toEqual({ kind: 'pinned', identity: next });
    // Stored, unchecked, by a confirmed write.
    const pin = bob.ctx.contacts.book.payloads.shared.contacts.find((c) => c.identity.id === id);
    expect(pin).toMatchObject({ identity: next, method: 'first-seen' });
    const label = bob.ctx.contacts.book.payloads.private.labels.find((l) => l.id === id);
    expect(label?.keyHash).toBe(keyHash(next));
    // The notice, with the key it came from, until Bob has seen it.
    const [notice] = follow.unseenFollows(bob.ctx);
    expect(notice?.from.identity).toEqual(old);
    expect(notice?.to).toMatchObject({ id, keyHash: keyHash(next) });
    // Both keys, for the contact's details.
    expect(bob.ctx.trust.earlierKeys(id)).toEqual([old]);
    // What Alice wrote before still opens, by her earlier key.
    expect(await draftOf(bob.ctx, theirs.page)).toMatchObject({
      payload: { markdown: 'Alice, before' },
    });
    // Another device of Bob's sees the follow in the record.
    const elsewhere = await openSession(bob.api, bob.vault);
    expect(elsewhere.trust.check(next).kind).toBe('pinned');
    expect(follow.unseenFollows(elsewhere)).toHaveLength(1);
    if (!notice) throw new Error('expected a notice');
    await follow.seeFollow(elsewhere, notice);
    expect(follow.unseenFollows(elsewhere)).toEqual([]);
    // Seen, it still names the key it came from, for details and a decline.
    expect(follow.followsOf(elsewhere)).toMatchObject([{ from: { identity: old }, seen: true }]);
    expect(alice.vault.identity.public).toEqual(old);
  });

  it('writes nothing more under a version the old key sealed, even one opened before it followed', async () => {
    const { person: alice, lib } = await personWithLibrary();
    const { person: bob } = await personWithLibrary();
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [{ person: await find(alice, bob), role: 'editor', canPublish: false }],
    });
    // Bob writes under Alice's version 1 while she is at her old key.
    await pages.editDraft(bob.ctx, lib.page, { markdown: 'Bob, before' });
    const { old } = await rotate(alice);
    await lookupPeople(bob.ctx, [old.id]);
    expect(await rejection(pages.editDraft(bob.ctx, lib.page, { markdown: 'Bob, after' }))).toMatch(
      /missing-key|key-version/,
    );
    // Reading goes on.
    expect(await draftOf(bob.ctx, lib.page)).toMatchObject({
      payload: { markdown: 'Bob, before' },
    });
    // Declining puts back a pin that only opens: still nothing written there.
    const [notice] = follow.unseenFollows(bob.ctx);
    if (!notice) throw new Error('expected a notice');
    await follow.declineFollow(bob.ctx, notice);
    expect(
      await rejection(pages.editDraft(bob.ctx, lib.page, { markdown: 'Bob, declined' })),
    ).toMatch(/missing-key|key-version/);
  });

  it('declines when the server stops serving the chain it followed', async () => {
    const { bob, old, next } = await rotatedContact();
    await lookupPeople(bob.ctx, [old.id]);
    const [notice] = follow.unseenFollows(bob.ctx);
    if (!notice) throw new Error('expected a notice');
    const withheld = answering(bob.ctx, identityRoutes.rotations, () => {
      throw new ApiError(404, 'not-found', 'Not found');
    });
    await follow.declineFollow(withheld, notice);
    expect(bob.ctx.trust.check(next).kind).toBe('removed');
    expect(
      bob.ctx.contacts.book.payloads.shared.contacts.find((c) => c.identity.id === old.id),
    ).toMatchObject({ identity: old });
  });

  it('takes a chain that doesn’t check out, or a fork, as a key change', async () => {
    const { alice, bob, old, next } = await rotatedContact();
    // The server withholds the statement.
    const withheld = answering(bob.ctx, identityRoutes.rotations, (answer) => ({
      ...(answer as object),
      rotations: [],
    }));
    await lookupPeople(withheld, [old.id]);
    expect(bob.ctx.trust.check(next).kind).toBe('changed');
    // Two statements for one key version, both signed with the old key: a fork.
    const other = signIdentityRotation({
      installationId: bob.ctx.installationId,
      from: alice.vault.identity,
      to: generateIdentity({ kind: 'human', id: old.id, keyVersion: 2 }),
      contacts: null,
    });
    const forked = answering(bob.ctx, identityRoutes.rotations, (answer) => {
      const { rotations } = answer as { rotations: Record<string, unknown>[] };
      return { ...(answer as object), rotations: [...rotations, other] };
    });
    await lookupPeople(forked, [old.id]);
    expect(bob.ctx.trust.check(next).kind).toBe('changed');
    expect(follow.unseenFollows(bob.ctx)).toEqual([]);
  });

  it('declines: the pin goes back, nothing is sealed to either key, and no device follows again', async () => {
    const { bob, old, next } = await rotatedContact();
    const before = bob.ctx.contacts.book.payloads.shared.contacts.find(
      (c) => c.identity.id === old.id,
    );
    await lookupPeople(bob.ctx, [old.id]);
    const [notice] = follow.unseenFollows(bob.ctx);
    if (!notice) throw new Error('expected a notice');

    await follow.declineFollow(bob.ctx, notice);
    const { shared, private: own } = bob.ctx.contacts.book.payloads;
    expect(shared.contacts.find((c) => c.identity.id === old.id)).toEqual(before);
    expect(shared.removed.map((r) => r.keyHash)).toContain(keyHash(next));
    expect(shared.extensions['wikistow.declined']).toEqual({
      format: 1,
      entries: [{ id: old.id, keyHash: keyHash(old) }],
    });
    expect(own.labels.find((l) => l.id === old.id)?.keyHash).toBe(keyHash(old));
    expect(follow.unseenFollows(bob.ctx)).toEqual([]);
    // Neither key is sealed to.
    expect(bob.ctx.trust.check(old).kind).toBe('removed');
    expect(bob.ctx.trust.check(next).kind).toBe('removed');

    // Another device reads the decline and follows nothing.
    const elsewhere = await openSession(bob.api, bob.vault);
    await lookupPeople(elsewhere, [old.id]);
    expect(elsewhere.trust.check(next).kind).toBe('removed');
    expect(follow.unseenFollows(elsewhere)).toEqual([]);
  });

  it('warns of spaces where an owner accepted the key it declined, naming them', async () => {
    const { alice, bob, old, next, ctx: aliceNow } = await rotatedContact();
    // Carol's space, which Bob is a member of; Carol adds Alice at her new key.
    const { person: carol, lib } = await personWithLibrary();
    await shareFolder(carol.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [{ person: await find(carol, bob), role: 'reader', canPublish: false }],
    });
    await lookupPeople(bob.ctx, [old.id]);
    await lookupPeople(carol.ctx, [old.id]);
    const found = await find(carol, alice);
    expect(found.identity).toEqual(next);
    await ownerOperations.addCoOwner(carol.ctx, { spaceId: lib.spaceId, person: found });
    await spaceKeys(bob.ctx, lib.spaceId, { refresh: true });
    expect(
      bob.ctx.contacts.book.payloads.shared.spaceOwners
        .find((e) => e.spaceId === lib.spaceId)
        ?.owners.some((o) => o.keyHash === keyHash(next)),
    ).toBe(true);

    const [notice] = follow.unseenFollows(bob.ctx);
    if (!notice) throw new Error('expected a notice');
    const spaces = await follow.declineFollow(bob.ctx, notice);
    expect(spaces).toEqual([{ spaceId: lib.spaceId, addedBy: [carol.vault.identity.public.id] }]);
    expect(aliceNow.identity.public).toEqual(next);
  });
});

describe('an agent', () => {
  it('follows its person’s chain from the key it pinned, and reads their record across it', async () => {
    const { person: alice } = await personWithLibrary();
    // Carol shares a folder with Alice, and Alice's agent picks it.
    const { person: carol, lib } = await personWithLibrary();
    await shareFolder(carol.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [{ person: await find(carol, alice), role: 'editor', canPublish: false }],
    });
    const agent = await enrolledAgent(t, alice, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: false }],
    });
    // An agent Alice doesn't keep, which wrote there before.
    const dropped = await enrolledAgent(t, alice, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: false }],
    });
    await pages.editDraft(dropped.ctx, lib.page, { markdown: 'by the dropped agent' });
    await saveContacts(alice.ctx);
    // The agent's last session, before the rotation.
    const before = await openAgentSession(agent.api, {
      identity: agent.identity,
      person: alice.vault.identity.public,
      ...agent.kept,
    });
    const { old, next } = await rotate(alice, [agent.agentId]);

    const ctx = await openAgentSession(agent.api, {
      identity: agent.identity,
      person: old,
      mark: before.contacts.book.mark,
      ...agent.kept,
    });
    expect(ctx.agent?.person).toEqual(next);
    expect(ctx.agent?.followedFrom).toEqual(old);
    expect(ctx.contacts.book.record?.ownerKeyVersion).toBe(2);
    expect(ctx.trust.earlierKeys(old.id)).toEqual([old]);
    // What Alice sealed to it before, and what her dropped agent wrote, open.
    expect(await draftOf(ctx, lib.page)).toMatchObject({
      payload: { markdown: 'by the dropped agent' },
    });
    // So does it for Carol, once she follows Alice.
    await lookupPeople(carol.ctx, [old.id]);
    const fresh = await openSession(carol.api, carol.vault);
    expect(await draftOf(fresh, lib.page)).toMatchObject({
      payload: { markdown: 'by the dropped agent' },
    });

    // Once it holds the new key, there's nothing more to follow.
    const again = await openAgentSession(agent.api, {
      identity: agent.identity,
      person: next,
      mark: ctx.contacts.book.mark,
      ...agent.kept,
    });
    expect(again.agent?.followedFrom).toBeNull();
  });

  it('opens on a server from before following, which serves agents no history', async () => {
    const { person: alice } = await personWithLibrary();
    const agent = await enrolledAgent(t, alice);
    await saveContacts(alice.ctx);
    const send = agent.api.call as unknown as (r: RouteDef, input: unknown) => Promise<unknown>;
    const older = {
      ...agent.api,
      call: (async (r: RouteDef, input: unknown) => {
        if (r === identityRoutes.rotations) throw new ApiError(404, 'not-found', 'No such route');
        return send(r, input);
      }) as typeof agent.api.call,
    };
    const ctx = await openAgentSession(older, {
      identity: agent.identity,
      person: alice.vault.identity.public,
      ...agent.kept,
    });
    expect(ctx.agent?.followedFrom).toBeNull();
  });

  it('refuses a chain that doesn’t check out', async () => {
    const { person: alice } = await personWithLibrary();
    const agent = await enrolledAgent(t, alice);
    await saveContacts(alice.ctx);
    const { old } = await rotate(alice, [agent.agentId]);
    const send = agent.api.call as unknown as (r: RouteDef, input: unknown) => Promise<unknown>;
    const lying = {
      ...agent.api,
      call: (async (r: RouteDef, input: unknown) => {
        const answer = await send(r, input);
        return r === identityRoutes.rotations ? { ...(answer as object), rotations: [] } : answer;
      }) as typeof agent.api.call,
    };
    const opened = openAgentSession(lying, {
      identity: agent.identity,
      person: old,
      ...agent.kept,
    });
    expect(await rejection(opened)).toBe('identity-key-changed');
  });
});
