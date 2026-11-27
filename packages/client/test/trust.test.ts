import { describe, expect, it } from 'vite-plus/test';
import {
  applyContactsChange,
  IdentityId,
  keyHash,
  newContactsPayloads,
  openContacts,
  sealContacts,
  enrollAgent,
  generateIdentity,
  InstallationId,
  enrollmentFingerprint,
  openWithRetired,
  signIdentityRotation,
  toBase64,
  TrustStore,
  verifyRotationChain,
  type PrivateIdentity,
} from '../src/index.ts';
import { buildWorld } from './fixture/world.ts';
import { directoryEntry } from './support/testing.ts';

const changed = expect.objectContaining({ code: 'identity-key-changed' });

describe('substituted keys', () => {
  it('are caught at agent enrollment by the compared fingerprint', () => {
    const { owner, agent, installationId } = buildWorld();
    // The server's own agent keys, under an ID that derives from them.
    const relayedByServer = generateIdentity({
      kind: 'agent',
      installationId,
      ownerId: owner.id,
    }).public;
    expect(() =>
      enrollAgent({
        installationId,
        owner: owner.identity,
        agent: relayedByServer,
        comparedFingerprint: enrollmentFingerprint({
          installationId,
          owner: owner.identity.public,
          agent: agent.identity.public,
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'fingerprint-mismatch' }));
  });
});

describe('first-seen pins and key changes (sections 8.3 and 8.4)', () => {
  const installationId = InstallationId.parse('test-installation');
  const at = new Date('2026-10-05T09:00:00.000Z');
  const self = generateIdentity({ id: IdentityId.parse('self'), kind: 'human' });
  const fern = generateIdentity({ id: IdentityId.parse('fern'), kind: 'human' });
  const gus = generateIdentity({ id: IdentityId.parse('gus'), kind: 'human' });
  const fernEntry = directoryEntry(fern.public, 'Fern');
  const fresh = () => {
    const trust = new TrustStore(installationId, () => at);
    trust.pinSelf(self);
    return trust;
  };
  // The same ID and key version with keys of the server's own.
  const swapped = (person: typeof fern) =>
    generateIdentity({ id: person.public.id, kind: 'human' }).public;

  it('pin a person the first time their key is used, with a label, once', () => {
    const trust = fresh();
    expect(trust.check(fern.public).kind).toBe('unknown');
    expect(trust.use(fernEntry)).toEqual(fern.public);
    expect(trust.check(fern.public).kind).toBe('pinned');
    expect(trust.takeChanges()).toEqual([
      {
        kind: 'pin',
        pin: { identity: fern.public, verifiedAt: at.toISOString(), method: 'first-seen' },
        label: { name: 'Fern', email: 'fern@example.org' },
      },
    ]);
    expect(trust.use(fernEntry)).toEqual(fern.public);
    expect(trust.takeChanges()).toEqual([]);
  });

  it('never pin a refused key', () => {
    const trust = fresh();
    const bad = { ...fern.public, boxPublicKey: toBase64(new Uint8Array(32)) };
    expect(() => trust.use(directoryEntry(bad))).toThrow(
      expect.objectContaining({ code: 'bad-key' }),
    );
  });

  it('store the email the person was found by in its normalized form', () => {
    const trust = fresh();
    trust.use({ ...fernEntry, email: 'Fern@Example.ORG' });
    expect(trust.takeChanges()[0]).toMatchObject({ label: { email: 'fern@example.org' } });
    expect(trust.check(swapped(fern), 'FERN@example.org').kind).toBe('changed');
  });

  it('stop sealing to a key that changed by ID, and pin nobody else in that dialog', () => {
    const trust = fresh();
    trust.use(fernEntry);
    trust.takeChanges();
    const changedFern = directoryEntry(swapped(fern), 'Fern');
    expect(() => trust.recipients([directoryEntry(gus.public, 'Gus'), changedFern])).toThrow(
      changed,
    );
    expect(trust.check(gus.public).kind).toBe('unknown');
    expect(trust.takeChanges()).toEqual([]);
    // A higher key version is a key change too, until confirmed.
    const rotated = generateIdentity({ id: fern.public.id, kind: 'human', keyVersion: 2 });
    expect(() => trust.use(directoryEntry(rotated.public, 'Fern'))).toThrow(changed);
  });

  it('stop sealing to a new identity behind an email already labelled for someone else', () => {
    const trust = fresh();
    trust.use(fernEntry);
    // The server answers Fern's email with an identity of its own.
    const impostor = generateIdentity({ id: IdentityId.parse('impostor'), kind: 'human' });
    expect(trust.check(impostor.public, fernEntry.email)).toEqual({
      kind: 'changed',
      pinned: fern.public,
    });
    expect(() => trust.use({ ...directoryEntry(impostor.public), email: fernEntry.email })).toThrow(
      changed,
    );
  });

  it('replace a pin only when the person confirms the change', () => {
    const trust = fresh();
    trust.use(fernEntry);
    trust.takeChanges();
    const rotated = generateIdentity({ id: fern.public.id, kind: 'human', keyVersion: 2 });
    const rotatedEntry = directoryEntry(rotated.public, 'Fern');
    expect(trust.confirmKey(rotatedEntry)).toEqual(rotated.public);
    expect(trust.use(rotatedEntry)).toEqual(rotated.public);
    expect(trust.require(fern.public.id, 2)).toEqual(rotated.public);
    expect(trust.takeChanges()).toEqual([
      {
        kind: 'confirm-key',
        pin: { identity: rotated.public, verifiedAt: at.toISOString(), method: 'confirmed' },
        replaced: keyHash(fern.public),
      },
    ]);
    // The old key is now the changed one, and the email still names Fern.
    expect(() => trust.use(fernEntry)).toThrow(changed);
    expect(trust.check(rotated.public, fernEntry.email).kind).toBe('pinned');
  });

  it('keep a declined key out, and the old pin in, until it is confirmed', () => {
    const trust = fresh();
    trust.use(fernEntry);
    trust.takeChanges();
    const substitute = swapped(fern);
    trust.declineKey(substitute);
    trust.declineKey(substitute);
    expect(trust.takeChanges()).toEqual([
      {
        kind: 'decline-key',
        id: fern.public.id,
        keyHash: keyHash(substitute),
        removedAt: at.toISOString(),
      },
    ]);
    expect(trust.check(substitute).kind).toBe('removed');
    expect(() => trust.use(directoryEntry(substitute, 'Fern'))).toThrow(changed);
    expect(trust.use(fernEntry)).toEqual(fern.public);
  });

  it('save to the contacts record, and load the same pins, removals and labels from it', () => {
    const trust = fresh();
    trust.use(fernEntry);
    const rotated = generateIdentity({ id: fern.public.id, kind: 'human', keyVersion: 2 });
    trust.declineKey(rotated.public);
    trust.use(directoryEntry(gus.public, 'Gus'));
    const payloads = trust
      .takeChanges()
      .reduce((base, change) => applyContactsChange(base, change), newContactsPayloads());
    const sealed = sealContacts({ owner: self, installationId, previous: null, ...payloads });
    const opened = openContacts({ reader: self, owner: self.public, installationId, sealed });

    const loaded = fresh();
    loaded.load(opened);
    expect(loaded.check(fern.public).kind).toBe('pinned');
    expect(loaded.check(gus.public, 'gus@example.org').kind).toBe('pinned');
    expect(loaded.check(rotated.public).kind).toBe('removed');
    const impostor = generateIdentity({ id: IdentityId.parse('impostor'), kind: 'human' });
    expect(loaded.check(impostor.public, fernEntry.email).kind).toBe('changed');
    expect(loaded.takeChanges()).toEqual([]);
  });
});

describe('earlier keys (section 4.6)', () => {
  const installationId = InstallationId.parse('test-installation');
  const id = IdentityId.parse('rotated');
  const [k1, k2, k3] = [1, 2, 3].map((keyVersion) =>
    generateIdentity({ kind: 'human', id, keyVersion }),
  ) as [PrivateIdentity, PrivateIdentity, PrivateIdentity];
  const contacts = { version: 1, contactsHash: keyHash(k1.public) };
  const s12 = signIdentityRotation({ installationId, from: k1, to: k2, contacts: null });
  const s23 = signIdentityRotation({ installationId, from: k2, to: k3, contacts });
  const chain = (statements: unknown[], start = k1.public, end = k3.public) =>
    verifyRotationChain({ installationId, start, end, statements });
  const unknown = expect.objectContaining({ code: 'unknown-identity' });
  const pinnedAt = (key: PrivateIdentity) => {
    const trust = new TrustStore(installationId);
    trust.use(directoryEntry(key.public));
    return trust;
  };

  it('verify for opening only, from a chain that ends at the pin', () => {
    const trust = pinnedAt(k3);
    expect(() => trust.requireForOpening(id, 1)).toThrow(unknown);
    trust.addEarlierKeys(chain([s12, s23]));
    expect(trust.requireForOpening(id, 1)).toEqual({ identity: k1.public, earlier: true });
    expect(trust.requireForOpening(id, 2)).toEqual({ identity: k2.public, earlier: true });
    expect(trust.requireForOpening(id, 3)).toEqual({ identity: k3.public, earlier: false });
    // Everything else still takes the pin alone.
    expect(() => trust.require(id, 2)).toThrow(unknown);
    expect(trust.require(id, 3)).toEqual(k3.public);
    expect(trust.check(k2.public).kind).toBe('changed');
    expect(() => trust.requireForOpening(id, 4)).toThrow(unknown);
  });

  it('come only from a chain that ends at the pin, through no declined key', () => {
    expect(() => pinnedAt(k2).addEarlierKeys(chain([s12, s23]))).toThrow(changed);
    expect(() => new TrustStore(installationId).addEarlierKeys(chain([s12, s23]))).toThrow(unknown);
    const declined = pinnedAt(k3);
    declined.declineKey(k2.public);
    expect(() => declined.addEarlierKeys(chain([s12, s23]))).toThrow(changed);
    expect(() => declined.requireForOpening(id, 1)).toThrow(unknown);
    expect(() => pinnedAt(k3).addEarlierKeys({ keys: [k1.public, k3.public] } as never)).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    );
    const elsewhere = InstallationId.parse('another-installation');
    const theirs = verifyRotationChain({
      installationId: elsewhere,
      start: k2.public,
      end: k3.public,
      statements: [signIdentityRotation({ installationId: elsewhere, from: k2, to: k3, contacts })],
    });
    expect(() => pinnedAt(k3).addEarlierKeys(theirs)).toThrow(
      expect.objectContaining({ code: 'binding-mismatch' }),
    );
  });

  it('agree across chains, and stop at a key declined later', () => {
    const trust = pinnedAt(k3);
    trust.addEarlierKeys(chain([s23], k2.public));
    trust.addEarlierKeys(chain([s12, s23]));
    expect(trust.requireForOpening(id, 1).identity).toEqual(k1.public);
    trust.declineKey(k1.public);
    expect(() => trust.requireForOpening(id, 1)).toThrow(unknown);
    expect(trust.requireForOpening(id, 2).identity).toEqual(k2.public);
    // A pin declined too, as another device's decline can make it, opens nothing.
    trust.declineKey(k3.public);
    expect(() => trust.requireForOpening(id, 3)).toThrow(unknown);
  });

  it('refuse a second chain to the pin through other keys', () => {
    const trust = pinnedAt(k3);
    trust.addEarlierKeys(chain([s12, s23]));
    // The holder of the current key vouched for another predecessor too.
    const other = generateIdentity({ kind: 'human', id, keyVersion: 2 });
    const other23 = signIdentityRotation({ installationId, from: other, to: k3, contacts });
    expect(() => trust.addEarlierKeys(chain([other23], other.public))).toThrow(changed);
    expect(trust.requireForOpening(id, 2).identity).toEqual(k2.public);
  });

  it('go with the pin they chained to', () => {
    const confirmed = pinnedAt(k3);
    confirmed.addEarlierKeys(chain([s12, s23]));
    const replacement = generateIdentity({ kind: 'human', id, keyVersion: 4 });
    confirmed.confirmKey(directoryEntry(replacement.public));
    expect(() => confirmed.requireForOpening(id, 2)).toThrow(unknown);

    const reloaded = pinnedAt(k3);
    reloaded.addEarlierKeys(chain([s12, s23]));
    reloaded.reload(newContactsPayloads(), [k3.public]);
    expect(() => reloaded.requireForOpening(id, 2)).toThrow(unknown);
  });
});

describe('following a rotation (section 8.4)', () => {
  const installationId = InstallationId.parse('test-installation');
  const id = IdentityId.parse('rotated');
  const [k1, k2] = [1, 2].map((keyVersion) =>
    generateIdentity({ kind: 'human', id, keyVersion }),
  ) as [PrivateIdentity, PrivateIdentity];
  const s12 = signIdentityRotation({ installationId, from: k1, to: k2, contacts: null });
  const chain = verifyRotationChain({
    installationId,
    start: k1.public,
    end: k2.public,
    statements: [s12],
  });
  const pinnedAt = (key: PrivateIdentity) => {
    const trust = new TrustStore(installationId);
    trust.use(directoryEntry(key.public));
    return trust;
  };

  it('makes the follow change without moving the pin, which moves when the record holds it', () => {
    const trust = pinnedAt(k1);
    const [pinned] = trust.takeChanges();
    const change = trust.followChange(chain);
    expect(change).toMatchObject({
      kind: 'follow-key',
      to: { identity: k2.public, method: 'first-seen' },
      chain: [keyHash(k1.public), keyHash(k2.public)],
    });
    expect(trust.check(k2.public).kind).toBe('changed');
    if (!change || pinned?.kind !== 'pin') throw new Error('expected a pin and a follow');
    const payloads = [pinned, change].reduce(applyContactsChange, newContactsPayloads());
    trust.load(payloads);
    trust.addEarlierKeys(chain);
    expect(trust.check(k2.public).kind).toBe('pinned');
    expect(trust.isEarlier(k1.public)).toBe(true);
    expect(trust.requireForOpening(id, 1)).toEqual({ identity: k1.public, earlier: true });
    expect(() => trust.require(id, 1)).toThrow();
  });

  it('refuses a chain from another key, through a removed key, or after a decline', () => {
    expect(() => pinnedAt(k2).followChange(chain)).toThrow(changed);
    const removed = pinnedAt(k1);
    removed.declineKey(k2.public);
    expect(() => removed.followChange(chain)).toThrow(changed);
    const trust = pinnedAt(k1);
    const [pinned] = trust.takeChanges();
    if (pinned?.kind !== 'pin') throw new Error('expected a pin');
    const declined = applyContactsChange(applyContactsChange(newContactsPayloads(), pinned), {
      kind: 'decline-follow',
      from: pinned.pin,
      chain: [keyHash(k2.public)],
      removedAt: '2026-11-27T09:00:00.000Z',
    });
    trust.load(declined);
    expect(() => trust.followChange(chain)).toThrow(changed);
    // The restored pin counts for opening only: nothing is sealed to it.
    expect(trust.check(k1.public).kind).toBe('removed');
    expect(trust.require(id, 1)).toEqual(k1.public);
  });

  it('opens with its own retired keys', () => {
    const now = generateIdentity({ kind: 'human', id, keyVersion: 2 });
    openWithRetired(now, [k1]);
    const trust = new TrustStore(installationId);
    trust.pinSelf(now);
    expect(trust.requireForOpening(id, 1)).toEqual({ identity: k1.public, earlier: true });
    expect(trust.isEarlier(k1.public)).toBe(true);
  });
});
