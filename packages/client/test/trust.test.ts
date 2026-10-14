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
  toBase64,
  TrustStore,
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
