// Shares after a rotation of identity keys (protocol section 4.6, #327, PR 4):
// a member's rotation refuses an owner's share rotation sealed to their old
// key; the owner gives them the share at their new key; the person's own
// shares rotate from versions an earlier key sealed, which count for
// verifying only; and a rotated co-owner is added again.
import {
  groupOperations,
  inlineVaultCrypto,
  lookupPeople,
  openAgentSession,
  openSession,
  ownerOperations,
  pageOperations as pages,
  replaceKeysOperations as replaceKeys,
  rotatedShareOperations as rotated,
  saveContacts,
  sharingOperations as sharing,
  spaceKeys,
  type ClientContext,
} from '@wikistow/client';
import { FAST_KDF } from '@wikistow/client/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { enrolledAgent } from './support/agents.ts';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { find, library, shareFolder, type Person } from './support/sharing.ts';

type PageRef = pages.PageRef;

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

const shareOf = async (ctx: ClientContext, spaceId: Parameters<typeof sharing.listShares>[1]) => {
  const [share] = await sharing.listShares(ctx, spaceId);
  if (!share) throw new Error('expected a share');
  return share;
};

/** Bob's space shared with Alice, as an editor. */
async function aliceInBobsShare() {
  const { person: alice } = await personWithLibrary();
  const { person: bob, lib } = await personWithLibrary();
  await shareFolder(bob.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [{ person: await find(bob, alice), role: 'editor', canPublish: false }],
  });
  return { alice, bob, lib };
}

describe('a member who replaced their keys', () => {
  it('makes an owner’s rotation planned before it fail, and waits in the next one', async () => {
    const { alice, bob, lib } = await aliceInBobsShare();
    const id = alice.vault.identity.public.id;
    // Bob's app works out a rotation while Alice is at her first key.
    const planned = await sharing.planShareRotation(bob.ctx, {
      spaceId: lib.spaceId,
      shareId: (await shareOf(bob.ctx, lib.spaceId)).shareId,
    });
    expect(planned.plan.remaining.map((r) => r.identity.id)).toContain(id);
    const { next } = await rotate(alice);
    // Sealed to the key she replaced: refused, whatever app sent it.
    expect(await rejection(sharing.applyShareRotation(bob.ctx, planned))).toBe('stale-head');

    // Worked out again, she waits, kept as a member, sealed nothing new.
    await lookupPeople(bob.ctx, [id]);
    const share = await shareOf(bob.ctx, lib.spaceId);
    const again = await sharing.planShareRotation(bob.ctx, {
      spaceId: lib.spaceId,
      shareId: share.shareId,
    });
    expect(again.plan.leftOut).toEqual([{ identityId: id, reason: 'replaced-keys' }]);
    expect(again.plan.offers).toMatchObject([{ identityId: id, reason: 'replaced-keys' }]);
    expect(again.plan.waiting).toEqual([id]);
    expect(again.plan.removed).toEqual([]);
    await sharing.applyShareRotation(bob.ctx, again);
    const after = await shareOf(bob.ctx, lib.spaceId);
    expect(after.currentKeyVersion).toBe(share.currentKeyVersion + 1);
    expect(after.members).toMatchObject([{ identityId: id, keyVersion: 1 }]);
    // Bob sees her waiting, as having replaced her keys.
    const waiting = await groupOperations.loadWaiting(bob.ctx);
    const hers = waiting.find((w) => w.person.identity.id === id);
    expect(hers && rotated.replacedKeys(hers)).toBe(true);
    expect(hers?.keyChanged).toBe(false);
    expect(hers?.person.identity).toEqual(next);
  });

  it('gets the share at her new key with Rotate keys and give access, and nothing else', async () => {
    const { alice, bob, lib } = await aliceInBobsShare();
    const id = alice.vault.identity.public.id;
    await pages.editDraft(alice.ctx, lib.page, { markdown: 'Alice, before' });
    const { vault } = await rotate(alice);
    await lookupPeople(bob.ctx, [id]);
    const [entry] = await lookupPeople(bob.ctx, [id]);
    if (!entry) throw new Error('expected Alice in the directory');

    // Sharing again would seal versions her old key holds: the server refuses.
    const share = await shareOf(bob.ctx, lib.spaceId);
    expect(
      await rejection(
        sharing.addMember(bob.ctx, {
          spaceId: lib.spaceId,
          shareId: share.shareId,
          person: { ...entry, foundBy: null },
          role: 'editor',
        }),
      ),
    ).toBe('recipients-mismatch');
    // So does a rotation that gives her the share at a key she doesn't hold.
    const plans = await rotated.planRekey(bob.ctx, { spaceId: lib.spaceId, person: entry });
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan.rekeyed).toEqual([id]);
    await rotated.applyRekey(bob.ctx, plans);
    const after = await shareOf(bob.ctx, lib.spaceId);
    expect(after.members).toMatchObject([{ identityId: id, keyVersion: 2, role: 'editor' }]);
    expect(await groupOperations.loadWaiting(bob.ctx)).toEqual([]);

    // Alice opens it at her new key, history included, and writes again.
    const fresh = await openSession(alice.api, vault);
    expect(await draftOf(fresh, lib.page)).toMatchObject({
      payload: { markdown: 'Alice, before' },
    });
    await pages.editDraft(fresh, lib.page, { markdown: 'Alice, after' });
    expect(await draftOf(bob.ctx, lib.page)).toMatchObject({
      payload: { markdown: 'Alice, after' },
    });
  });

  it('can’t be named rekeyed, waiting or sealed to by someone the server lists as unchanged', async () => {
    const { alice, bob, lib } = await aliceInBobsShare();
    const id = alice.vault.identity.public.id;
    const share = await shareOf(bob.ctx, lib.spaceId);
    const planned = await sharing.planShareRotation(bob.ctx, {
      spaceId: lib.spaceId,
      shareId: share.shareId,
    });
    // Alice didn't replace her keys: she can't be rekeyed.
    const rekeyed = { ...planned, plan: { ...planned.plan, rekeyed: [id] } };
    expect(await rejection(sharing.applyShareRotation(bob.ctx, rekeyed))).toBe(
      'recipients-mismatch',
    );
    // Waiting, with an envelope anyway: the envelopes go to exactly who's listed.
    const waits = { ...planned, plan: { ...planned.plan, waiting: [id] } };
    expect(await rejection(sharing.applyShareRotation(bob.ctx, waits))).toBe('recipients-mismatch');
  });
});

describe('an agent of a member who replaced their keys', () => {
  it('writes nothing in a share its person waits in', async () => {
    const { alice, bob, lib } = await aliceInBobsShare();
    const agent = await enrolledAgent(t, alice, {
      picks: [{ spaceId: lib.spaceId, folderId: lib.shared, role: 'editor', canPublish: false }],
    });
    await saveContacts(alice.ctx);
    const before = await openAgentSession(agent.api, {
      identity: agent.identity,
      person: alice.vault.identity.public,
      ...agent.kept,
    });
    await pages.editDraft(before, lib.page, { markdown: 'the agent, before' });
    const { ctx, old } = await rotate(alice, [agent.agentId]);
    const session = await openAgentSession(agent.api, {
      identity: agent.identity,
      person: old,
      mark: before.contacts.book.mark,
      ...agent.kept,
    });
    // It reads what it had; it writes where Alice's app writes, which is nowhere here.
    expect(await draftOf(session, lib.page)).toMatchObject({
      payload: { markdown: 'the agent, before' },
    });
    expect(
      await rejection(pages.editDraft(session, lib.page, { markdown: 'the agent, after' })),
    ).toMatch(/missing-key|key-version/);
    expect(await rejection(pages.editDraft(ctx, lib.page, { markdown: 'Alice, after' }))).toMatch(
      /missing-key|key-version/,
    );
    // Bob still writes there.
    await pages.editDraft(bob.ctx, lib.page, { markdown: 'Bob, after' });
  });
});

describe('the person’s own shares', () => {
  it('rotate from a version their earlier key sealed, which counts for verifying only', async () => {
    const { person: alice, lib } = await personWithLibrary();
    const { person: dave } = await personWithLibrary();
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [{ person: await find(alice, dave), role: 'editor', canPublish: false }],
    });
    const { ctx } = await rotate(alice);
    const daveId = dave.vault.identity.public.id;

    // The share's version was sealed by her old key: she writes nothing under it.
    expect(
      await rejection(pages.editDraft(ctx, lib.page, { markdown: 'under the old keys' })),
    ).toMatch(/missing-key|key-version/);
    const [finishing] = await rotated.planFinishing(ctx);
    expect(finishing?.spaceId).toBe(lib.spaceId);
    expect(finishing?.failed).toEqual([]);
    const [planned] = finishing?.rotations ?? [];
    if (!planned) throw new Error('expected a rotation to finish');
    // Dave got access only through her old key: offered unticked, and waits if left so.
    expect(planned.plan.offers).toMatchObject([
      { identityId: daveId, reason: 'old-key', role: 'reader' },
    ]);
    expect(planned.plan.waiting).toEqual([daveId]);
    expect(planned.plan.remaining.map((r) => r.identity.id)).toEqual([ctx.identity.public.id]);

    // Ticked, he keeps it as a reader.
    await rotated.applyWithTicks(ctx, planned, [{ identityId: daveId, role: 'reader' }]);
    const share = await shareOf(ctx, lib.spaceId);
    expect(share.members).toMatchObject([{ identityId: daveId, role: 'reader' }]);
    // Done: nothing is left, and she writes under the new version.
    expect(await rotated.planFinishing(ctx)).toEqual([]);
    await pages.editDraft(ctx, lib.page, { markdown: 'Alice, after' });
    expect(await draftOf(ctx, lib.page)).toMatchObject({ payload: { markdown: 'Alice, after' } });
  });

  it('left unticked, keep the member waiting, listed for Give access', async () => {
    const { person: alice, lib } = await personWithLibrary();
    const { person: dave } = await personWithLibrary();
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [{ person: await find(alice, dave), role: 'editor', canPublish: false }],
    });
    // Dave opens it before Alice replaces her keys, accepting her by first sight.
    expect(await draftOf(dave.ctx, lib.page)).toMatchObject({
      payload: { markdown: 'draft words' },
    });
    const { ctx } = await rotate(alice);
    const [finishing] = await rotated.planFinishing(ctx);
    const [planned] = finishing?.rotations ?? [];
    if (!planned) throw new Error('expected a rotation to finish');
    await rotated.applyWithTicks(ctx, planned);
    const daveId = dave.vault.identity.public.id;
    const share = await shareOf(ctx, lib.spaceId);
    expect(share.members).toMatchObject([{ identityId: daveId, role: 'editor', keyVersion: 1 }]);
    const waiting = await groupOperations.loadWaiting(ctx);
    expect(waiting).toMatchObject([
      { spaceId: lib.spaceId, person: { identity: { id: daveId } }, shares: [{ holds: null }] },
    ]);
    // He reads what he had, and opens nothing new: Alice owns the space alone.
    expect(await draftOf(dave.ctx, lib.page)).toMatchObject({
      payload: { markdown: 'draft words' },
    });
    expect(await rotated.ownedSpaces(ctx)).toContainEqual({ spaceId: lib.spaceId, alone: true });
  });
});

describe('a rotated co-owner', () => {
  it('is named to the other owner, who adds them again, after which both write', async () => {
    const { person: alice, lib } = await personWithLibrary();
    const { person: olive } = await personWithLibrary();
    await shareFolder(alice.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.shared,
      people: [],
    });
    await ownerOperations.addCoOwner(alice.ctx, {
      spaceId: lib.spaceId,
      person: await find(alice, olive),
    });
    const adder = await ownerOperations.ownerToConfirm(olive.ctx, lib.spaceId);
    if (!adder) throw new Error('expected Olive to confirm Alice');
    await ownerOperations.confirmOwner(olive.ctx, { spaceId: lib.spaceId, adder });

    const { ctx, vault, next } = await rotate(alice);
    // Alice's app finishes: the share moves to a version her new key sealed.
    const [finishing] = await rotated.planFinishing(ctx);
    for (const planned of finishing?.rotations ?? []) await rotated.applyWithTicks(ctx, planned);

    // Olive's app follows her, names her, and seals nothing until she adds her again.
    const keys = await spaceKeys(olive.ctx, lib.spaceId, { refresh: true });
    const toAdd = rotated.ownersToAddAgain(olive.ctx, keys);
    expect(toAdd.map((o) => o.identity)).toEqual([next]);
    expect(
      await rejection(
        sharing.rotateKeys(olive.ctx, {
          spaceId: lib.spaceId,
          shareId: (await shareOf(olive.ctx, lib.spaceId)).shareId,
        }),
      ),
    ).toMatch(/unaccepted-owner|key-version/);
    await ownerOperations.addCoOwner(olive.ctx, {
      spaceId: lib.spaceId,
      person: { ...toAdd[0]!, foundBy: null },
    });
    const after = await spaceKeys(olive.ctx, lib.spaceId, { refresh: true });
    expect(rotated.ownersToAddAgain(olive.ctx, after)).toEqual([]);
    // Olive writes under the version Alice's new key sealed.
    await pages.editDraft(olive.ctx, lib.page, { markdown: 'Olive, after' });

    // Alice confirms who added her again, and writes there too.
    const fresh = await openSession(alice.api, vault);
    const again = await ownerOperations.ownerToConfirm(fresh, lib.spaceId);
    expect(again?.id).toBe(olive.vault.identity.public.id);
    if (again) await ownerOperations.confirmOwner(fresh, { spaceId: lib.spaceId, adder: again });
    expect(await draftOf(fresh, lib.page)).toMatchObject({ payload: { markdown: 'Olive, after' } });
    await pages.editDraft(fresh, lib.page, { markdown: 'Alice, after' });
  });
});
