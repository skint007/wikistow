import {
  ownerOperations as owners,
  pageOperations as pages,
  sharingOperations as sharing,
  signOwnerStatement,
  spaceOperations,
  type SpaceId,
} from '@wikistow/client';
import { ownerRoutes, OwnerStatement } from '@wikistow/contracts';
import { schema } from '@wikistow/server';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { personWithVault, rejection } from './support/content.ts';
import { createTestApp, type TestApp } from './support/harness.ts';
import { find, invite, library, shareFolder, tampering, type Person } from './support/sharing.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.drop());

/** A library Alice owns, with `Shared` shared with Carol as a reader. */
async function sharedLibrary() {
  const alice = await personWithVault(t);
  const carol = await personWithVault(t);
  const lib = await library(alice);
  const shareId = await shareFolder(alice.ctx, {
    spaceId: lib.spaceId,
    rootId: lib.shared,
    people: [await invite(alice, carol, 'reader')],
  });
  return { alice, carol, lib, shareId };
}

/** Alice adds `bob` as a co-owner, and Bob's app confirms her and names her back. */
async function addAndConfirm(alice: Person, bob: Person, spaceId: SpaceId) {
  await owners.addCoOwner(alice.ctx, { spaceId, person: await find(alice, bob) });
  const adder = await owners.ownerToConfirm(bob.ctx, spaceId);
  if (!adder) throw new Error('expected the co-owner dialog');
  await owners.confirmOwner(bob.ctx, { spaceId, adder });
}

const listed = async (person: Person, spaceId: SpaceId) =>
  (await person.api.call(ownerRoutes.owners, { params: { spaceId } })).owners
    .map((o) => o.identity.id)
    .sort((a, b) => a.localeCompare(b));

const ids = (...people: Person[]) =>
  people.map((p) => p.vault.identity.public.id).sort((a, b) => a.localeCompare(b));

describe('adding a co-owner', () => {
  it('gives them every key, and their app accepts the adder only once they confirm', async () => {
    const { alice, carol, lib, shareId } = await sharedLibrary();
    const bob = await personWithVault(t);
    await owners.addCoOwner(alice.ctx, { spaceId: lib.spaceId, person: await find(alice, bob) });
    expect(await listed(alice, lib.spaceId)).toEqual(ids(alice, bob));

    // Bob's app asks first, and takes no owner action before he answers.
    const adder = await owners.ownerToConfirm(bob.ctx, lib.spaceId);
    expect(adder?.id).toBe(alice.vault.identity.public.id);
    const early = await shareFolder(bob.ctx, {
      spaceId: lib.spaceId,
      rootId: lib.above,
      people: [],
    }).catch((error: Error & { code?: string }) => error);
    expect(early).toMatchObject({ code: 'unaccepted-owner' });
    if (!adder) throw new Error('expected the adder');
    await owners.confirmOwner(bob.ctx, { spaceId: lib.spaceId, adder });
    expect(await owners.ownerToConfirm(bob.ctx, lib.spaceId)).toBeNull();

    // He reads the owner region and the share, drafts included.
    const beside = await pages.loadPage(bob.ctx, lib.beside.pageId);
    expect(beside.heads.draftHead).not.toBeNull();
    const tree = await spaceOperations.loadTree(bob.ctx, lib.spaceId);
    expect(tree.space?.metadata?.opened).toMatchObject({ metadata: { name: expect.any(String) } });
    expect(tree.folders.every((f) => f.metadata !== null)).toBe(true);
    expect(tree.pages.every((p) => p.title !== null)).toBe(true);
    expect(bob.ctx.keyring.keysFor(lib.spaceId, shareId, 1, 'draft')).toHaveLength(1);

    // What either owner writes in the owner region, the other reads.
    await pages.editDraft(bob.ctx, lib.beside, { markdown: 'by Bob' });
    const { heads } = await pages.loadPage(alice.ctx, lib.beside.pageId);
    if (!heads.draftHead) throw new Error('expected a draft');
    const opened = await pages.openRevisionOf(alice.ctx, lib.beside, 'draft', heads.draftHead);
    expect(opened.opened).toMatchObject({ payload: { markdown: 'by Bob' } });
    // Carol is still a member, and not an owner.
    expect((await sharing.sharedWithMe(carol.ctx)).length).toBe(1);
  });

  it('is refused unless the envelopes cover every share version and owner-region record', async () => {
    const { alice, lib } = await sharedLibrary();
    const bob = await personWithVault(t);
    const add = async (change: (body: Record<string, unknown>) => Record<string, unknown>) =>
      rejection(
        owners.addCoOwner(tampering(alice.ctx, ownerRoutes.addOwner, change), {
          spaceId: lib.spaceId,
          person: await find(alice, bob),
        }),
      );
    const list = (body: Record<string, unknown>, key: string) => body[key] as unknown[];
    expect(
      await add((body) => ({ ...body, keyEnvelopes: list(body, 'keyEnvelopes').slice(1) })),
    ).toBe('stale-head');
    expect(
      await add((body) => ({
        ...body,
        metadataEnvelopes: list(body, 'metadataEnvelopes').slice(1),
      })),
    ).toBe('stale-head');
    expect(await add((body) => ({ ...body, folderKeyEnvelopes: [] }))).toBe('recipients-mismatch');
    expect(await listed(alice, lib.spaceId)).toEqual(ids(alice));
  });

  it('takes statements only from an owner', async () => {
    const { alice, carol, lib } = await sharedLibrary();
    const post = (person: Person, statement: OwnerStatement) =>
      rejection(
        person.api.call(ownerRoutes.addStatement, {
          params: { spaceId: lib.spaceId },
          body: { statement },
        }),
      );
    const naming = (signer: Person, owner: Person) =>
      signOwnerStatement({
        signer: signer.ctx.identity,
        installationId: signer.ctx.installationId,
        spaceId: lib.spaceId,
        owner: owner.vault.identity.public,
      });
    expect(await post(carol, naming(carol, alice))).toBe('forbidden');
    expect(await post(alice, naming(alice, alice))).toBe('no error');
  });
});

describe('removing an owner', () => {
  it('rotates every share without them, and leaves them nothing new', async () => {
    const { alice, carol, lib, shareId } = await sharedLibrary();
    const bob = await personWithVault(t);
    await addAndConfirm(alice, bob, lib.spaceId);
    await spaceOperations.loadTree(bob.ctx, lib.spaceId);

    const removal = await owners.planOwnerRemoval(alice.ctx, {
      spaceId: lib.spaceId,
      ownerId: bob.vault.identity.public.id,
    });
    expect(
      removal.rotations.map(({ plan }) =>
        plan.remaining.map((r) => r.identity.id).sort((a, b) => a.localeCompare(b)),
      ),
    ).toEqual([ids(alice, carol)]);
    const removedOwners = () =>
      alice.ctx.contacts.book.payloads.shared.spaceOwners.find((e) => e.spaceId === lib.spaceId)
        ?.removedOwners;
    // Planning records nothing; confirming puts Bob on Alice's removed-owners list.
    expect(removedOwners()).toEqual([]);
    await owners.applyOwnerRemoval(alice.ctx, removal);
    expect(removedOwners()).toEqual([bob.vault.identity.public.id]);
    expect(await listed(alice, lib.spaceId)).toEqual(ids(alice));

    await pages.editDraft(alice.ctx, lib.page, { markdown: 'after Bob' });
    await pages.editDraft(alice.ctx, lib.beside, { markdown: 'after Bob, privately' });
    expect(await rejection(spaceOperations.loadTree(bob.ctx, lib.spaceId))).toBe('not-found');
    expect(await rejection(pages.loadPage(bob.ctx, lib.beside.pageId))).toBe('not-found');
    // Neither the new share version nor the new private draft is sealed to him.
    const toBob = eq(schema.folderKeyEnvelopes.recipientIdentityId, bob.vault.identity.public.id);
    const versions = await t.db
      .select({ keyVersion: schema.folderKeyEnvelopes.keyVersion })
      .from(schema.folderKeyEnvelopes)
      .where(and(eq(schema.folderKeyEnvelopes.shareId, shareId), toBob));
    expect(versions.map((v) => v.keyVersion)).toEqual([1]);
    const { heads } = await pages.loadPage(alice.ctx, lib.beside.pageId);
    const sealedToBob = await t.db
      .select()
      .from(schema.keyEnvelopes)
      .where(
        and(
          eq(schema.keyEnvelopes.subjectId, heads.draftHead ?? ''),
          eq(schema.keyEnvelopes.recipientIdentityId, bob.vault.identity.public.id),
        ),
      );
    expect(sealedToBob).toEqual([]);
    // Carol, who stayed, reads on.
    expect((await sharing.sharedWithMe(carol.ctx)).map((s) => s.share.currentKeyVersion)).toEqual([
      2,
    ]);
  });

  it('records nothing until the owner confirms', async () => {
    const { alice, lib, shareId } = await sharedLibrary();
    const bob = await personWithVault(t);
    await addAndConfirm(alice, bob, lib.spaceId);
    const pending = async () =>
      owners
        .removalPending(alice.ctx, await sharing.ownerKeys(alice.ctx, lib.spaceId))
        .map((owner) => owner.id);
    const plan = () =>
      owners.planOwnerRemoval(alice.ctx, {
        spaceId: lib.spaceId,
        ownerId: bob.vault.identity.public.id,
      });
    // Alice looks at the removal and cancels: her saves and owner actions go on.
    await plan();
    expect(await pending()).toEqual([]);
    expect(await rejection(pages.editDraft(alice.ctx, lib.beside, { markdown: 'kept' }))).toBe(
      'no error',
    );
    expect(await rejection(sharing.rotateKeys(alice.ctx, { spaceId: lib.spaceId, shareId }))).toBe(
      'no error',
    );
  });

  it('takes a re-added owner off the remover’s removed-owners list', async () => {
    const { alice, lib } = await sharedLibrary();
    const bob = await personWithVault(t);
    await addAndConfirm(alice, bob, lib.spaceId);
    await owners.applyOwnerRemoval(
      alice.ctx,
      await owners.planOwnerRemoval(alice.ctx, {
        spaceId: lib.spaceId,
        ownerId: bob.vault.identity.public.id,
      }),
    );
    const removedOwners = () =>
      alice.ctx.contacts.book.payloads.shared.spaceOwners.find((e) => e.spaceId === lib.spaceId)
        ?.removedOwners;
    expect(removedOwners()).toEqual([bob.vault.identity.public.id]);
    await owners.addCoOwner(alice.ctx, { spaceId: lib.spaceId, person: await find(alice, bob) });
    expect(removedOwners()).toEqual([]);
    // Her app seals to him again: her next private save goes to both owners.
    await pages.editDraft(alice.ctx, lib.beside, { markdown: 'for both of us' });
    const { heads } = await pages.loadPage(alice.ctx, lib.beside.pageId);
    const recipients = await t.db
      .select({ id: schema.keyEnvelopes.recipientIdentityId })
      .from(schema.keyEnvelopes)
      .where(eq(schema.keyEnvelopes.subjectId, heads.draftHead ?? ''));
    expect(recipients.map((r) => r.id).sort((a, b) => a.localeCompare(b))).toEqual(ids(alice, bob));
  });

  it('never removes the last owner, and needs one rotation for each share', async () => {
    const { alice, lib } = await sharedLibrary();
    const self = alice.vault.identity.public.id;
    expect(
      await rejection(
        owners
          .planOwnerRemoval(alice.ctx, { spaceId: lib.spaceId, ownerId: self })
          .then((removal) => owners.applyOwnerRemoval(alice.ctx, removal)),
      ),
    ).toBe('last-owner');
    const bob = await personWithVault(t);
    await addAndConfirm(alice, bob, lib.spaceId);
    const removal = await owners.planOwnerRemoval(alice.ctx, {
      spaceId: lib.spaceId,
      ownerId: bob.vault.identity.public.id,
    });
    // A failed request leaves Bob listed and on Alice's removed-owners list:
    // her app takes no other owner action there, and offers only to retry.
    expect(
      await rejection(
        owners.applyOwnerRemoval(
          tampering(alice.ctx, ownerRoutes.removeOwner, (body) => ({ ...body, rotations: [] })),
          removal,
        ),
      ),
    ).toBe('stale-head');
    expect(await listed(alice, lib.spaceId)).toEqual(ids(alice, bob));
    expect(
      await rejection(
        shareFolder(alice.ctx, { spaceId: lib.spaceId, rootId: lib.above, people: [] }),
      ),
    ).toBe('unaccepted-owner');
    expect(await rejection(pages.editDraft(alice.ctx, lib.beside, { markdown: 'x' }))).toBe(
      'unaccepted-owner',
    );
    // The retry is the same removal, prepared again.
    const again = await owners.planOwnerRemoval(alice.ctx, {
      spaceId: lib.spaceId,
      ownerId: bob.vault.identity.public.id,
    });
    await owners.applyOwnerRemoval(alice.ctx, again);
    expect(await listed(alice, lib.spaceId)).toEqual(ids(alice));
    expect(await rejection(pages.editDraft(alice.ctx, lib.beside, { markdown: 'x' }))).toBe(
      'no error',
    );
  });
});

describe('a transfer', () => {
  it('ends with the new owner rotating every share and the old one reading nothing new', async () => {
    const { alice, carol, lib, shareId } = await sharedLibrary();
    const bob = await personWithVault(t);
    await addAndConfirm(alice, bob, lib.spaceId);
    // Alice removes herself, which rotates every share once more.
    await owners.applyOwnerRemoval(
      alice.ctx,
      await owners.planOwnerRemoval(alice.ctx, {
        spaceId: lib.spaceId,
        ownerId: alice.vault.identity.public.id,
      }),
    );
    expect(await listed(bob, lib.spaceId)).toEqual(ids(bob));
    expect(await rejection(spaceOperations.loadTree(alice.ctx, lib.spaceId))).toBe('not-found');

    // Bob's app offers to finish the transfer, rotating away from what Alice knows.
    const keys = await sharing.ownerKeys(bob.ctx, lib.spaceId);
    expect(owners.transferPending(bob.ctx, keys)?.id).toBe(alice.vault.identity.public.id);
    const renewal = await owners.planTransferRenewal(bob.ctx, {
      spaceId: lib.spaceId,
      previousOwner: alice.vault.identity.public.id,
    });
    // Planning seals nothing: Carol is shown as keeping access first.
    expect(renewal.rotations.map(({ plan }) => plan.leftOut)).toEqual([[]]);
    expect((await sharing.listShares(bob.ctx, lib.spaceId))[0]?.currentKeyVersion).toBe(2);
    await owners.finishTransfer(bob.ctx, renewal);
    const [share] = await sharing.listShares(bob.ctx, lib.spaceId);
    expect(share?.currentKeyVersion).toBe(3);
    const bobsOwners = bob.ctx.contacts.book.payloads.shared.spaceOwners.find(
      (e) => e.spaceId === lib.spaceId,
    );
    expect(bobsOwners?.removedOwners).toEqual([alice.vault.identity.public.id]);
    expect(
      owners.transferPending(bob.ctx, await sharing.ownerKeys(bob.ctx, lib.spaceId)),
    ).toBeNull();
    // Retrying finds nothing left to rotate.
    const again = await owners.planTransferRenewal(bob.ctx, {
      spaceId: lib.spaceId,
      previousOwner: alice.vault.identity.public.id,
    });
    expect(again.rotations).toEqual([]);
    await owners.finishTransfer(bob.ctx, again);
    expect((await sharing.listShares(bob.ctx, lib.spaceId))[0]?.currentKeyVersion).toBe(3);

    // Bob and Carol work on; nothing new is sealed to Alice.
    await pages.editDraft(bob.ctx, lib.page, { markdown: 'Bob’s now' });
    await pages.publishPage(bob.ctx, lib.page);
    expect((await pages.loadHistory(carol.ctx, lib.page)).length).toBe(2);
    const toAlice = await t.db
      .select({ keyVersion: schema.folderKeyEnvelopes.keyVersion })
      .from(schema.folderKeyEnvelopes)
      .where(
        and(
          eq(schema.folderKeyEnvelopes.shareId, shareId),
          eq(schema.folderKeyEnvelopes.recipientIdentityId, alice.vault.identity.public.id),
        ),
      );
    // She made version 2 as she left, so knows it, but holds no envelope of it,
    // and version 3 is Bob's.
    expect(toAlice.map((v) => v.keyVersion)).toEqual([1]);
  });
});
