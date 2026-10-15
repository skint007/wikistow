import { describe, expect, it } from 'vite-plus/test';
import {
  applyContactsChange,
  compareContactsMark,
  contactsHash,
  enrollAgent,
  generateIdentity,
  hash,
  IdentityId,
  InstallationId,
  keyHash,
  newContactsPayloads,
  normalizeSharedContacts,
  openContacts,
  parsePrivateContacts,
  parseSharedContacts,
  pluginApprovals,
  PLUGINS_NAMESPACE,
  requireContactsChain,
  enrollmentFingerprint,
  sealContacts,
  ShareId,
  SpaceId,
  TrustStore,
  utf8,
  type ContactsPayloads,
  type OwnAgent,
  type Pin,
} from '../src/index.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const installationId = InstallationId.parse('test-installation');
const owner = generateIdentity({ id: IdentityId.parse('owner'), kind: 'human' });
const friend = generateIdentity({ id: IdentityId.parse('friend'), kind: 'human' });
const agent = generateIdentity({ kind: 'agent', installationId, ownerId: owner.public.id });
const revoked = generateIdentity({ kind: 'agent', installationId, ownerId: owner.public.id });
const verifiedAt = '2026-10-04T12:00:00.000Z';
const spaceId = SpaceId.parse('space');

const enrollment = (subject: typeof agent) =>
  enrollAgent({
    installationId,
    owner,
    agent: subject.public,
    comparedFingerprint: enrollmentFingerprint({
      installationId,
      owner: owner.public,
      agent: subject.public,
    }),
  });
const ownAgent = (
  subject: typeof agent,
  name: string,
  shares: OwnAgent['shares'] = [],
): OwnAgent => ({
  enrollment: enrollment(subject),
  label: { name, enrolledAt: verifiedAt },
  shares,
});
const asHuman = (identity: typeof friend.public) => ({ ...identity, kind: 'human' as const });
const pin: Pin = { identity: asHuman(friend.public), verifiedAt, method: 'first-seen' };
const friendLabel = {
  id: friend.public.id,
  keyHash: keyHash(friend.public),
  name: 'Fern',
  email: 'fern@example.org',
};

const base = newContactsPayloads();
const payloads: ContactsPayloads = {
  shared: {
    ...base.shared,
    contacts: [pin],
    agents: [ownAgent(agent, 'Laptop'), ownAgent(revoked, 'Old server')],
    revokedAgents: [{ agentId: revoked.public.id, revokedAt: verifiedAt }],
  },
  private: { ...base.private, labels: [friendLabel] },
};
const v1 = sealContacts({ owner, installationId, previous: null, ...payloads });

// What `GET /api/me/contacts?after=n` serves for each later version.
const signedOnly = ({ record, signature }: typeof v1) => ({ record, signature });

const open = (reader = owner, sealed: unknown = v1) =>
  openContacts({ reader, owner: owner.public, installationId, sealed });

describe('the contacts record', () => {
  it('opens both payloads for the owner and only the shared one for an agent', () => {
    expect(open()).toEqual({
      record: v1.record,
      shared: payloads.shared,
      private: payloads.private,
    });
    expect(open(agent)).toEqual({ record: v1.record, shared: payloads.shared, private: null });
  });

  it('seals the shared key to the owner and unrevoked agents only', () => {
    expect(v1.keys.map((key) => key.recipientId)).toEqual([owner.public.id, agent.public.id]);
    expect(() => open(revoked)).toThrow(code('wrong-recipient'));
  });

  it('chains versions by contactsHash', () => {
    const v2 = sealContacts({ owner, installationId, previous: v1.record, ...payloads });
    expect(v2.record).toMatchObject({ version: 2, prevHash: contactsHash(v1.record) });
    const mark = { version: 1, contactsHash: contactsHash(v1.record) };
    expect(compareContactsMark(mark, v1.record)).toBe('same');
    expect(compareContactsMark(mark, v2.record)).toBe('newer');
    expect(
      requireContactsChain({ owner: owner.public, installationId, mark, chain: [signedOnly(v2)] }),
    ).toEqual(v2.record);
  });

  it('keeps unknown members through a read and the next version', () => {
    const withExtras = (payload: object) =>
      utf8(JSON.stringify(payload).replace('{', '{"future":[1],'));
    const shared = parseSharedContacts(withExtras(payloads.shared));
    const privatePayload = parsePrivateContacts(withExtras(payloads.private));
    for (const parsed of [shared, privatePayload]) {
      expect(parsed).toMatchObject({ future: [1] });
    }
    const v2 = sealContacts({
      owner,
      installationId,
      previous: v1.record,
      shared,
      private: privatePayload,
    });
    const opened = open(owner, v2);
    expect(opened.shared).toMatchObject({ future: [1] });
    expect(opened.private).toMatchObject({ future: [1] });
  });
});

describe('contacts payload reading rules (section 8.2)', () => {
  it('let a writer never write a private payload it would read as malformed', () => {
    expect(() =>
      sealContacts({
        owner,
        installationId,
        previous: null,
        shared: payloads.shared,
        private: { ...payloads.private, labels: [{ ...friendLabel, keyHash: 'not a hash' }] },
      }),
    ).toThrow(code('malformed'));
  });

  const readPrivate = (overrides: Record<string, unknown>) =>
    parsePrivateContacts(utf8(JSON.stringify({ ...payloads.private, ...overrides })));
  const share = { spaceId, shareId: ShareId.parse('share'), drafts: true };

  it('let two contacts share a display name', () => {
    const other = { ...friendLabel, id: owner.public.id, email: 'other@example.org' };
    expect(readPrivate({ labels: [friendLabel, other] }).labels).toHaveLength(2);
  });

  it('write every set sorted and once, whatever order it was given in', () => {
    const removedEntry = (byte: number) => ({
      id: friend.public.id,
      keyHash: hash(new Uint8Array([byte])),
      removedAt: verifiedAt,
    });
    const shares = ['c', 'a', 'b', 'a'].map((id) => ({ ...share, shareId: ShareId.parse(id) }));
    const owners = [friendLabel, { id: owner.public.id, keyHash: friendLabel.keyHash }];
    const messy = {
      ...payloads.shared,
      removed: [3, 1, 2, 1].map(removedEntry),
      agents: [ownAgent(agent, 'Laptop', shares)],
      spaceOwners: [
        {
          spaceId,
          owners: [...owners, ...owners],
          removedOwners: [owner.public.id, friend.public.id, owner.public.id],
        },
      ],
    };
    const { shared } = open(
      owner,
      sealContacts({
        owner,
        installationId,
        previous: null,
        shared: messy,
        private: payloads.private,
      }),
    );
    expect(shared).toEqual(normalizeSharedContacts(messy));
    expect(normalizeSharedContacts(shared)).toEqual(shared);
  });
});

describe('merging a pending change into a newer record (section 8.6)', () => {
  const newer: ContactsPayloads = {
    shared: { ...payloads.shared, contacts: [] },
    private: { ...payloads.private, labels: [] },
  };
  const conflictCode = code('contacts-conflict');

  it('adds a pin with its label and drops a removed entry for that key', () => {
    const removedFirst = {
      ...newer,
      shared: {
        ...newer.shared,
        removed: [{ id: friend.public.id, keyHash: friendLabel.keyHash, removedAt: verifiedAt }],
      },
    };
    const merged = applyContactsChange(removedFirst, { kind: 'pin', pin, label: friendLabel });
    expect(merged.shared.contacts).toEqual([pin]);
    expect(merged.shared.removed).toEqual([]);
    expect(merged.private.labels).toEqual([friendLabel]);
    expect(applyContactsChange(merged, { kind: 'pin', pin, label: friendLabel })).toBe(merged);
  });

  it('stops for a pin to other keys', () => {
    const pinned = applyContactsChange(newer, { kind: 'pin', pin, label: friendLabel });
    const otherKeys = {
      ...pin,
      identity: { ...pin.identity, boxPublicKey: owner.public.boxPublicKey },
    };
    expect(() =>
      applyContactsChange(pinned, { kind: 'pin', pin: otherKeys, label: friendLabel }),
    ).toThrow(conflictCode);
  });

  it('enrolls and revokes agents without losing a revocation', () => {
    const extra = generateIdentity({ kind: 'agent', installationId, ownerId: owner.public.id });
    const enrolled = applyContactsChange(newer, {
      kind: 'enroll',
      agent: ownAgent(extra, 'Desktop'),
    });
    expect(enrolled.shared.agents).toHaveLength(3);
    const revoke = {
      kind: 'revoke-agent' as const,
      agentId: revoked.public.id,
      revokedAt: verifiedAt,
    };
    expect(applyContactsChange(newer, revoke)).toBe(newer);
    expect(
      applyContactsChange(newer, { ...revoke, agentId: agent.public.id }).shared.revokedAgents,
    ).toHaveLength(2);
  });

  it('replaces a confirmed key and its label', () => {
    const pinned = applyContactsChange(newer, { kind: 'pin', pin, label: friendLabel });
    const rotated = generateIdentity({ id: friend.public.id, kind: 'human', keyVersion: 2 });
    const confirm = {
      kind: 'confirm-key' as const,
      pin: { identity: asHuman(rotated.public), verifiedAt, method: 'confirmed' as const },
      replaced: friendLabel.keyHash,
    };
    const confirmed = applyContactsChange(pinned, confirm);
    expect(confirmed.shared.contacts).toEqual([confirm.pin]);
    expect(confirmed.private.labels).toEqual([
      { ...friendLabel, keyHash: keyHash(rotated.public) },
    ]);
    // Confirmed on another device already: nothing to do.
    expect(applyContactsChange(confirmed, confirm)).toBe(confirmed);
    expect(() => applyContactsChange(newer, confirm)).toThrow(conflictCode);
  });

  it('lets confirming a key clear a decline of it that lost a race', () => {
    // Device B confirms Fern's new key and writes first. Device A's decline
    // of the same key is re-applied on top, so it is both pinned and removed.
    const pinned = applyContactsChange(newer, { kind: 'pin', pin, label: friendLabel });
    const rotated = generateIdentity({ id: friend.public.id, kind: 'human', keyVersion: 2 });
    const confirmedOnB = applyContactsChange(pinned, {
      kind: 'confirm-key',
      pin: { identity: asHuman(rotated.public), verifiedAt, method: 'confirmed' },
      replaced: friendLabel.keyHash,
    });
    const raced = applyContactsChange(confirmedOnB, {
      kind: 'decline-key',
      id: friend.public.id,
      keyHash: keyHash(rotated.public),
      removedAt: verifiedAt,
    });
    // The person confirms it again, and that holds after a reload.
    const trust = new TrustStore(installationId);
    trust.load(raced);
    expect(trust.check(rotated.public).kind).toBe('removed');
    trust.confirmKey({
      identity: rotated.public,
      name: 'Fern',
      email: friendLabel.email,
      foundBy: null,
    });
    const merged = trust
      .takeChanges()
      .reduce((record, change) => applyContactsChange(record, change), raced);
    const reloaded = new TrustStore(installationId);
    reloaded.load(merged);
    expect(reloaded.check(rotated.public).kind).toBe('pinned');
  });

  it('changes only the agent shares this device touched', () => {
    const share = (id: string, drafts: boolean) => ({
      spaceId,
      shareId: ShareId.parse(id),
      drafts,
    });
    // Another device granted b while this one granted c, made a a reader, and removed d.
    const withShares = {
      ...newer,
      shared: {
        ...newer.shared,
        agents: [ownAgent(agent, 'Laptop', [share('a', true), share('b', true), share('d', true)])],
      },
    };
    const merged = applyContactsChange(withShares, {
      kind: 'agent-shares',
      agentId: agent.public.id,
      set: [share('a', false), share('c', true)],
      unset: [{ spaceId, shareId: ShareId.parse('d') }],
    });
    const shares = merged.shared.agents[0]?.shares ?? [];
    expect(Object.fromEntries(shares.map((s) => [s.shareId, s.drafts]))).toEqual({
      a: false,
      b: true,
      c: true,
    });
    expect(() =>
      applyContactsChange(newer, {
        kind: 'agent-shares',
        agentId: generateIdentity({ kind: 'agent', installationId, ownerId: owner.public.id })
          .public.id,
        set: [share('a', true)],
        unset: [],
      }),
    ).toThrow(conflictCode);
  });

  it('accepts, removes and re-adds owners, with removals a union across devices', () => {
    const fern = { id: friend.public.id, keyHash: friendLabel.keyHash };
    const self = { id: owner.public.id, keyHash: keyHash(owner.public) };
    const entry = (payloads: ContactsPayloads) => payloads.shared.spaceOwners[0];
    const accepted = applyContactsChange(newer, { kind: 'accept-owner', spaceId, owner: fern });
    expect(entry(accepted)).toEqual({ spaceId, owners: [fern], removedOwners: [] });

    const removed = applyContactsChange(accepted, {
      kind: 'remove-owner',
      spaceId,
      ownerId: fern.id,
    });
    // The owners entry stays: opening still uses it.
    expect(entry(removed)).toEqual({ spaceId, owners: [fern], removedOwners: [fern.id] });
    // Accepting again, say by first sight on another device, doesn't undo a removal.
    expect(applyContactsChange(removed, { kind: 'accept-owner', spaceId, owner: fern })).toBe(
      removed,
    );
    // A second device removed someone else: both removals stand.
    const both = applyContactsChange(removed, {
      kind: 'remove-owner',
      spaceId,
      ownerId: self.id,
    });
    expect(entry(both)?.removedOwners).toEqual([fern.id, self.id]);

    // Only this person adding them again takes them off the list.
    const readded = applyContactsChange(both, { kind: 'add-co-owner', spaceId, owner: fern });
    expect(entry(readded)?.removedOwners).toEqual([self.id]);
    expect(entry(readded)?.owners).toEqual([fern]);
  });

  it('merges library plugin approvals per plugin, the last write standing', () => {
    const approval = (id: string, hash: string) => ({
      id,
      hash: hash.repeat(64),
      enabled: true,
      access: [],
    });
    const plugin = (payloads: ContactsPayloads, id: string) =>
      pluginApprovals(payloads.private).find((entry) => entry.id === id);
    // Another device wrote calculator first. A newer app added fields this one can't read.
    const future = { id: 'future', from: 'a newer app' };
    const theirs: ContactsPayloads = {
      ...newer,
      private: {
        ...newer.private,
        extensions: {
          [PLUGINS_NAMESPACE]: {
            plugins: [future, { ...approval('calculator', 'a'), note: 'kept' }],
            order: 'kept',
          },
        },
      },
    };
    // This device approved dusk-theme: both stand.
    const both = applyContactsChange(theirs, {
      kind: 'plugin-approve',
      approval: approval('dusk-theme', 'b'),
    });
    expect(pluginApprovals(both.private).map((entry) => entry.id)).toEqual([
      'calculator',
      'dusk-theme',
    ]);

    // One plugin changed on two devices: each write sets only its own fields.
    const access = [{ spaceId, folderId: null, access: 'read' as const }];
    const off = applyContactsChange(both, {
      kind: 'plugin-change',
      pluginId: 'calculator',
      set: { enabled: false },
    });
    const scoped = applyContactsChange(off, {
      kind: 'plugin-change',
      pluginId: 'calculator',
      set: { access },
    });
    expect(plugin(scoped, 'calculator')).toEqual({
      ...approval('calculator', 'a'),
      enabled: false,
      access,
    });
    // What it can't read is still there.
    expect(scoped.private.extensions[PLUGINS_NAMESPACE]).toEqual({
      plugins: [
        future,
        { ...approval('calculator', 'a'), note: 'kept', enabled: false, access },
        approval('dusk-theme', 'b'),
      ],
      order: 'kept',
    });

    // Removed on another device, it stays removed when this one updates it.
    const removed = applyContactsChange(scoped, { kind: 'plugin-remove', pluginId: 'calculator' });
    expect(plugin(removed, 'calculator')).toBeUndefined();
    const update = { hash: 'c'.repeat(64) };
    expect(
      applyContactsChange(removed, { kind: 'plugin-change', pluginId: 'calculator', set: update }),
    ).toBe(removed);
  });
});
