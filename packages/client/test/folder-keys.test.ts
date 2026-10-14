import { describe, expect, it } from 'vite-plus/test';
import {
  FolderKeyring,
  generateIdentity,
  IdentityId,
  InstallationId,
  keyCommitment,
  newFolderKeys,
  openFolderKeys,
  revisionWrapSubject,
  sealFolderKeys,
  ShareId,
  SpaceId,
  TrustStore,
  unwrapContentKey,
  wrapContentKey,
  type OpenedFolderKeys,
  type WrapSubject,
} from '../src/index.ts';
import { sodium } from '../src/sodium.ts';
import { opensAnyone } from './support/anyone.ts';
import { directoryEntry } from './support/testing.ts';
import { opensFor } from '../src/owner-predicates.ts';

const installationId = InstallationId.parse('test-installation');
const spaceId = SpaceId.parse('space');
const shareId = ShareId.parse('share');
const owner = generateIdentity({ id: IdentityId.parse('owner'), kind: 'human' });
const editor = generateIdentity({ id: IdentityId.parse('editor'), kind: 'human' });
const reader = generateIdentity({ id: IdentityId.parse('reader'), kind: 'human' });
const isOwner = opensFor((who) => who.id === owner.public.id);

const trustOf = (self: typeof owner) => {
  const trust = new TrustStore(installationId);
  trust.pinSelf(self);
  for (const other of [owner, editor, reader]) {
    if (other !== self) trust.use(directoryEntry(other.public));
  }
  return trust;
};

const keys = newFolderKeys();
const seal = (recipient: typeof owner, draft = true, sealer = owner, keyVersion = 1) =>
  sealFolderKeys({
    sealer,
    installationId,
    spaceId,
    shareId,
    keyVersion,
    recipient: recipient.public,
    keys: { draftKey: draft ? keys.draftKey : null, publishedKey: keys.publishedKey },
  });
const open = (who: typeof owner, envelope: unknown, sealers = isOwner) =>
  openFolderKeys({
    reader: who,
    trust: trustOf(who),
    installationId,
    envelope,
    expect: { spaceId, shareId },
    sealers,
  });
const keyringOf = (...opened: OpenedFolderKeys[]) => {
  const keyring = new FolderKeyring();
  for (const each of opened) keyring.add(each);
  return keyring;
};

const draft: WrapSubject = revisionWrapSubject({
  spaceId,
  audience: 'draft',
  pageId: 'page' as never,
  revisionId: 'revision' as never,
});
const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
const wrapFor = (subject: WrapSubject, folderKey = keys.draftKey, keyVersion = 1) =>
  wrapContentKey({ installationId, subject, shareId, keyVersion, folderKey, contentKey });

describe('key wraps (section 6.3)', () => {
  const editorKeys = keyringOf(open(editor, seal(editor)));
  const unwrap = (subject: WrapSubject, wrap: unknown, keyring = editorKeys) =>
    unwrapContentKey({
      installationId,
      subject,
      wrap,
      keyring,
      commitment: keyCommitment(contentKey),
    });

  it('take the key a real envelope gave when another sealer gave a different one', () => {
    const decoy = { ...newFolderKeys() };
    const decoyEnvelope = sealFolderKeys({
      sealer: owner,
      installationId,
      spaceId,
      shareId,
      keyVersion: 1,
      recipient: editor.public,
      keys: decoy,
    });
    const coOwner = generateIdentity({ id: IdentityId.parse('co-owner'), kind: 'human' });
    const trust = trustOf(editor);
    trust.use(directoryEntry(coOwner.public));
    const realFromCoOwner = openFolderKeys({
      reader: editor,
      trust,
      installationId,
      envelope: seal(editor, true, coOwner),
      expect: { spaceId, shareId },
      sealers: opensAnyone,
    });
    const keyring = keyringOf(open(editor, decoyEnvelope), realFromCoOwner);
    expect(unwrap(draft, wrapFor(draft), keyring)).toEqual(contentKey);
  });
});

describe('the folder keyring', () => {
  const at = (keyVersion: number, recipient = editor, draftKey = true) =>
    open(recipient, seal(recipient, draftKey, owner, keyVersion));

  it('let a later envelope from the same sealer replace an earlier one', () => {
    const keyring = keyringOf(at(1, reader, false));
    expect(keyring.keysFor(spaceId, shareId, 1, 'draft')).toEqual([]);
    keyring.add(at(1, reader, true));
    expect(keyring.keysFor(spaceId, shareId, 1, 'draft')).toEqual([keys.draftKey]);
    expect(keyring.versions(spaceId, shareId)).toHaveLength(1);
  });

  it('never let a replayed reader’s envelope take away a draft key held for its version', () => {
    const keyring = keyringOf(at(1, reader, true));
    const replayed = at(1, reader, false);
    keyring.add(replayed);
    expect(keyring.keysFor(spaceId, shareId, 1, 'draft')).toEqual([keys.draftKey]);
    expect(keyring.keysFor(spaceId, shareId, 1, 'published')).toEqual([keys.publishedKey]);
  });

  it('keep the keys of an envelope added twice', () => {
    const opened = at(1);
    const keyring = keyringOf(opened, opened);
    expect(keyring.keysFor(spaceId, shareId, 1, 'draft')).toEqual([keys.draftKey]);
    expect(keyring.keysFor(spaceId, shareId, 1, 'published')).toEqual([keys.publishedKey]);
  });

  it('wipe every key when the app locks', () => {
    const keyring = keyringOf(at(1));
    keyring.wipe();
    // A load still running when it locked keeps nothing.
    expect(() => keyring.add(at(2))).toThrow(expect.objectContaining({ code: 'missing-key' }));
    expect(keyring.versions(spaceId, shareId)).toEqual([]);
  });
});
