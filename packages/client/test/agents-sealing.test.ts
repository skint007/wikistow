import { describe, expect, it } from 'vite-plus/test';
import {
  enrollAgent,
  enrollmentFingerprint,
  FolderKeyring,
  generateIdentity,
  IdentityId,
  InstallationId,
  newFolderKeys,
  openFolderKeys,
  sealForAgent,
  ShareId,
  SpaceId,
  TrustStore,
  type OwnAgent,
  type PrivateIdentity,
} from '../src/index.ts';
import { opensFor, writesFor } from '../src/owner-predicates.ts';

const installationId = InstallationId.parse('test-installation');
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const otherShare = ShareId.parse('other-share');
const person = (id: string) => generateIdentity({ id: IdentityId.parse(id), kind: 'human' });
// Alice owns the space; Carol, a member, enrolled an agent. Bob is an owner
// Carol's app doesn't accept for writing.
const alice = person('alice');
const bob = person('bob');
const carol = person('carol');
const agent = generateIdentity({ kind: 'agent', installationId, ownerId: carol.public.id });
const enrollment = enrollAgent({
  installationId,
  owner: carol,
  agent: agent.public,
  comparedFingerprint: enrollmentFingerprint({
    installationId,
    owner: carol.public,
    agent: agent.public,
  }),
});
const ownAgent = (drafts: boolean): OwnAgent => ({
  enrollment,
  label: { name: 'Laptop', enrolledAt: '2026-10-05T09:00:00.000Z' },
  shares: [{ spaceId, shareId, drafts }],
});
const writes = () => writesFor((sealer) => sealer.id === alice.public.id);

// Carol's keyring, holding each version as sealed by `sealer`.
const holding = (versions: [number, PrivateIdentity, boolean][], share = shareId) => {
  const keyring = new FolderKeyring();
  for (const [keyVersion, sealer, drafts] of versions) {
    const keys = newFolderKeys();
    keyring.add({
      spaceId,
      shareId: share,
      keyVersion,
      sealer: sealer.public,
      draftKey: drafts ? keys.draftKey : null,
      publishedKey: keys.publishedKey,
    });
  }
  return keyring;
};
const seal = (
  keyring: FolderKeyring,
  missing: { shareId: ShareId; keyVersions: number[] }[],
  { agentEntry = ownAgent(true), revoked = false } = {},
) =>
  sealForAgent({
    person: carol,
    installationId,
    contacts: {
      revokedAgents: revoked
        ? [{ agentId: agent.public.id, revokedAt: '2026-10-05T10:00:00.000Z' }]
        : [],
    },
    agent: agentEntry,
    missing: missing.map((item) => ({ spaceId, ...item })),
    keyring,
    writes,
  });

describe('sealing to a person’s own agents (section 9.4)', () => {
  it('seal the versions the agent lacks, up to the highest that counts for writing', () => {
    const keyring = holding([
      [1, alice, true],
      [2, alice, true],
      [3, bob, true],
    ]);
    const sealed = seal(keyring, [{ shareId, keyVersions: [1, 2, 3, 4] }]);
    expect(sealed.map((e) => e.keyVersion).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(sealed.every((e) => e.sealerId === carol.public.id)).toBe(true);
    expect(sealed.every((e) => e.recipientId === agent.public.id)).toBe(true);
    // The agent opens them, taking keys only from its person.
    const trust = new TrustStore(installationId);
    trust.pinSelf(agent);
    trust.use({ identity: carol.public, name: 'Carol', email: 'carol@example.org', foundBy: null });
    for (const envelope of sealed) {
      const opened = openFolderKeys({
        reader: agent,
        trust,
        installationId,
        envelope,
        expect: { spaceId, shareId },
        sealers: opensFor((who) => who.id === carol.public.id),
      });
      expect(opened.draftKey).not.toBeNull();
    }
  });

  it('never seal a share that isn’t on the agent’s list, whatever the server says is missing', () => {
    const keyring = holding([[1, alice, true]], otherShare);
    expect(seal(keyring, [{ shareId: otherShare, keyVersions: [1] }])).toEqual([]);
  });

  it('take the class from the person’s own record, and the keys they hold', () => {
    const keyring = holding([[1, alice, true]]);
    const [asReader] = seal(keyring, [{ shareId, keyVersions: [1] }], {
      agentEntry: ownAgent(false),
    });
    expect(asReader?.draftKey).toBeNull();
    // A person who is a reader there never seals a draft key they don't hold.
    const [fromReader] = seal(holding([[1, alice, false]]), [{ shareId, keyVersions: [1] }]);
    expect(fromReader?.draftKey).toBeNull();
  });

  it('seal nothing to a revoked agent, or after the person lost access', () => {
    const keyring = holding([[1, alice, true]]);
    expect(seal(keyring, [{ shareId, keyVersions: [1] }], { revoked: true })).toEqual([]);
    expect(seal(new FolderKeyring(), [{ shareId, keyVersions: [1, 2] }])).toEqual([]);
  });
});
