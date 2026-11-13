// Opening a live session's record (protocol section 5.10, **Opening the
// record**): the checks that keep a server or a member from putting a
// session under a key a reader or a removed person holds, or under another
// page, share or region.
import { describe, expect, it } from 'vite-plus/test';
import {
  ENDED,
  FolderKeyring,
  generateIdentity,
  newFolderKeys,
  openFolderKeys,
  hash,
  metadataRecordV2Bytes,
  OWNER_REGION,
  ShareId,
} from '../src/index.ts';
import { liveBinding, liveRecordHash, requireLiveAccess } from '../src/live/index.ts';
import {
  alice,
  app,
  bob,
  carol,
  dave,
  draftId,
  folderEnvelope,
  forge,
  inShare,
  installationId,
  mallory,
  open,
  pageId,
  sessionPayload,
  shareId,
  spaceId,
  start,
  toOwners,
  v1,
} from './support/live.ts';
import { opensAnyone } from './support/anyone.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });

describe('a live session in a share', () => {
  it('opens for an editor, under the draft key, as its starter made it', () => {
    const started = start();
    expect(started.wrap).toMatchObject({ shareId, keyVersion: 1 });
    expect(started.envelopes).toEqual([]);
    const opened = open(started, app(bob));
    expect(opened.payload).toMatchObject({ pageId, revisionId: draftId, sealedTo: null });
    expect(opened.payload.joinId).toBe(started.joinId);
    expect(opened.starter).toEqual({
      senderId: carol.public.id,
      senderKeyVersion: carol.public.keyVersion,
      joinId: started.joinId,
    });
    expect(opened.recordHash).toBe(hash(metadataRecordV2Bytes(started.sealed.record)));
    expect(opened.recordHash).toBe(liveRecordHash(opened.record));
    expect(opened.key).toHaveLength(32);
    expect(liveBinding(opened)).toMatchObject({ pageId, sessionId: started.sessionId });
  });

  it('makes everything new for each start', () => {
    const [first, second] = [start(), start()];
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.joinId).not.toBe(first.joinId);
    const bobs = app(bob);
    expect(open(second, bobs).key).not.toEqual(open(first, bobs).key);
    // The key is never in a string the app can't wipe.
    expect(Object.hasOwn(first.payload, 'key')).toBe(false);
    expect(Object.hasOwn(open(first, bobs).payload, 'key')).toBe(false);
    expect(second.sealed.record.metadataRevisionId).not.toBe(
      first.sealed.record.metadataRevisionId,
    );
  });

  it('never opens for a reader, who holds no draft key', () => {
    expect(() => open(start(), app(dave))).toThrow(code('missing-key'));
  });

  it('opens a wrap only as the draft class, whatever the key', () => {
    // A member wraps the session under the published key, for readers.
    const forged = forge({
      payload: sessionPayload(),
      folderKey: v1.publishedKey,
      audienceClass: 'published',
    });
    expect(() => open(forged, app(bob))).toThrow(code('decrypt-failed'));
    expect(() => open(forged, app(dave))).toThrow(code('missing-key'));
  });

  it('refuses key material outside the page’s draft region', () => {
    expect(() => open(start(), app(bob, { region: OWNER_REGION }))).toThrow(
      code('region-mismatch'),
    );
    const elsewhere = { kind: 'share' as const, spaceId, shareId: ShareId.parse('other') };
    expect(() => open(start(), app(bob, { region: elsewhere }))).toThrow(code('region-mismatch'));
    const started = start();
    const both = { ...started, envelopes: [...start(carol, toOwners).envelopes] };
    expect(() => open(both, app(bob), bob.public)).toThrow(code('region-mismatch'));
  });

  it('refuses a session of another page, session or space', () => {
    const other = forge({ payload: sessionPayload({ pageId: 'another-page' }) });
    expect(() => open(other, app(bob))).toThrow(code('binding-mismatch'));
    const started = start();
    expect(() => open({ ...started, sessionId: start().sessionId }, app(bob))).toThrow(
      code('binding-mismatch'),
    );
  });

  it('refuses a share’s session that names owners it was sealed to', () => {
    const forged = forge({ payload: sessionPayload({ sealedTo: [alice.public.id] }) });
    expect(() => open(forged, app(bob))).toThrow(code('binding-mismatch'));
  });

  it('refuses a newer major format, and a payload outside the format', () => {
    const newer = forge({ payload: sessionPayload({ format: { major: 2, minor: 0 } }) });
    expect(() => open(newer, app(bob))).toThrow(code('unsupported-format'));
    const shortKey = forge({ payload: sessionPayload({ key: 'AAAA' }) });
    expect(() => open(shortKey, app(bob))).toThrow(code('malformed'));
  });

  it('says to update for a record protocol it doesn’t know, and refuses a v1 one', () => {
    const started = start();
    const newer = { ...started.sealed, record: { ...started.sealed.record, protocol: 3 } };
    expect(() => open({ ...started, sealed: newer }, app(bob))).toThrow(code('unsupported-format'));
    const v1 = { ...started.sealed, record: { ...started.sealed.record, protocol: 1 } };
    expect(() => open({ ...started, sealed: v1 }, app(bob))).toThrow(code('malformed'));
  });

  it('refuses an altered record or payload', () => {
    const started = start();
    const signature = {
      ...started,
      sealed: { ...started.sealed, signature: start().sealed.signature },
    };
    expect(() => open(signature, app(bob))).toThrow(code('bad-signature'));
    const payload = { ...started, sealed: { ...started.sealed, payload: start().sealed.payload } };
    expect(() => open(payload, app(bob))).toThrow(code('hash-mismatch'));
  });

  it('refuses a record that isn’t a live one, or is based on another', () => {
    const started = start();
    const record = { ...started.sealed.record, basedOn: 'earlier' };
    expect(() => open({ ...started, sealed: { ...started.sealed, record } }, app(bob))).toThrow(
      code('malformed'),
    );
    const comment = { ...started.sealed.record, subjectKind: 'comment' };
    expect(() =>
      open({ ...started, sealed: { ...started.sealed, record: comment } }, app(bob)),
    ).toThrow(code('malformed'));
  });

  it('opens a wrap only with a draft key from an owner who counts for writing', () => {
    // Bob is removed, but the server serves Carol an envelope of version 1
    // he sealed with keys of his own, and a session wrapped under them.
    const fake = newFolderKeys();
    const carols = app(carol, { removedOwners: [bob] });
    carols.hold(bob, fake);
    const forged = forge({ author: bob, payload: sessionPayload(), folderKey: fake.draftKey });
    expect(() => open(forged, carols)).toThrow(code('decrypt-failed'));
    // Holding only his, the version counts for nothing.
    const alone = app(carol, { removedOwners: [bob] });
    alone.access.keyring = new FolderKeyring();
    expect(() => open(forged, alone)).toThrow(code('missing-key'));
    const his = app(carol, { removedOwners: [bob] });
    his.access.keyring = new FolderKeyring();
    his.access.keyring.add(
      openFolderKeys({
        reader: carol,
        trust: his.trust,
        installationId,
        envelope: folderEnvelope(carol.public, { keys: fake, sealer: bob }),
        expect: { spaceId, shareId },
        sealers: opensAnyone,
      }),
    );
    expect(() => open(forged, his)).toThrow(code('key-version'));
  });

  it('leaves once no owner who sealed its key counts for writing', () => {
    // Bob, an owner then, sealed Carol keys of his own for version 1.
    const fake = newFolderKeys();
    const before = app(carol);
    before.hold(bob, fake);
    const forged = forge({ author: bob, payload: sessionPayload(), folderKey: fake.draftKey });
    const opened = open(forged, before);
    expect(opened.wrapSealers.map((s) => s.id)).toEqual([bob.public.id]);
    // Alice's envelope still makes version 1 count, but Bob is removed now.
    const after = app(carol, { removedOwners: [bob] });
    after.hold(bob, fake);
    expect(() => requireLiveAccess(opened, after.access)).toThrow(code('key-version'));
    // Two owners who sealed the same keys: one is enough.
    const both = app(carol);
    both.hold(bob, v1);
    const shared = open(start(), both);
    expect(shared.wrapSealers.map((s) => s.id).sort()).toEqual([alice.public.id, bob.public.id]);
    const sameAfter = app(carol, { removedOwners: [bob] });
    sameAfter.hold(bob, v1);
    expect(() => requireLiveAccess(shared, sameAfter.access)).not.toThrow();
  });

  it('refuses a session whose key version isn’t the newest that counts for writing', () => {
    const bobs = app(bob);
    bobs.rotate();
    expect(() => open(start(), bobs)).toThrow(code('key-version'));
  });

  it('refuses one below the No going back mark, or in a share this app ended', () => {
    const raised = app(bob);
    raised.marks.raise(spaceId, shareId, 2);
    expect(() => open(start(), raised)).toThrow(code('key-version'));
    const ended = app(bob);
    ended.marks.raise(spaceId, shareId, ENDED);
    expect(() => open(start(), ended)).toThrow(code('key-version'));
  });

  it('leaves once the record’s version stops counting, or the draft moves region', () => {
    const bobs = app(bob);
    const opened = open(start(), bobs);
    expect(() => requireLiveAccess(opened, bobs.access)).not.toThrow();
    bobs.rotate();
    expect(() => requireLiveAccess(opened, bobs.access)).toThrow(code('key-version'));
    const carols = app(carol);
    const again = open(start(), carols);
    carols.marks.raise(spaceId, shareId, 3);
    expect(() => requireLiveAccess(again, carols.access)).toThrow(code('key-version'));
    const moved = { ...carols.access, draftRegion: OWNER_REGION };
    expect(() => requireLiveAccess(again, moved)).toThrow(code('region-mismatch'));
  });

  it('refuses a session an agent signed', () => {
    const agent = generateIdentity({ kind: 'agent', installationId, ownerId: carol.public.id });
    const forged = forge({ author: agent, payload: sessionPayload() });
    expect(() => open(forged, app(bob))).toThrow(code('untrusted-sealer'));
  });
});

describe('a live session in the owner region', () => {
  const owners = (self = bob) => app(self, { region: OWNER_REGION });

  it('opens for a co-owner through their own envelope', () => {
    const started = start(alice, toOwners);
    expect(started.wrap).toBeNull();
    expect(started.envelopes.map((e) => e.recipientId)).toEqual([alice.public.id, bob.public.id]);
    const opened = open(started, owners());
    expect(opened.payload.sealedTo).toEqual([alice.public.id, bob.public.id]);
    expect(opened.keyVersion).toBeNull();
  });

  it('refuses one that names no owners, or names someone who isn’t one now', () => {
    const none = forge({ author: alice, payload: sessionPayload(), recipients: [bob.public] });
    expect(() => open(none, owners())).toThrow(code('binding-mismatch'));
    const stranger = forge({
      author: alice,
      payload: sessionPayload({ sealedTo: [alice.public.id, bob.public.id, mallory.public.id] }),
      recipients: [bob.public, mallory.public],
    });
    expect(() => open(stranger, owners())).toThrow(code('unaccepted-owner'));
  });

  it('refuses a session a non-owner started or granted, since anyone can seal to owners', () => {
    const sealedTo = [alice.public.id, bob.public.id];
    const started = forge({
      author: carol,
      payload: sessionPayload({ sealedTo }),
      recipients: [alice.public, bob.public],
      granter: alice,
    });
    expect(() => open(started, owners())).toThrow(code('unaccepted-owner'));
    const granted = forge({
      author: alice,
      payload: sessionPayload({ sealedTo }),
      recipients: [alice.public, bob.public],
      granter: mallory,
    });
    expect(() => open(granted, owners())).toThrow(code('untrusted-sealer'));
  });

  it('leaves once an owner it names is no longer one', () => {
    const bobs = owners();
    const opened = open(start(alice, toOwners), bobs);
    const without = app(bob, { region: OWNER_REGION, listedOwners: [bob] });
    expect(() => requireLiveAccess(opened, bobs.access)).not.toThrow();
    // The server lists Alice no longer; she is no sealing owner now.
    expect(() => requireLiveAccess(opened, without.access)).toThrow(code('unaccepted-owner'));
    // The server lists someone this app doesn't accept.
    const listed = app(bob, { region: OWNER_REGION, listedOwners: [alice, bob, mallory] });
    expect(() => requireLiveAccess(opened, listed.access)).toThrow(code('unaccepted-owner'));
  });

  it('is made only with owners to seal to', () => {
    expect(() => start(alice, { owners: [] })).toThrow(code('unaccepted-owner'));
    expect(() => start(alice, inShare)).not.toThrow();
  });
});
