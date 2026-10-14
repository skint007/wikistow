// Runs in both Node and Chromium (see the root vite.config.ts), so both
// runtimes must agree on every byte of the protocol.
import { describe, expect, it } from 'vite-plus/test';
import {
  acceptOwners,
  OwnerStatement,
  ownerStatementBytes,
  aeadDecrypt,
  metadataWrapSubject,
  FolderKeyEnvelope,
  folderKeyEnvelopeBytes,
  FolderKeyring,
  KeyWrap,
  openFolderKeys,
  ShareId,
  unwrapContentKey,
  Audience,
  AttachmentRef,
  enrollmentFingerprint,
  fingerprintBytes,
  keyCommitment,
  keyHash,
  openContacts,
  openMetadataV2,
  openRevisionV2,
  parseJson,
  PAYLOAD_INTEGERS,
  requireUsableKeys,
  verifySignature,
  InstallationId,
  PageId,
  RevisionId,
  SpaceId,
  fingerprint,
  fromBase64,
  KeyEnvelope,
  MetadataRecord,
  metadataRecordBytes,
  MetadataRevisionId,
  openMetadata,
  openAttachment,
  openRevision,
  PublicIdentity,
  RevisionRecord,
  revisionRecordBytes,
  SealedRevision,
  sign,
  toBase64,
  TrustStore,
  unlockVault,
  type PrivateIdentity,
} from '../src/index.ts';
import { z } from 'zod';
import { sodium } from '../src/sodium.ts';
import vectors from './vectors.json';
import { opensFor } from '../src/owner-predicates.ts';
import { opensAnyone } from './support/anyone.ts';

const identity = (raw: (typeof vectors)['author']): PrivateIdentity => ({
  public: PublicIdentity.parse(raw.public),
  boxSecretKey: fromBase64(raw.boxSecretKey),
  signSecretKey: fromBase64(raw.signSecretKey),
});

// The directory's listing of a vector identity, looked up by ID and pinned
// as if first seen.
const directoryEntry = (identity: PublicIdentity) => ({
  identity,
  name: identity.id,
  email: `${identity.id}@example.org`,
  foundBy: null,
});

const author = identity(vectors.author);
const reader = identity(vectors.reader);
const revision = SealedRevision.parse(vectors.revision);
const envelope = KeyEnvelope.parse(vectors.envelope);
const expectAt = {
  revisionId: revision.record.revisionId,
  installationId: revision.record.installationId,
  spaceId: revision.record.spaceId,
  pageId: revision.record.pageId,
};

const trust = new TrustStore(revision.record.installationId);
trust.use(directoryEntry(author.public));
trust.use(directoryEntry(reader.public));

const open = (
  overrides: { revision?: SealedRevision; envelope?: KeyEnvelope; expect?: typeof expectAt } = {},
) =>
  openRevision({
    reader: reader,
    trust,
    owners: opensAnyone,
    revision: overrides.revision ?? revision,
    envelopes: [overrides.envelope ?? envelope],
    expect: overrides.expect ?? expectAt,
  });

/** Flip one bit in a base64url field. */
const flip = (field: string, index = 0) => {
  const bytes = fromBase64(field);
  bytes[index] = (bytes[index] ?? 0) ^ 1;
  return toBase64(bytes);
};

const resign = (record: RevisionRecord): SealedRevision => ({
  ...revision,
  record,
  signature: sign(author, revisionRecordBytes(record)),
});

const code = (expected: string) => expect.objectContaining({ code: expected });

describe('test vectors', () => {
  it('decrypt to the expected payload', () => {
    expect(open().opened).toEqual({ kind: 'current', payload: vectors.payload });
  });

  it('reject altered ciphertext at the signed hash', () => {
    const payload = { ...revision.payload, ciphertext: flip(revision.payload.ciphertext, 5) };
    expect(() => open({ revision: { ...revision, payload } })).toThrow(code('hash-mismatch'));
  });

  it('reject altered identifiers, at the request, the signature, and the AEAD binding', () => {
    const moved = { ...revision.record, pageId: RevisionRecord.shape.pageId.parse('another-page') };
    expect(() => open({ revision: { ...revision, record: moved } })).toThrow(
      code('binding-mismatch'),
    );

    const expectMoved = { ...expectAt, pageId: moved.pageId };
    expect(() => open({ revision: { ...revision, record: moved }, expect: expectMoved })).toThrow(
      code('bad-signature'),
    );
    expect(() => open({ revision: resign(moved), expect: expectMoved })).toThrow(
      code('decrypt-failed'),
    );

    const asDraft = resign({ ...revision.record, audience: 'draft' });
    expect(() => open({ revision: asDraft })).toThrow(code('decrypt-failed'));
  });

  it('reject altered signatures on revisions and envelopes', () => {
    expect(() => open({ revision: { ...revision, signature: flip(revision.signature) } })).toThrow(
      code('bad-signature'),
    );
    expect(() => open({ envelope: { ...envelope, signature: flip(envelope.signature) } })).toThrow(
      code('bad-signature'),
    );
  });

  it('open the attachment', () => {
    const ref = AttachmentRef.parse(vectors.attachment.ref);
    const target = RevisionRecord.pick({
      installationId: true,
      spaceId: true,
      pageId: true,
      audience: true,
    }).parse(vectors.attachment.target);
    const blob = fromBase64(vectors.attachment.blob);
    expect(new TextDecoder().decode(openAttachment({ target, ref, blob }))).toBe(
      vectors.attachment.plaintext,
    );
  });

  it('verify the agent enrollment and fingerprint', () => {
    const verifier = new TrustStore(revision.record.installationId);
    verifier.use(directoryEntry(author.public));
    verifier.pinEnrolledAgent(vectors.enrollment);
    expect(fingerprint(PublicIdentity.parse(vectors.enrollment.agent))).toBe(
      vectors.agentFingerprint,
    );
  });

  it('unlock the vault with the passphrase and with the recovery key', () => {
    const { wrapper, passphrase, recoveryKey } = vectors.vault;
    for (const secret of [
      { kind: 'passphrase', passphrase },
      { kind: 'recovery-key', recoveryKey },
    ] as const) {
      expect(unlockVault({ wrapper, secret }).identity.public).toEqual(reader.public);
    }
  });

  it('open folder metadata and reject it under another subject', () => {
    const { sealed, envelope: metaEnvelope } = vectors.metadata;
    const expectFolder = {
      installationId: revision.record.installationId,
      spaceId: revision.record.spaceId,
      subjectKind: 'folder' as const,
      subjectId: 'vector-folder',
      metadataRevisionId: MetadataRevisionId.parse('vector-metadata'),
    };
    const opened = openMetadata({
      reader,
      trust,
      owners: opensAnyone,
      metadata: sealed,
      envelopes: [metaEnvelope],
      expect: expectFolder,
    });
    expect(opened.opened).toMatchObject({
      kind: 'current',
      metadata: {
        name: 'Recipes 🍲',
        emoji: '⭐',
        tint: 'blue',
        extensions: { 'future.ns': { kept: true } },
      },
    });
    const record = MetadataRecord.parse({ ...sealed.record, subjectId: 'another-folder' });
    const moved = { ...sealed, record, signature: sign(author, metadataRecordBytes(record)) };
    expect(() =>
      openMetadata({
        reader,
        trust,
        owners: opensAnyone,
        metadata: moved,
        envelopes: [metaEnvelope],
        expect: { ...expectFolder, subjectId: 'another-folder' },
      }),
    ).toThrow(code('decrypt-failed'));
  });
});

describe('Milestone 2 test vectors', () => {
  const m2 = vectors.m2;
  const m2Author = identity(m2.author);
  const m2Reader = identity(m2.reader);
  const m2Agent = identity(m2.agent);
  const installationId = InstallationId.parse('vector-installation');
  const spaceId = SpaceId.parse('vector-space');
  const space = { installationId, spaceId };
  const m2Trust = new TrustStore(installationId);
  m2Trust.use(directoryEntry(m2Author.public));
  m2Trust.use(directoryEntry(m2Reader.public));
  // The vector's author is the space's one accepted owner.
  const owners = opensFor((who) => who.id === m2Author.public.id);

  it('derive the same key hashes, fingerprints and key commitment', () => {
    expect(keyHash(m2Author.public)).toBe(m2.keyHashes.author);
    expect(keyHash(m2Agent.public)).toBe(m2.keyHashes.agent);
    expect(sodium.to_hex(fingerprintBytes(m2Author.public))).toBe(m2.fingerprints.author);
    expect(keyCommitment(fromBase64(m2.keyCommitment.key))).toBe(m2.keyCommitment.commitment);
  });

  it('derive the same enrollment fingerprint', () => {
    expect(
      enrollmentFingerprint({ installationId, owner: m2Author.public, agent: m2Agent.public }),
    ).toBe(m2.enrollmentFingerprint);
  });

  it('open the v2 revision and its attachment', () => {
    const opened = openRevisionV2({
      reader: m2Reader,
      trust: m2Trust,
      owners,
      revision: m2.revision.sealed,
      envelopes: [m2.revision.envelope],
      expect: {
        installationId,
        spaceId,
        pageId: PageId.parse(m2.attachment.target.pageId),
        revisionId: RevisionId.parse(m2.revision.sealed.record.revisionId),
      },
    });
    expect(opened.opened).toEqual({ kind: 'current', payload: m2.revision.payload });
    // The vector's target is the revision's; an attachment binds only these.
    const { pageId, audience } = m2.attachment.target;
    const target = { ...space, pageId: PageId.parse(pageId), audience: Audience.parse(audience) };
    const plaintext = openAttachment({
      target,
      ref: AttachmentRef.parse(m2.attachment.ref),
      blob: fromBase64(m2.attachment.blob),
    });
    expect(new TextDecoder().decode(plaintext)).toBe(m2.attachment.plaintext);
  });

  it('open the v2 metadata', () => {
    const { record } = m2.metadata.sealed;
    const opened = openMetadataV2({
      reader: m2Reader,
      trust: m2Trust,
      owners,
      metadata: m2.metadata.sealed,
      envelopes: [m2.metadata.envelope],
      expect: {
        installationId,
        spaceId,
        subjectKind: 'folder',
        subjectId: record.subjectId,
        metadataRevisionId: MetadataRevisionId.parse(record.metadataRevisionId),
      },
    });
    expect(opened.opened.kind).toBe('current');
  });

  it('open the contacts record as its owner and as the enrolled agent', () => {
    const asOwner = openContacts({
      reader: m2Author,
      owner: m2Author.public,
      installationId,
      sealed: m2.contacts,
    });
    expect(asOwner.private?.labels[0]?.name).toBe('Rae');
    const asAgent = openContacts({
      reader: m2Agent,
      owner: m2Author.public,
      installationId,
      sealed: m2.contacts,
    });
    expect(asAgent.private).toBeNull();
    expect(asAgent.shared).toEqual(asOwner.shared);
    expect(asAgent.shared.agents[0]?.shares).toEqual([
      { spaceId, shareId: 'vector-share', drafts: true },
    ]);
    expect(asAgent.shared.spaceOwners[0]?.owners[0]?.id).toBe(m2Author.public.id);
  });

  it('open folder key envelopes, signing a reader’s missing draft key as null', () => {
    const { folderKeys } = m2;
    const shareId = ShareId.parse(folderKeys.shareId);
    const openAs = (envelope: unknown) =>
      openFolderKeys({
        reader: m2Reader,
        trust: m2Trust,
        installationId,
        envelope,
        expect: { spaceId, shareId },
        sealers: owners,
      });
    const editor = openAs(folderKeys.editorEnvelope);
    expect(toBase64(editor.draftKey ?? new Uint8Array())).toBe(folderKeys.draftKey);
    expect(toBase64(editor.publishedKey)).toBe(folderKeys.publishedKey);
    const reader = openAs(folderKeys.readerEnvelope);
    expect(reader.draftKey).toBeNull();
    const { signature: _, ...unsigned } = FolderKeyEnvelope.parse(folderKeys.readerEnvelope);
    expect(sodium.to_hex(folderKeyEnvelopeBytes(installationId, unsigned))).toBe(
      folderKeys.readerSignedBytes,
    );
  });

  it('sign an owner statement over the same bytes, and accept the owner it names', () => {
    const statement = OwnerStatement.parse(m2.ownerStatement.statement);
    const { signature, ...unsigned } = statement;
    const bytes = ownerStatementBytes(unsigned);
    expect(sodium.to_hex(bytes)).toBe(m2.ownerStatement.signedBytes);
    expect(verifySignature(m2Author.public, bytes, signature)).toBe(true);
    const accepted = acceptOwners({
      installationId,
      spaceId,
      self: m2Agent.public,
      trust: m2Trust,
      entry: {
        spaceId,
        owners: [{ id: m2Author.public.id, keyHash: keyHash(m2Author.public) }],
        removedOwners: [],
      },
      nameRecords: [],
      statements: [statement],
      envelopes: [],
      listedOwners: [],
      directory: [directoryEntry(m2Reader.public)],
    });
    expect(accepted.opens(m2Reader.public)).toBe(true);
  });

  it('open a v2 draft in a share through its key wrap', () => {
    const { sealed, wrap } = m2.sharedRevision;
    const keyring = new FolderKeyring();
    keyring.add(
      openFolderKeys({
        reader: m2Reader,
        trust: m2Trust,
        installationId,
        envelope: m2.folderKeys.editorEnvelope,
        expect: { spaceId, shareId: ShareId.parse(m2.folderKeys.shareId) },
        sealers: owners,
      }),
    );
    const opened = openRevisionV2({
      reader: m2Reader,
      trust: m2Trust,
      owners,
      revision: sealed,
      wrap,
      keyring,
      expect: {
        installationId,
        spaceId,
        pageId: PageId.parse(sealed.record.pageId),
        revisionId: RevisionId.parse(sealed.record.revisionId),
      },
    });
    expect(opened.region).toEqual({
      kind: 'share',
      spaceId,
      shareId: m2.folderKeys.shareId,
    });
    expect(opened.opened).toMatchObject({ kind: 'current', payload: { title: 'Shared page' } });
  });

  it('unwrap a content key under the wrap’s binding', () => {
    const { keyWrap, folderKeys } = m2;
    const subject = metadataWrapSubject({
      spaceId,
      subjectKind: 'folder',
      subjectId: keyWrap.subject.subjectId,
      metadataRevisionId: MetadataRevisionId.parse(keyWrap.subject.versionId),
    });
    expect(subject).toEqual(keyWrap.subject);
    const ad = sodium.from_hex(keyWrap.ad);
    const wrap = KeyWrap.parse(keyWrap.wrap);
    expect(
      toBase64(
        aeadDecrypt({ key: fromBase64(folderKeys.publishedKey), sealed: wrap.wrappedKey, ad }),
      ),
    ).toBe(keyWrap.contentKey);
    const keyring = new FolderKeyring();
    keyring.add(
      openFolderKeys({
        reader: m2Reader,
        trust: m2Trust,
        installationId,
        envelope: folderKeys.readerEnvelope,
        expect: { spaceId, shareId: wrap.shareId },
        sealers: owners,
      }),
    );
    const contentKey = unwrapContentKey({
      installationId,
      subject,
      wrap,
      keyring,
      commitment: keyCommitment(fromBase64(keyWrap.contentKey)),
    });
    expect(toBase64(contentKey)).toBe(keyWrap.contentKey);
  });

  it('refuse a mixed-order or small-order signing key', () => {
    const key = (signPublicKey: string) => ({ ...m2Author.public, signPublicKey });
    expect(() => requireUsableKeys(key(m2.signatures.mixedA.publicKey))).toThrow(code('bad-key'));
    expect(() => requireUsableKeys(key(m2.signatures.smallOrderA.publicKey))).toThrow(
      code('bad-key'),
    );
  });

  it('refuse a low-order X25519 key', () => {
    const boxPublicKey = toBase64(sodium.from_hex(m2.badBoxKeys.orderEight));
    expect(() => requireUsableKeys({ ...m2Author.public, boxPublicKey })).toThrow(code('bad-key'));
  });

  it('decode text and base64 strictly', () => {
    const payload = (bytes: Uint8Array) => () =>
      parseJson(z.unknown(), bytes, 'Payload', { integers: PAYLOAD_INTEGERS });
    const text = '{"format":{"major":1,"minor":0}}';
    // The ASCII text as UTF-16LE: each byte followed by a zero.
    const utf16le = new Uint8Array(
      Array.from(new TextEncoder().encode(text)).flatMap((byte) => [byte, 0]),
    );
    const escape = (hex4: string) => `\\${'u'}${hex4}`;
    for (const bytes of [
      new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]),
      new Uint8Array([0x7b, 0x22, 0x74, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
      utf16le,
      new TextEncoder().encode(`{"format":{"major":1,"minor":0},"title":"${escape('d800')}"}`),
      new TextEncoder().encode('{"format":{"major":1,"minor":0},"attachments":[{"size":1.0}]}'),
      new TextEncoder().encode('{"format":{"major":1,"minor":0},"format":{"major":1,"minor":0}}'),
    ]) {
      expect(payload(bytes)).toThrow(code('malformed'));
    }
    expect([...fromBase64('AA')]).toEqual([0]);
    expect([...fromBase64('AAA')]).toEqual([0, 0]);
    for (const bad of ['AB', 'AAB', 'AA==', 'A'])
      expect(() => fromBase64(bad)).toThrow(code('malformed'));
  });
});
