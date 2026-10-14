import { describe, expect, it } from 'vite-plus/test';
import {
  acceptOwners,
  folderKeyEnvelopeBytes,
  FolderKeyring,
  generateIdentity,
  IdentityId,
  InstallationId,
  keyHash,
  MemoryKeyVersionMarks,
  newFolderKeys,
  openFolderKeys,
  planRotation,
  sealFolderKeys,
  sealRotation,
  ShareId,
  sign,
  SpaceId,
  TrustStore,
  type FolderKeyEnvelope,
  type PrivateIdentity,
  type PublicIdentity,
} from '../src/index.ts';
import { opensAnyone } from './support/anyone.ts';
import { directoryEntry } from './support/testing.ts';
import { opensFor } from '../src/owner-predicates.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const installationId = InstallationId.parse('test-installation');
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const person = (id: string) => generateIdentity({ id: IdentityId.parse(id), kind: 'human' });
// Alice rotates. Bob is a co-owner; Carol an editor and Dave a reader of
// the share; Erin is listed as a member but holds no key; Mallory is the
// server's own.
const alice = person('alice');
const bob = person('bob');
const carol = person('carol');
const dave = person('dave');
const erin = person('erin');
const mallory = person('mallory');
const agent = generateIdentity({ kind: 'agent', installationId, ownerId: carol.public.id });
const directory = [alice, bob, carol, dave, erin, mallory].map((p) => directoryEntry(p.public));
const ref = (p: PrivateIdentity) => ({ id: p.public.id, keyHash: keyHash(p.public) });
const id = (p: PrivateIdentity) => p.public.id;

const v1 = newFolderKeys();
const envelope = (
  sealer: PrivateIdentity,
  recipient: PublicIdentity,
  editor = true,
  keyVersion = 1,
) =>
  sealFolderKeys({
    sealer,
    installationId,
    spaceId,
    shareId,
    keyVersion,
    recipient,
    keys: { draftKey: editor ? v1.draftKey : null, publishedKey: v1.publishedKey },
  });
const served: FolderKeyEnvelope[] = [
  envelope(alice, alice.public),
  envelope(alice, bob.public),
  envelope(alice, carol.public),
  envelope(alice, dave.public, false),
  envelope(alice, agent.public),
  // The server seals version 1 to its own identity.
  envelope(mallory, mallory.public),
];
const members = [carol, dave, erin, mallory].map((p) => ({
  identityId: id(p),
  keyVersion: 1,
}));

// Alice's app: she accepts herself and Bob, the server lists `listed` as
// owners, and she holds version 1 from `sealer`.
const aliceApp = ({
  sealer = alice,
  removed = [] as PrivateIdentity[],
  listed = [alice, bob],
} = {}) => {
  const trust = new TrustStore(installationId);
  trust.pinSelf(alice);
  for (const other of new Set([bob, mallory, sealer, ...listed])) {
    trust.use(directoryEntry(other.public));
  }
  const keyring = new FolderKeyring();
  keyring.add(
    openFolderKeys({
      reader: alice,
      trust,
      installationId,
      envelope: envelope(sealer, alice.public),
      expect: { spaceId, shareId },
      sealers: opensAnyone,
    }),
  );
  const owners = acceptOwners({
    installationId,
    spaceId,
    self: alice.public,
    trust,
    entry: { spaceId, owners: [ref(alice), ref(bob)], removedOwners: removed.map(id) },
    nameRecords: [],
    statements: [],
    envelopes: [],
    listedOwners: listed.map((p) => p.public),
    directory,
  });
  return { trust, keyring, owners, marks: new MemoryKeyVersionMarks() };
};
type Plan = Parameters<typeof planRotation>[0];
const plan = (overrides: Partial<Plan> = {}, app = aliceApp()) =>
  planRotation({
    installationId,
    spaceId,
    shareId,
    currentKeyVersion: 1,
    envelopes: served,
    members,
    directory,
    ...app,
    ...overrides,
  });
const roles = (result: ReturnType<typeof plan>) =>
  Object.fromEntries(result.remaining.map(({ identity, role }) => [identity.id, role]));

describe('planning a rotation (section 7.5)', () => {
  it('keep owners and members who held the version, by role, and leave out the rest', () => {
    const result = plan();
    expect(result.keyVersion).toBe(2);
    expect(roles(result)).toEqual({
      alice: 'editor',
      bob: 'editor',
      carol: 'editor',
      dave: 'reader',
    });
    expect(result.leftOut).toEqual([
      { identityId: id(erin), reason: 'no-envelope' },
      { identityId: id(mallory), reason: 'no-envelope' },
    ]);
    expect(result.removed).toEqual([id(erin), id(mallory)]);
  });

  it('leave out the person removed, and demote by the dialog, not the envelope', () => {
    const removing = plan({ leaveOut: [id(carol)] });
    expect(roles(removing).carol).toBeUndefined();
    expect(removing.leftOut).toContainEqual({ identityId: id(carol), reason: 'left-out' });
    expect(removing.removed).toContain(id(carol));
    const demoting = plan({ demote: [id(carol)] });
    expect(roles(demoting).carol).toBe('reader');
    expect(demoting.demoted).toEqual([id(carol)]);
  });

  it('leave out a member whose key changed and isn’t confirmed', () => {
    const swapped = generateIdentity({ id: carol.public.id, kind: 'human' }).public;
    const app = aliceApp();
    app.trust.use(directoryEntry(carol.public));
    const result = plan(
      {
        directory: [
          ...directory.filter((e) => e.identity.id !== id(carol)),
          directoryEntry(swapped),
        ],
      },
      app,
    );
    expect(result.leftOut).toContainEqual({ identityId: id(carol), reason: 'key-changed' });
    expect(roles(result).carol).toBeUndefined();
  });

  it('let the owner removing Bob rotate from the version Bob sealed, without moving the mark', () => {
    const app = aliceApp({ sealer: bob, removed: [bob] });
    const bobsEnvelopes = served.map((e) =>
      e.recipientId === id(mallory) ? e : resealedBy(bob, e),
    );
    const result = plan({ envelopes: bobsEnvelopes, removing: bob.public }, app);
    expect(roles(result)).toEqual({ alice: 'editor', carol: 'editor', dave: 'reader' });
    expect(app.marks.get(spaceId, shareId)).toBe(0);
    // Without the removal, the same versions are refused.
    expect(() => plan({ envelopes: bobsEnvelopes }, app)).toThrow(code('key-version'));
  });
});

describe('sealing a rotation', () => {
  it('seal the new version to each remaining person, by role, and to nobody else', () => {
    const result = plan();
    const keys = newFolderKeys();
    const sealed = sealRotation({ sealer: alice, installationId, plan: result, keys });
    expect(sealed.map((e) => e.recipientId)).toEqual(['alice', 'bob', 'carol', 'dave']);
    expect(sealed.every((e) => e.keyVersion === 2)).toBe(true);
    const forDave = sealed.find((e) => e.recipientId === id(dave));
    expect(forDave?.draftKey).toBeNull();
    const daveTrust = new TrustStore(installationId);
    daveTrust.use(directoryEntry(alice.public));
    const opened = openFolderKeys({
      reader: dave,
      trust: daveTrust,
      installationId,
      envelope: forDave,
      expect: { spaceId, shareId },
      sealers: opensFor((who) => who.id === id(alice)),
    });
    expect(opened.publishedKey).toEqual(keys.publishedKey);
    expect(opened.draftKey).toBeNull();
  });
});

// `envelope` as `sealer` would have signed it.
function resealedBy(sealer: PrivateIdentity, e: FolderKeyEnvelope): FolderKeyEnvelope {
  const unsigned = { ...e, sealerId: id(sealer), sealerKeyVersion: 1 };
  return { ...unsigned, signature: sign(sealer, folderKeyEnvelopeBytes(installationId, unsigned)) };
}
