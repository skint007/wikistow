import { describe, expect, it } from 'vite-plus/test';
import {
  aeadEncrypt,
  FolderKeyring,
  newFolderKeys,
  openFolderKeys,
  revisionWrapSubject,
  sealFolderKeys,
  ShareId,
  wrapContentKey,
  canonical,
  envelopeVersion,
  fromBase64,
  generateIdentity,
  grantRevisionKeyV2,
  hash,
  IdentityId,
  InstallationId,
  keyCommitment,
  keyEnvelopeBytes,
  metadataEnvelopeBytes,
  metadataRecordBytes,
  MetadataRevisionId,
  newFolderMetadata,
  newPayload,
  openMetadata,
  openMetadataV2,
  openRevision,
  openRevisionV2,
  PageId,
  recordProtocol,
  revisionRecordBytes,
  RevisionId,
  sealedBytes,
  sealKeyTo,
  sealMetadataV2,
  sealRevisionV2,
  sign,
  SpaceId,
  TrustStore,
  utf8,
  type KeyEnvelopeV2,
  type PagePayload,
  type SealedRevisionV2,
} from '../src/index.ts';
import { sodium } from '../src/sodium.ts';
import { directoryEntry, sealAsMilestone1 } from './support/testing.ts';
import { opensFor } from '../src/owner-predicates.ts';

const code = (expected: string) => expect.objectContaining({ code: expected });
const installationId = InstallationId.parse('test-installation');
const author = generateIdentity({ id: IdentityId.parse('author'), kind: 'human' });
const reader = generateIdentity({ id: IdentityId.parse('reader'), kind: 'human' });
const owner = generateIdentity({ id: IdentityId.parse('owner'), kind: 'human' });
const trust = new TrustStore(installationId);
for (const person of [author, reader, owner]) trust.use(directoryEntry(person.public));

// The reader's app accepts the space's owner, and the author, as owners.
const accepted = new Set<string>([author.public.id, owner.public.id]);
const owners = opensFor((who) => accepted.has(who.id));
const target = {
  installationId,
  spaceId: SpaceId.parse('space'),
  pageId: PageId.parse('page'),
  revisionId: RevisionId.parse('revision'),
  audience: 'draft' as const,
  basedOn: null,
};
const expectAt = {
  installationId,
  spaceId: target.spaceId,
  pageId: target.pageId,
  revisionId: target.revisionId,
};
const payload = newPayload({ title: 'Plan', markdown: 'v2' });
const sealed = sealRevisionV2({
  author,
  target,
  payload,
  recipients: [reader.public],
});
const [envelope] = sealed.envelopes as [KeyEnvelopeV2];

const open = ({
  revision = sealed.revision,
  envelope: e = envelope as unknown,
}: { revision?: SealedRevisionV2; envelope?: unknown } = {}) =>
  openRevisionV2({ reader, trust, owners, revision, envelopes: [e], expect: expectAt });

// Unseal the content key the way only an author or recipient could.
const contentKey = () =>
  sodium.crypto_box_seal_open(
    fromBase64(envelope.sealedKey),
    fromBase64(reader.public.boxPublicKey),
    reader.boxSecretKey,
  );

describe('v2 revision records', () => {
  it('seal and open, committing to the key', () => {
    expect(open().opened).toEqual({ kind: 'current', payload });
    expect(sealed.revision.record.protocol).toBe(2);
    expect(envelope).toMatchObject({ version: 2, granterId: author.public.id });
    expect(sealed.revision.record.keyCommitment).toBe(keyCommitment(contentKey()));
  });

  it('refuse a key other than the committed one before decrypting', () => {
    // The author seals a different key to this reader and signs it properly.
    const other = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    const swapped = grantRevisionKeyV2({
      granter: author,
      record: sealed.revision.record,
      contentKey: other,
      recipient: reader.public,
    });
    expect(() => open({ envelope: swapped })).toThrow(code('key-commitment'));
  });

  it('accept an envelope another accepted owner granted for existing content', () => {
    const granted = grantRevisionKeyV2({
      granter: owner,
      record: sealed.revision.record,
      contentKey: contentKey(),
      recipient: reader.public,
    });
    expect(open({ envelope: granted }).opened.kind).toBe('current');
  });
});

describe('v1 envelopes from Milestone 2 on', () => {
  it('open history through any of the reader’s envelopes, as an owner added again holds', () => {
    // The author owned the space in Milestone 1, was removed as an owner,
    // and added again: an owner sealed their v1 record to them once more.
    const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    const m1 = sealAsMilestone1(
      { author, target, payload, recipients: [author.public] },
      contentKey,
    );
    const [own] = m1.envelopes;
    if (!own) throw new Error('No envelope');
    const regrant = (granter: typeof owner) =>
      grantRevisionKeyV2({
        granter,
        record: m1.revision.record,
        contentKey,
        recipient: author.public,
      });
    const openWith = (envelopes: unknown[]) =>
      openRevision({
        reader: author,
        trust,
        owners,
        revision: m1.revision,
        envelopes,
        expect: expectAt,
      });
    const atOldKey = { ...own, recipientKeyVersion: 2 };
    for (const envelopes of [
      [own, regrant(owner)],
      [regrant(owner), own],
      [atOldKey, regrant(owner)],
    ]) {
      expect(openWith(envelopes).opened.kind).toBe('current');
    }
  });
});

describe('version selection', () => {
  it('reads an envelope with no version as v1 and version 2 as v2', () => {
    expect(envelopeVersion({ revisionId: 'r' })).toBe(1);
    expect(envelopeVersion(envelope)).toBe(2);
  });

  it('reads records by protocol', () => {
    expect(recordProtocol(sealed.revision, 'Revision')).toBe(2);
    expect(recordProtocol({ record: { protocol: 1 } }, 'Revision')).toBe(1);
  });
});

describe('text written before Milestone 2 (section 3.2)', () => {
  // Milestone 1 writers checked shapes only, so pasted or cut-off text could
  // seal a lone surrogate: `JSON.stringify` writes one as a `\ud800` escape.
  const cutOff = 'Cut off \ud83d';
  const authored = { authorId: author.public.id, authorKeyVersion: author.public.keyVersion };
  const granted = { granterId: author.public.id, granterKeyVersion: author.public.keyVersion };
  const revisionAd = canonical('revision-payload/v1', [
    target.installationId,
    target.spaceId,
    target.pageId,
    target.revisionId,
    target.audience,
    author.public.id,
    author.public.keyVersion,
  ]);

  // A v1 revision sealed as a Milestone 1 client did, with no strict round trip.
  function sealAsBuilt(text: PagePayload) {
    const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    const payload = aeadEncrypt({ key, plaintext: utf8(JSON.stringify(text)), ad: revisionAd });
    const record = {
      protocol: 1 as const,
      ...target,
      ...authored,
      payloadHash: hash(sealedBytes(payload)),
    };
    const unsigned = {
      revisionId: target.revisionId,
      recipientId: reader.public.id,
      recipientKeyVersion: reader.public.keyVersion,
      sealedKey: sealKeyTo(key, reader.public),
      ...granted,
    };
    return {
      key,
      revision: { record, signature: sign(author, revisionRecordBytes(record)), payload },
      envelopes: [{ ...unsigned, signature: sign(author, keyEnvelopeBytes(record, unsigned)) }],
    };
  }

  it('still opens in a v1 revision', () => {
    const m1 = sealAsBuilt(newPayload({ title: cutOff, markdown: 'm' }));
    const { opened } = openRevision({ reader, trust, owners, ...m1, expect: expectAt });
    expect(opened).toMatchObject({ kind: 'current', payload: { title: cutOff } });
  });

  it('is refused when a revision is written', () => {
    const write = {
      author,
      target,
      payload: newPayload({ title: cutOff, markdown: 'm' }),
      recipients: [reader.public],
    };
    expect(() => sealRevisionV2(write)).toThrow(code('malformed'));
  });

  it('still opens in v1 metadata', () => {
    const metadataTarget = {
      installationId,
      spaceId: target.spaceId,
      subjectKind: 'folder' as const,
      subjectId: 'folder',
      metadataRevisionId: MetadataRevisionId.parse('m1-metadata'),
      basedOn: null,
    };
    const { basedOn: _, ...expectFolder } = metadataTarget;
    const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    const payload = aeadEncrypt({
      key,
      plaintext: utf8(JSON.stringify(newFolderMetadata(cutOff))),
      ad: canonical('metadata-payload/v1', [
        installationId,
        metadataTarget.spaceId,
        'folder',
        'folder',
        'm1-metadata',
        author.public.id,
        author.public.keyVersion,
      ]),
    });
    const record = {
      protocol: 1 as const,
      ...metadataTarget,
      ...authored,
      payloadHash: hash(sealedBytes(payload)),
    };
    const unsigned = {
      metadataRevisionId: metadataTarget.metadataRevisionId,
      recipientId: reader.public.id,
      recipientKeyVersion: reader.public.keyVersion,
      sealedKey: sealKeyTo(key, reader.public),
      ...granted,
    };
    const { opened } = openMetadata({
      reader,
      trust,
      owners,
      metadata: { record, signature: sign(author, metadataRecordBytes(record)), payload },
      envelopes: [
        { ...unsigned, signature: sign(author, metadataEnvelopeBytes(record, unsigned)) },
      ],
      expect: expectFolder,
    });
    expect(opened).toMatchObject({ kind: 'current', metadata: { name: cutOff } });
  });
});

describe('records in a share (sections 6.3 and 14.4)', () => {
  const shareId = ShareId.parse('share');
  const folderKeys = newFolderKeys();
  const ownerTrust = new TrustStore(installationId);
  ownerTrust.pinSelf(owner);
  // The share's owner seals one version to an editor (the author) and a reader.
  const keyringFor = (person: typeof reader, drafts: boolean) => {
    const personTrust = new TrustStore(installationId);
    personTrust.pinSelf(person);
    personTrust.use(directoryEntry(owner.public));
    const keyring = new FolderKeyring();
    keyring.add(
      openFolderKeys({
        reader: person,
        trust: personTrust,
        installationId,
        envelope: sealFolderKeys({
          sealer: owner,
          installationId,
          spaceId: target.spaceId,
          shareId,
          keyVersion: 1,
          recipient: person.public,
          keys: { ...folderKeys, draftKey: drafts ? folderKeys.draftKey : null },
        }),
        expect: { spaceId: target.spaceId, shareId },
        sealers: owners,
      }),
    );
    return keyring;
  };
  const editorKeys = keyringFor(author, true);
  const readerKeys = keyringFor(reader, false);
  const [editorHeld] = editorKeys.versions(target.spaceId, shareId);
  const [readerHeld] = readerKeys.versions(target.spaceId, shareId);
  if (!editorHeld || !readerHeld) throw new Error('No keys');

  const draft = sealRevisionV2({ author, target, payload, share: editorHeld });
  const publishedTarget = {
    ...target,
    revisionId: RevisionId.parse('published'),
    audience: 'published' as const,
  };
  const published = sealRevisionV2({ author, target: publishedTarget, payload, share: editorHeld });
  const openAs = (
    who: typeof reader,
    keyring: FolderKeyring,
    sealed: typeof draft,
    revisionId = target.revisionId,
  ) =>
    openRevisionV2({
      reader: who,
      trust,
      owners,
      revision: sealed.revision,
      wrap: sealed.wrap,
      keyring,
      expect: { ...expectAt, revisionId },
    });

  it('wrap a write under the share’s key version, with no envelopes', () => {
    expect(draft.envelopes).toEqual([]);
    expect(draft.wrap).toMatchObject({ shareId, keyVersion: 1 });
    const opened = openAs(author, editorKeys, draft);
    expect(opened.opened).toEqual({ kind: 'current', payload });
    expect(opened.region).toEqual({ kind: 'share', spaceId: target.spaceId, shareId });
  });

  it('open published versions for readers, and drafts only for editors', () => {
    expect(openAs(reader, readerKeys, published, publishedTarget.revisionId).opened.kind).toBe(
      'current',
    );
    expect(() => openAs(reader, readerKeys, draft)).toThrow(code('missing-key'));
    // Nor can a reader write a draft: they hold no draft key to wrap it with.
    expect(() => sealRevisionV2({ author: reader, target, payload, share: readerHeld })).toThrow(
      code('missing-key'),
    );
  });

  it('wrap a name under the published key, so readers can open it', () => {
    const named = sealMetadataV2({
      author,
      target: {
        installationId,
        spaceId: target.spaceId,
        subjectKind: 'folder',
        subjectId: 'folder',
        metadataRevisionId: MetadataRevisionId.parse('shared-name'),
        basedOn: null,
      },
      metadata: newFolderMetadata('Shared'),
      share: editorHeld,
    });
    const openName = (wrap: unknown) =>
      openMetadataV2({
        reader,
        trust,
        owners,
        metadata: named.metadata,
        wrap,
        keyring: readerKeys,
        expect: {
          installationId,
          spaceId: target.spaceId,
          subjectKind: 'folder',
          subjectId: 'folder',
          metadataRevisionId: MetadataRevisionId.parse('shared-name'),
        },
      });
    expect(openName(named.wrap).region).toEqual({
      kind: 'share',
      spaceId: target.spaceId,
      shareId,
    });
  });

  it('open a v1 record through a wrap or a v2 envelope', () => {
    const contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
    // Rewrap a Milestone 1 record's key as making a share would. The test
    // needs the key, so it reseals the record with a known one.
    const resealed = sealAsMilestone1({ author, target, payload, recipients: [] }, contentKey);
    const wrap = wrapContentKey({
      installationId,
      subject: revisionWrapSubject(resealed.revision.record),
      shareId,
      keyVersion: 1,
      folderKey: folderKeys.draftKey,
      contentKey,
    });
    const viaWrap = (accepts: typeof owners) =>
      openRevision({
        reader: author,
        trust,
        owners: accepts,
        revision: resealed.revision,
        wrap,
        keyring: editorKeys,
        expect: expectAt,
      });
    expect(viaWrap(owners).region).toEqual({ kind: 'share', spaceId: target.spaceId, shareId });

    // An owner seals an existing v1 record to a new co-owner in a v2 envelope.
    const granted = grantRevisionKeyV2({
      granter: owner,
      record: resealed.revision.record,
      contentKey,
      recipient: reader.public,
    });
    const viaEnvelope = openRevision({
      reader,
      trust,
      owners,
      revision: resealed.revision,
      envelopes: [granted],
      expect: expectAt,
    });
    expect(viaEnvelope.region).toEqual({ kind: 'owner' });
  });
});
