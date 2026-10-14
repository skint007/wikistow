// The Milestone 2 part of the cross-platform vectors (see generate-vectors.ts).
// Each section holds inputs and the outputs another implementation must
// reproduce, plus negative cases where a runtime or library could differ.
import {
  ownerStatementBytes,
  signOwnerStatement,
  canonical,
  folderKeyEnvelopeBytes,
  metadataWrapSubject,
  newFolderKeys,
  sealFolderKeys,
  wrapContentKey,
  enrollAgent,
  fingerprintBytes,
  generateIdentity,
  IdentityId,
  identityRef,
  InstallationId,
  keyCommitment,
  MetadataRevisionId,
  newContactsPayloads,
  newFolderMetadata,
  newPayload,
  PageId,
  RevisionId,
  enrollmentFingerprint,
  sealAttachment,
  sealContacts,
  sealMetadataV2,
  sealRevisionV2,
  ShareId,
  SpaceId,
  toBase64,
  utf8,
  type AttachmentRef,
  type PrivateIdentity,
} from '../src/index.ts';
import { sodium } from '../src/sodium.ts';

const exportIdentity = (identity: PrivateIdentity) => ({
  public: identity.public,
  boxSecretKey: toBase64(identity.boxSecretKey),
  signSecretKey: toBase64(identity.signSecretKey),
});

const hex = (bytes: Uint8Array) => sodium.to_hex(bytes);
const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]));

/**
 * The section's identities and attachment from the current file, kept so a
 * regeneration moves only what changed.
 */
export type M2Previous = {
  author: PrivateIdentity;
  reader: PrivateIdentity;
  agent: PrivateIdentity;
  attachment?: { ref: AttachmentRef; blob: Uint8Array } | undefined;
};

export function m2Vectors(previous?: M2Previous) {
  const installationId = InstallationId.parse('vector-installation');
  const spaceId = SpaceId.parse('vector-space');
  const author =
    previous?.author ??
    generateIdentity({ id: IdentityId.parse('vector-m2-author'), kind: 'human' });
  const reader =
    previous?.reader ??
    generateIdentity({ id: IdentityId.parse('vector-m2-reader'), kind: 'human' });
  const agent =
    previous?.agent ??
    generateIdentity({ kind: 'agent', installationId, ownerId: author.public.id });

  const target = {
    installationId,
    spaceId,
    pageId: PageId.parse('vector-m2-page'),
    revisionId: RevisionId.parse('vector-m2-revision'),
    audience: 'draft' as const,
    basedOn: null,
  };
  const attachment =
    previous?.attachment ??
    sealAttachment({
      target,
      name: 'notes.txt',
      mediaType: 'text/plain',
      bytes: utf8('attachment plaintext'),
    });
  const payload = newPayload({ title: 'M2 page', markdown: 'v2', attachments: [attachment.ref] });
  const revision = sealRevisionV2({
    author,
    target,
    payload,
    recipients: [reader.public],
  });
  const metadata = sealMetadataV2({
    author,
    target: {
      installationId,
      spaceId,
      subjectKind: 'folder',
      subjectId: 'vector-m2-folder',
      metadataRevisionId: MetadataRevisionId.parse('vector-m2-metadata'),
      basedOn: null,
    },
    metadata: newFolderMetadata('Recipes'),
    recipients: [reader.public],
  });

  const keyFor = new Uint8Array(32).fill(7);

  const enrollment = enrollAgent({
    installationId,
    owner: author,
    agent: agent.public,
    comparedFingerprint: enrollmentFingerprint({
      installationId,
      owner: author.public,
      agent: agent.public,
    }),
  });
  const contactsPayloads = newContactsPayloads();
  const contacts = sealContacts({
    owner: author,
    installationId,
    previous: null,
    shared: {
      ...contactsPayloads.shared,
      contacts: [
        {
          identity: { ...reader.public, kind: 'human' },
          verifiedAt: '2026-10-04T12:00:00.000Z',
          method: 'first-seen',
        },
      ],
      agents: [
        {
          enrollment,
          label: { name: 'Laptop', enrolledAt: '2026-10-04T12:00:00.000Z' },
          shares: [{ spaceId, shareId: ShareId.parse('vector-share'), drafts: true }],
        },
      ],
      spaceOwners: [
        {
          spaceId,
          owners: [{ id: author.public.id, keyHash: identityRef(author.public).keyHash }],
          removedOwners: [reader.public.id],
        },
      ],
    },
    private: {
      ...contactsPayloads.private,
      labels: [
        {
          id: reader.public.id,
          keyHash: identityRef(reader.public).keyHash,
          name: 'Rae',
          email: 'rae@example.org',
        },
      ],
    },
  });

  // Folder keys of one share (section 6), with the keys in the clear so
  // another implementation can check each layer on its own.
  const shareId = ShareId.parse('vector-share');
  const folderKeys = newFolderKeys();
  const folderEnvelope = (keyVersion: number, draft: boolean) =>
    sealFolderKeys({
      sealer: author,
      installationId,
      spaceId,
      shareId,
      keyVersion,
      recipient: reader.public,
      keys: { ...folderKeys, draftKey: draft ? folderKeys.draftKey : null },
    });
  const editorEnvelope = folderEnvelope(1, true);
  const readerEnvelope = folderEnvelope(2, false);
  const { signature: _, ...readerUnsigned } = readerEnvelope;
  const wrapSubject = metadataWrapSubject({
    spaceId,
    subjectKind: 'folder',
    subjectId: 'vector-m2-folder',
    metadataRevisionId: MetadataRevisionId.parse('vector-m2-metadata'),
  });
  const wrappedKey = new Uint8Array(32).fill(9);
  const keyWrap = wrapContentKey({
    installationId,
    subject: wrapSubject,
    shareId,
    keyVersion: 2,
    folderKey: folderKeys.publishedKey,
    contentKey: wrappedKey,
  });

  // A draft in the share, wrapped under version 1's draft key.
  const sharedRevision = sealRevisionV2({
    author,
    target: { ...target, revisionId: RevisionId.parse('vector-m2-shared') },
    payload: newPayload({ title: 'Shared page', markdown: 'In a share' }),
    share: { shareId, keyVersion: 1, ...folderKeys },
  });

  // The author adds the reader as a co-owner (section 6.5).
  const ownerStatement = signOwnerStatement({
    signer: author,
    installationId,
    spaceId,
    owner: reader.public,
  });
  const { signature: __, ...statementUnsigned } = ownerStatement;

  // Signature and key edge cases (sections 3.1 and 4.1).
  const ORDER_8 = sodium.from_hex(
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  );
  const seed = sodium.randombytes_buf(32);
  const signer = sodium.crypto_sign_seed_keypair(seed);
  const secretScalar = (() => {
    const h = sodium.crypto_hash_sha512(seed).slice(0, 32);
    h[0] = (h[0] ?? 0) & 248;
    h[31] = ((h[31] ?? 0) & 127) | 64;
    return sodium.crypto_core_ed25519_scalar_reduce(concat(h, new Uint8Array(32)));
  })();
  const message = utf8('vector message');
  const challenge = (R: Uint8Array, A: Uint8Array) =>
    sodium.crypto_core_ed25519_scalar_reduce(sodium.crypto_hash_sha512(concat(R, A, message)));
  const signOver = (r: Uint8Array, R: Uint8Array, A: Uint8Array) =>
    concat(
      R,
      sodium.crypto_core_ed25519_scalar_add(
        r,
        sodium.crypto_core_ed25519_scalar_mul(challenge(R, A), secretScalar),
      ),
    );
  const r = sodium.crypto_core_ed25519_scalar_random();
  const mixedR = sodium.crypto_core_ed25519_add(
    sodium.crypto_scalarmult_ed25519_base_noclamp(r),
    ORDER_8,
  );
  const mixedA = sodium.crypto_core_ed25519_add(signer.publicKey, ORDER_8);
  let mixedASignature: Uint8Array | undefined;
  while (!mixedASignature) {
    const ri = sodium.crypto_core_ed25519_scalar_random();
    const Ri = sodium.crypto_scalarmult_ed25519_base_noclamp(ri);
    if ((challenge(Ri, mixedA)[0] ?? 1) % 8 === 0) mixedASignature = signOver(ri, Ri, mixedA);
  }

  return {
    author: exportIdentity(author),
    reader: exportIdentity(reader),
    agent: exportIdentity(agent),
    keyHashes: {
      author: identityRef(author.public).keyHash,
      agent: identityRef(agent.public).keyHash,
    },
    fingerprints: {
      author: hex(fingerprintBytes(author.public)),
      reader: hex(fingerprintBytes(reader.public)),
    },
    enrollmentFingerprint: enrollmentFingerprint({
      installationId,
      owner: author.public,
      agent: agent.public,
    }),
    keyCommitment: { key: toBase64(keyFor), commitment: keyCommitment(keyFor) },
    revision: { sealed: revision.revision, envelope: revision.envelopes[0], payload },
    metadata: { sealed: metadata.metadata, envelope: metadata.envelopes[0] },
    attachment: {
      target,
      ref: attachment.ref,
      blob: toBase64(attachment.blob),
      plaintext: 'attachment plaintext',
    },
    contacts,
    folderKeys: {
      shareId,
      draftKey: toBase64(folderKeys.draftKey),
      publishedKey: toBase64(folderKeys.publishedKey),
      editorEnvelope,
      readerEnvelope,
      readerSignedBytes: hex(folderKeyEnvelopeBytes(installationId, readerUnsigned)),
    },
    sharedRevision: { sealed: sharedRevision.revision, wrap: sharedRevision.wrap },
    ownerStatement: {
      statement: ownerStatement,
      signedBytes: hex(ownerStatementBytes(statementUnsigned)),
    },
    keyWrap: {
      subject: wrapSubject,
      keyVersion: 2,
      contentKey: toBase64(wrappedKey),
      ad: hex(
        canonical('content-key-wrap/v1', [
          installationId,
          spaceId,
          shareId,
          2,
          wrapSubject.audienceClass,
          wrapSubject.subjectKind,
          wrapSubject.subjectId,
          wrapSubject.versionId,
        ]),
      ),
      wrap: keyWrap,
    },
    signatures: {
      message: toBase64(message),
      publicKey: toBase64(signer.publicKey),
      mixedR: toBase64(signOver(r, mixedR, signer.publicKey)),
      mixedA: { publicKey: toBase64(mixedA), signature: toBase64(mixedASignature) },
      ...signatureEdgeVectors(message),
    },
    // X25519 keys that must be refused, as hex.
    badBoxKeys: {
      topBitSet: hex(
        concat(sodium.crypto_box_keypair().publicKey.slice(0, 31), new Uint8Array([0xff])),
      ),
      p: `ed${'ff'.repeat(30)}7f`,
      pPlus9: `f6${'ff'.repeat(30)}7f`,
      orderEight: 'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
    },
  };
}

// The group order of Ed25519.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const littleEndian = (bytes: Uint8Array) =>
  bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);
const toLittleEndian = (value: bigint) =>
  Uint8Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));

/**
 * The rest of section 3.1's signature cases, each with its own key so they
 * stand alone: an `S` that isn't reduced (`S + L`), a small-order `R`, a
 * small-order key, and a signature that doesn't decode (it is padded).
 * libsodium refuses every one; a cofactored verifier, or one that reduces
 * `S` or accepts padding, would accept some.
 */
export function signatureEdgeVectors(message: Uint8Array) {
  const ORDER_8 = sodium.from_hex(
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  );
  const seed = sodium.randombytes_buf(32);
  const signer = sodium.crypto_sign_seed_keypair(seed);
  const a = (() => {
    const h = sodium.crypto_hash_sha512(seed).slice(0, 32);
    h[0] = (h[0] ?? 0) & 248;
    h[31] = ((h[31] ?? 0) & 127) | 64;
    return sodium.crypto_core_ed25519_scalar_reduce(concat(h, new Uint8Array(32)));
  })();
  const challenge = (R: Uint8Array, A: Uint8Array) =>
    sodium.crypto_core_ed25519_scalar_reduce(sodium.crypto_hash_sha512(concat(R, A, message)));
  const valid = sodium.crypto_sign_detached(message, signer.privateKey);
  const unreduced = concat(valid.slice(0, 32), toLittleEndian(littleEndian(valid.slice(32)) + L));
  // S = k·a: a cofactored check sees 8·S·B = 8·k·A and ignores R entirely.
  const smallR = concat(
    ORDER_8,
    sodium.crypto_core_ed25519_scalar_mul(challenge(ORDER_8, signer.publicKey), a),
  );
  // S = r: with A of order 8, a cofactored check sees 8·S·B = 8·R.
  const r = sodium.crypto_core_ed25519_scalar_random();
  const smallA = concat(sodium.crypto_scalarmult_ed25519_base_noclamp(r), r);
  const publicKey = toBase64(signer.publicKey);
  return {
    unreducedS: { publicKey, signature: toBase64(unreduced) },
    smallOrderR: { publicKey, signature: toBase64(smallR) },
    smallOrderA: { publicKey: toBase64(ORDER_8), signature: toBase64(smallA) },
    padded: { publicKey, signature: `${toBase64(valid)}==` },
  };
}
