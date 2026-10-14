import { describe, expect, it } from 'vite-plus/test';
import {
  acceptOwners,
  generateIdentity,
  IdentityId,
  InstallationId,
  keyHash,
  MetadataRevisionId,
  newFolderKeys,
  newSpaceMetadata,
  agentOwners,
  sealFolderKeys,
  sealMetadata,
  sealMetadataV2,
  ShareId,
  signOwnerStatement,
  SpaceId,
  TrustStore,
  type OwnerStatement,
  type PrivateIdentity,
  type PublicIdentity,
  type SpaceOwners,
} from '../src/index.ts';
import { directoryEntry } from './support/testing.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const installationId = InstallationId.parse('test-installation');
const spaceId = SpaceId.parse('space');
const person = (id: string) => generateIdentity({ id: IdentityId.parse(id), kind: 'human' });
const alice = person('alice');
const bob = person('bob');
const carol = person('carol');
const dave = person('dave');
// An identity of the server's own, listed in the directory like anyone else.
const mallory = person('mallory');
const everyone = [alice, bob, carol, dave, mallory];
const directory = everyone.map((p) => directoryEntry(p.public));
const ref = (p: PrivateIdentity) => ({ id: p.public.id, keyHash: keyHash(p.public) });

const statement = (signer: PrivateIdentity, owner: PrivateIdentity) =>
  signOwnerStatement({ signer, installationId, spaceId, owner: owner.public });
const envelope = (sealer: PrivateIdentity, recipient: PrivateIdentity, share: string, v = 1) =>
  sealFolderKeys({
    sealer,
    installationId,
    spaceId,
    shareId: ShareId.parse(share),
    keyVersion: v,
    recipient: recipient.public,
    keys: newFolderKeys(),
  });
const nameRecord = (author: PrivateIdentity, basedOn: string | null = null, v2 = true) => {
  const target = {
    installationId,
    spaceId,
    subjectKind: 'space' as const,
    subjectId: spaceId,
    metadataRevisionId: MetadataRevisionId.parse(`name-${author.public.id}`),
    basedOn: basedOn === null ? null : MetadataRevisionId.parse(basedOn),
  };
  const write = { author, target, metadata: newSpaceMetadata('Space'), recipients: [] };
  const { record, signature } = (v2 ? sealMetadataV2(write) : sealMetadata(write)).metadata;
  return { record, signature };
};

type Served = {
  entry?: SpaceOwners;
  nameRecords?: unknown[];
  statements?: OwnerStatement[];
  envelopes?: unknown[];
  listedOwners?: PublicIdentity[];
  confirmedAdder?: { id: string; keyHash: string };
};
const acceptedBy = (self: PrivateIdentity, served: Served = {}, trust = trustOf(self)) =>
  acceptOwners({
    installationId,
    spaceId,
    self: self.public,
    trust,
    entry: served.entry,
    nameRecords: served.nameRecords ?? [],
    statements: served.statements ?? [],
    envelopes: served.envelopes ?? [],
    listedOwners: served.listedOwners ?? [],
    directory,
    ...(served.confirmedAdder && { confirmedAdder: served.confirmedAdder }),
  });
const trustOf = (self: PrivateIdentity) => {
  const trust = new TrustStore(installationId);
  trust.pinSelf(self);
  return trust;
};
const entryOf = (owners: PrivateIdentity[], removed: PrivateIdentity[] = []): SpaceOwners => ({
  spaceId,
  owners: owners.map(ref),
  removedOwners: removed.map((p) => p.public.id),
});

describe('accepted owners (section 6.5)', () => {
  it('accept the creator from their own first name record, v1 or v2', () => {
    for (const record of [nameRecord(alice), nameRecord(alice, null, false)]) {
      const owners = acceptedBy(alice, { nameRecords: [record] });
      expect(owners.opens(alice.public)).toBe(true);
      expect(owners.changes).toEqual([{ kind: 'accept-owner', spaceId, owner: ref(alice) }]);
    }
  });

  it('accept a member’s first sight from statements, then envelopes by share and version', () => {
    const fromEnvelopes = acceptedBy(carol, {
      envelopes: [
        envelope(bob, carol, 'b'),
        envelope(dave, carol, 'a', 2),
        envelope(alice, carol, 'a'),
      ],
    });
    expect(fromEnvelopes.opens(alice.public)).toBe(true);
    expect([bob, dave].some((p) => fromEnvelopes.opens(p.public))).toBe(false);
    // A statement naming carol comes before every envelope.
    const fromStatement = acceptedBy(carol, {
      statements: [statement(bob, carol)],
      envelopes: [envelope(alice, carol, 'a')],
    });
    expect(fromStatement.opens(bob.public)).toBe(true);
    expect(fromStatement.opens(alice.public)).toBe(false);
  });

  it('follow statements from accepted owners, as far as they reach', () => {
    const owners = acceptedBy(carol, {
      entry: entryOf([alice]),
      // Served out of order: the closure repeats until nothing more is accepted.
      statements: [statement(bob, dave), statement(alice, bob)],
    });
    expect([alice, bob, dave].every((p) => owners.opens(p.public))).toBe(true);
    expect(owners.changes.map((c) => c.kind === 'accept-owner' && c.owner.id)).toEqual([
      bob.public.id,
      dave.public.id,
    ]);
  });

  it('never accept an owner the server invents', () => {
    const invented = {
      entry: entryOf([alice]),
      statements: [
        statement(mallory, mallory),
        statement(mallory, carol),
        statement(mallory, bob),
        // Alice's statement, relabelled to name mallory.
        { ...statement(alice, bob), owner: { ...ref(mallory), keyVersion: 1 } },
      ],
      envelopes: [envelope(mallory, carol, '0')],
      listedOwners: [alice.public, mallory.public],
    };
    const owners = acceptedBy(carol, invented);
    expect(owners.opens(mallory.public)).toBe(false);
    expect(owners.writes(mallory.public)).toBe(false);
    expect(owners.opens(bob.public)).toBe(false);
    expect(() => owners.sealingOwners()).toThrow(code('unaccepted-owner'));
  });

  it('ask a new co-owner to confirm their adder before accepting anyone', () => {
    const served = {
      statements: [statement(alice, bob)],
      // Listed as an owner, bob takes no first sight from envelopes.
      envelopes: [envelope(mallory, bob, '0')],
      listedOwners: [alice.public, bob.public],
    };
    const before = acceptedBy(bob, served);
    expect(before.adderToConfirm).toEqual(alice.public);
    expect(before.opens(alice.public)).toBe(false);
    expect(before.opens(mallory.public)).toBe(false);
    expect(() => before.sealingOwners()).toThrow(code('unaccepted-owner'));

    const confirmed = acceptedBy(bob, { ...served, confirmedAdder: ref(alice) });
    expect(confirmed.adderToConfirm).toBeNull();
    // Alice by the dialog, and bob himself through her statement.
    expect([alice, bob].every((p) => confirmed.opens(p.public))).toBe(true);
    expect(confirmed.adder).toEqual(alice.public);
    expect(confirmed.sealingOwners()).toEqual([alice.public, bob.public]);
  });

  it('keep a removed owner for opening only, and their statements for nothing', () => {
    const owners = acceptedBy(carol, {
      entry: entryOf([alice, bob], [bob]),
      statements: [statement(bob, dave), statement(alice, bob)],
      listedOwners: [alice.public, bob.public],
    });
    expect(owners.opens(bob.public)).toBe(true);
    expect(owners.writes(bob.public)).toBe(false);
    expect(owners.writes(alice.public)).toBe(true);
    expect(owners.opens(dave.public)).toBe(false);
    // While the server still lists the removed owner, only the removal itself may go on.
    expect(() => owners.sealingOwners()).toThrow(code('unaccepted-owner'));
    expect(owners.sealingOwners({ removing: bob.public.id })).toEqual([alice.public]);
  });

  it('let an agent write only under versions its own person sealed, and never seal', () => {
    // Bob, the person, isn't an owner: his agent still writes under what he sealed.
    const owners = agentOwners({ entry: entryOf([alice]), person: bob.public });
    expect(owners.opens(alice.public)).toBe(true);
    expect(owners.opens(bob.public)).toBe(false);
    expect(owners.writes(bob.public)).toBe(true);
    expect(owners.writes(alice.public)).toBe(false);
    // Bob's ID at keys other than the ones the agent pinned counts for nothing.
    expect(owners.writes({ ...mallory.public, id: bob.public.id })).toBe(false);
    expect(() => owners.sealingOwners()).toThrow(
      expect.objectContaining({ code: 'unaccepted-owner' }),
    );
  });
});
